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
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise OSError("Job setup failed")
    info = EXTENDED()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        kernel.CloseHandle(job)
        raise OSError("Job setup failed")
    # Join before spawning: descendants inherit the job without a spawn/assignment race.
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        kernel.CloseHandle(job)
        raise OSError("Job assignment failed")
    return job  # Deliberately held until this process exits; never inherited by children.


def hidden_desktop():
    from ctypes import wintypes

    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.CreateDesktopW.argtypes = [
            wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p,
            wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        ]
        user32.CreateDesktopW.restype = wintypes.HANDLE
        user32.CloseDesktop.argtypes = [wintypes.HANDLE]
        user32.CloseDesktop.restype = wintypes.BOOL
        # Off-screen desktop inside the current window station so grandchild console
        # processes spawned without CREATE_NO_WINDOW (e.g. cmd.exe / .bat MCP shims)
        # cannot flash visible terminal windows on the user's interactive desktop.
        name = "CliAgentPoolBg"
        handle = user32.CreateDesktopW(name, None, None, 0, 0x000F01FF, None)
        return (handle, name, user32) if handle else (None, None, None)
    except Exception:
        return (None, None, None)


def spawn_windows_hidden(argv, cwd, desktop_name):
    import msvcrt
    from ctypes import wintypes

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("lpReserved", wintypes.LPWSTR),
            ("lpDesktop", wintypes.LPWSTR),
            ("lpTitle", wintypes.LPWSTR),
            ("dwX", wintypes.DWORD),
            ("dwY", wintypes.DWORD),
            ("dwXSize", wintypes.DWORD),
            ("dwYSize", wintypes.DWORD),
            ("dwXCountChars", wintypes.DWORD),
            ("dwYCountChars", wintypes.DWORD),
            ("dwFillAttribute", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("wShowWindow", wintypes.WORD),
            ("cbReserved2", wintypes.WORD),
            ("lpReserved2", ctypes.c_void_p),
            ("hStdInput", wintypes.HANDLE),
            ("hStdOutput", wintypes.HANDLE),
            ("hStdError", wintypes.HANDLE),
        ]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("hProcess", wintypes.HANDLE),
            ("hThread", wintypes.HANDLE),
            ("dwProcessId", wintypes.DWORD),
            ("dwThreadId", wintypes.DWORD),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.SetHandleInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
    kernel.SetHandleInformation.restype = wintypes.BOOL
    kernel.CreateProcessW.argtypes = [
        wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
        wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
        ctypes.POINTER(STARTUPINFOW), ctypes.POINTER(PROCESS_INFORMATION),
    ]
    kernel.CreateProcessW.restype = wintypes.BOOL
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL

    r_in, w_in = os.pipe()
    os.set_inheritable(r_in, True)
    os.set_inheritable(w_in, False)
    h_in = msvcrt.get_osfhandle(r_in)
    h_out = msvcrt.get_osfhandle(1)
    h_err = msvcrt.get_osfhandle(2)
    kernel.SetHandleInformation(h_in, 1, 1)
    kernel.SetHandleInformation(h_out, 1, 1)
    kernel.SetHandleInformation(h_err, 1, 1)

    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(STARTUPINFOW)
    si.lpDesktop = desktop_name
    si.dwFlags = 0x00000100 | 0x00000001  # STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
    si.wShowWindow = 0  # SW_HIDE
    si.hStdInput = h_in
    si.hStdOutput = h_out
    si.hStdError = h_err

    pi = PROCESS_INFORMATION()
    cmdline = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    ok = kernel.CreateProcessW(None, cmdline, None, None, True, flags, None, cwd, ctypes.byref(si), ctypes.byref(pi))
    os.close(r_in)
    if not ok:
        err = ctypes.get_last_error()
        os.close(w_in)
        raise OSError(err, "CreateProcessW failed")
    kernel.CloseHandle(pi.hThread)
    stdin_file = os.fdopen(w_in, "wb")

    class HiddenChild:
        def __init__(self):
            self.stdin = stdin_file
            self.pid = pi.dwProcessId

        def wait(self):
            kernel.WaitForSingleObject(pi.hProcess, 0xFFFFFFFF)
            code = wintypes.DWORD(1)
            kernel.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
            kernel.CloseHandle(pi.hProcess)
            return code.value

    return HiddenChild()


def main():
    request = json.loads(sys.stdin.buffer.readline())
    job = windows_job() if os.name == "nt" else None
    desktop = (None, None, None)
    child = None
    if os.name == "nt" and request.get("hide", True):
        desktop = hidden_desktop()
        if desktop[1]:
            try:
                child = spawn_windows_hidden(request["argv"], request["cwd"], desktop[1])
            except OSError:
                child = None
                if desktop[0] and desktop[2]:
                    try:
                        desktop[2].CloseDesktop(desktop[0])
                    except Exception:
                        pass
                    desktop = (None, None, None)
    if child is None:
        startupinfo = None
        creationflags = 0
        if os.name == "nt" and request.get("hide", True):
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
        child = subprocess.Popen(request["argv"], cwd=request["cwd"], stdin=subprocess.PIPE,
                                 start_new_session=os.name != "nt", startupinfo=startupinfo,
                                 creationflags=creationflags)
    finished = threading.Event()
    stdin_lock = threading.Lock()

    def cancel():
        if finished.is_set():
            return
        if os.name == "nt":
            os._exit(125)  # Closing the sole job handle kills every descendant.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def watch_parent():
        try:
            if request.get("relay"):
                for line in sys.stdin.buffer:
                    message = json.loads(line)
                    with stdin_lock:
                        try:
                            if message.get("close"):
                                child.stdin.close()
                            else:
                                child.stdin.write(message.get("input", "").encode("utf-8"))
                                child.stdin.flush()
                        except OSError:
                            # Child already closed stdin/exited; let main thread collect its exit code.
                            return
            else:
                sys.stdin.buffer.read()
        finally:
            cancel()

    # Start parent EOF monitor before feeding initial stdin so a large (>4 KB)
    # prompt blocked in child.stdin.write() never blinds cancel/timeout/parent death.
    # Holding stdin_lock until initial write completes preserves ordering in relay mode.
    stdin_lock.acquire()
    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        initial = request.get("input", "")
        if initial:
            child.stdin.write(initial.encode("utf-8"))
            child.stdin.flush()
        if not request.get("relay"):
            child.stdin.close()
    except OSError:
        pass
    finally:
        stdin_lock.release()
    code = child.wait()
    # POSIX: also retire background descendants after the product exits.
    if os.name != "nt":
        cancel()
    finished.set()
    if desktop[0] and desktop[2]:
        try:
            desktop[2].CloseDesktop(desktop[0])
        except Exception:
            pass
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
