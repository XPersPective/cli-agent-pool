"""Reads one generic Windows Credential Manager entry and writes its raw UTF-8 blob to stdout.
The caller keeps the value in memory only; nothing is written to disk.
Runs inside pythonw.exe so no powershell.exe, csc.exe or console window is created."""
import ctypes
import sys
from ctypes import wintypes


class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]


class CREDENTIALW(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


def main():
    if len(sys.argv) != 2 or not sys.argv[1]:
        return 2
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi32.CredReadW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(ctypes.POINTER(CREDENTIALW)),
    ]
    advapi32.CredReadW.restype = wintypes.BOOL
    advapi32.CredFree.argtypes = [ctypes.c_void_p]
    pcred = ctypes.POINTER(CREDENTIALW)()
    if not advapi32.CredReadW(sys.argv[1], 1, 0, ctypes.byref(pcred)):
        return 2
    try:
        size = pcred.contents.CredentialBlobSize
        if size > 0 and pcred.contents.CredentialBlob:
            sys.stdout.buffer.write(ctypes.string_at(pcred.contents.CredentialBlob, size))
            sys.stdout.buffer.flush()
    finally:
        advapi32.CredFree(pcred)
    return 0


if __name__ == "__main__":
    sys.exit(main())
