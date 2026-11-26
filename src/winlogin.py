"""Launch an official CLI login command in a visible interactive console on WinSta0\\Default.

Reads data-only JSON from CLI_AGENT_POOL_LOGIN_ARGV (never executable script text),
removes that transport variable before spawning, and invokes CreateProcessW with
lpDesktop="WinSta0\\Default" and CREATE_NEW_CONSOLE so the sign-in window is always
visible to the user even when the Pool daemon was started from an off-screen desktop
(e.g. exebox-* or CliAgentPoolBg).
"""
import ctypes
import json
import os
import subprocess
import sys
from ctypes import wintypes

CREATE_NEW_CONSOLE = 0x00000010
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
STARTF_USESHOWWINDOW = 0x00000001
SW_SHOWNORMAL = 1


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
    if pi.hThread:
        kernel.CloseHandle(pi.hThread)
    if pi.hProcess:
        kernel.CloseHandle(pi.hProcess)
    sys.stdout.write(json.dumps({"opened": True, "pid": pid}) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
