"""Own a CLI process tree. Parent EOF cancels it even when the Node host crashes."""
import ctypes
import json
import os
import signal
import subprocess
import sys
import threading


def windows_job():
    from ctypes import wintypes

    class BASIC(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class EXTENDED(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IO),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    info = EXTENDED()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise OSError("Job setup failed")
    # Join before spawning: descendants inherit the job without a spawn/assignment race.
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        raise OSError("Job assignment failed")
    return job  # Deliberately held until this process exits; never inherited by children.


def main():
    request = json.loads(sys.stdin.buffer.readline(2_000_000))
    job = windows_job() if os.name == "nt" else None
    child = subprocess.Popen(request["argv"], cwd=request["cwd"], stdin=subprocess.PIPE,
                             start_new_session=os.name != "nt")
    finished = threading.Event()

    def cancel():
        if finished.is_set():
            return
        if os.name == "nt":
            os._exit(125)  # Closing the sole job handle kills every descendant.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def watch_parent():
        try:
            if request.get("relay"):
                for line in sys.stdin.buffer:
                    message = json.loads(line)
                    if message.get("close"):
                        child.stdin.close()
                    else:
                        child.stdin.write(message.get("input", "").encode("utf-8"))
                        child.stdin.flush()
            else:
                sys.stdin.buffer.read()
        finally:
            cancel()

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        child.stdin.write(request.get("input", "").encode("utf-8"))
        child.stdin.flush()
        if not request.get("relay"):
            child.stdin.close()
    except BrokenPipeError:
        pass
    code = child.wait()
    # POSIX: also retire background descendants after the product exits.
    if os.name != "nt":
        cancel()
    finished.set()
    return code


if __name__ == "__main__":
    try:
        exit_code = main()
    except Exception:
        print("POOL_SUPERVISOR_FAILED", file=sys.stderr)
        exit_code = 126
    # The parent-monitor thread intentionally blocks on stdin. Avoid CPython's
    # buffered-stdin finalizer racing that thread; OS teardown closes the Job handle.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(exit_code if 0 <= exit_code <= 255 else 1)
