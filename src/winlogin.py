"""Launch an official CLI login command in a visible interactive console on WinSta0\\Default.

Reads data-only JSON from CLI_AGENT_POOL_LOGIN_ARGV (never executable script text),
removes that transport variable before spawning, invokes CreateProcessW with
lpDesktop="WinSta0\\Default" and CREATE_NEW_CONSOLE, and explicitly brings the
new console window to the foreground on WinSta0\\Default so it never opens hidden
on an off-screen desktop or buried behind a maximized browser window.
"""
import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes

CREATE_NEW_CONSOLE = 0x00000010
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
STARTF_USESHOWWINDOW = 0x00000001
SW_SHOWNORMAL = 1
SW_SHOW = 5
SW_RESTORE = 9
HWND_TOPMOST = ctypes.c_void_p(-1)
HWND_NOTOPMOST = ctypes.c_void_p(-2)
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_SHOWWINDOW = 0x0040
WAIT_OBJECT_0 = 0x00000000


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


def build_command_line(file_path, arguments):
    if not isinstance(file_path, str) or not file_path:
        raise ValueError("missing executable")
    if not isinstance(arguments, list) or not all(isinstance(arg, str) for arg in arguments):
        raise ValueError("invalid arguments")
    all_args = [file_path, *arguments]
    if any(ch in arg for arg in all_args for ch in ("\r", "\n", "\x00")):
        raise ValueError("invalid control character in argument")
    return subprocess.list2cmdline(all_args)


def bring_process_window_to_front(kernel, proc_handle, target_pid, timeout_sec=1.5):
    """Attach to WinSta0\\Default and bring target_pid's visible console/app window to front.

    Returns (focused, exited_nonzero_code). If the process exits quickly with a non-zero
    exit code before any window stays open, exited_nonzero_code carries that exit code.
    """
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.OpenDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    user32.OpenDesktopW.restype = wintypes.HANDLE
    user32.SetThreadDesktop.argtypes = [wintypes.HANDLE]
    user32.SetThreadDesktop.restype = wintypes.BOOL
    user32.CloseDesktop.argtypes = [wintypes.HANDLE]
    user32.CloseDesktop.restype = wintypes.BOOL
    user32.EnumWindows.argtypes = [ctypes.c_void_p, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.AttachThreadInput.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.SetWindowPos.restype = wintypes.BOOL
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL

    desk = None
    try:
        desk = user32.OpenDesktopW("Default", 0, False, 0x000F01FF)
        if not desk:
            desk = user32.OpenDesktopW("Default", 0, False, 0x00C3)
        if desk:
            user32.SetThreadDesktop(desk)
    except Exception:
        desk = None

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    deadline = time.monotonic() + timeout_sec
    found_hwnd = None

    try:
        while time.monotonic() < deadline:
            matched = []

            def callback(hwnd, _lparam):
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if pid.value == target_pid and user32.IsWindowVisible(hwnd):
                    matched.append(hwnd)
                    return False
                return True

            user32.EnumWindows(WNDENUMPROC(callback), 0)
            if matched:
                found_hwnd = matched[0]
                break
            if kernel.WaitForSingleObject(proc_handle, 0) == WAIT_OBJECT_0:
                code = wintypes.DWORD(0)
                if kernel.GetExitCodeProcess(proc_handle, ctypes.byref(code)) and code.value != 0:
                    return False, int(code.value)
                return False, None
            time.sleep(0.05)

        if not found_hwnd:
            return False, None

        fg = user32.GetForegroundWindow()
        unused = wintypes.DWORD()
        fg_tid = user32.GetWindowThreadProcessId(fg, ctypes.byref(unused)) if fg else 0
        cur_tid = kernel.GetCurrentThreadId()
        attached = bool(fg_tid and fg_tid != cur_tid and user32.AttachThreadInput(cur_tid, fg_tid, True))
        try:
            user32.ShowWindow(found_hwnd, SW_RESTORE if user32.IsIconic(found_hwnd) else SW_SHOW)
            user32.SetWindowPos(found_hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            user32.SetWindowPos(found_hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            user32.BringWindowToTop(found_hwnd)
            user32.SetForegroundWindow(found_hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(cur_tid, fg_tid, False)
        return True, None
    except Exception:
        return False, None
    finally:
        if desk:
            try:
                user32.CloseDesktop(desk)
            except Exception:
                pass


def main():
    raw = os.environ.pop("CLI_AGENT_POOL_LOGIN_ARGV", "")
    if not raw:
        sys.stderr.write(json.dumps({"opened": False, "error": "missing_payload"}) + "\n")
        return 1
    try:
        request = json.loads(raw)
        file_path = request.get("file")
        arguments = request.get("arguments", [])
        cmdline = build_command_line(file_path, arguments)
    except Exception as exc:
        sys.stderr.write(json.dumps({"opened": False, "error": str(exc)}) + "\n")
        return 1

    cwd = os.getcwd()
    if not cwd or not os.path.isdir(cwd):
        cwd = os.path.expanduser("~")

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
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
    kernel.GetCurrentThreadId.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL

    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(STARTUPINFOW)
    si.lpDesktop = "WinSta0\\Default"
    si.dwFlags = STARTF_USESHOWWINDOW
    si.wShowWindow = SW_SHOWNORMAL
    pi = PROCESS_INFORMATION()

    base_flags = CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP
    last_error = 0
    opened = False
    for flags in (base_flags | CREATE_BREAKAWAY_FROM_JOB, base_flags):
        buf = ctypes.create_unicode_buffer(cmdline)
        if kernel.CreateProcessW(file_path, buf, None, None, False, flags, None, cwd, ctypes.byref(si), ctypes.byref(pi)):
            opened = True
            break
        last_error = ctypes.get_last_error()

    if not opened:
        sys.stderr.write(json.dumps({"opened": False, "win32Error": last_error}) + "\n")
        return 1

    pid = int(pi.dwProcessId)
    focused, exit_code = bring_process_window_to_front(kernel, pi.hProcess, pid)
    if pi.hThread:
        kernel.CloseHandle(pi.hThread)
    if pi.hProcess:
        kernel.CloseHandle(pi.hProcess)
    if exit_code is not None:
        sys.stderr.write(json.dumps({"opened": False, "pid": pid, "exitCode": exit_code}) + "\n")
        return 1
    sys.stdout.write(json.dumps({"opened": True, "pid": pid, "focused": focused}) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
