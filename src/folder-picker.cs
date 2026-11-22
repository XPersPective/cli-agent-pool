using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
internal class NativeFolderDialog { }

[ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileDialog
{
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr types);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetResult(out IShellItem item);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem
{
    void BindToHandler(IntPtr bind, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint kind, out IntPtr name);
}

internal static class FolderPicker
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string path, IntPtr bind, ref Guid iid, out IShellItem item);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder buf, int len, out int needed);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string app, StringBuilder cmdLine, IntPtr procAttr, IntPtr threadAttr, bool inheritHandles, uint creationFlags, IntPtr env, string currentDir, ref STARTUPINFOW si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOW
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId;
    }

    private static string CurrentDesktopName()
    {
        try
        {
            IntPtr h = GetThreadDesktop(GetCurrentThreadId());
            var sb = new StringBuilder(256);
            int needed;
            if (h != IntPtr.Zero && GetUserObjectInformationW(h, 2, sb, sb.Capacity * 2, out needed)) return sb.ToString();
        }
        catch { }
        return "";
    }

    private static bool TryReexecOnDefaultDesktop(out int exitCode)
    {
        exitCode = 0;
        if (Environment.GetEnvironmentVariable("CLI_AGENT_POOL_PICKER_REEXEC") == "1") return false;
        string current = CurrentDesktopName();
        if (string.IsNullOrEmpty(current) || string.Equals(current, "Default", StringComparison.OrdinalIgnoreCase)) return false;
        try
        {
            Environment.SetEnvironmentVariable("CLI_AGENT_POOL_PICKER_REEXEC", "1");
            var si = new STARTUPINFOW();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
            si.lpDesktop = "WinSta0\\Default";
            PROCESS_INFORMATION pi;
            var cmd = new StringBuilder("\"" + Application.ExecutablePath + "\"");
            if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref si, out pi)) return false;
            try
            {
                WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
                uint code;
                exitCode = GetExitCodeProcess(pi.hProcess, out code) ? (int)code : 1;
                return true;
            }
            finally
            {
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            }
        }
        catch { return false; }
    }

    [STAThread]
    private static void Main()
    {
        int reexecCode;
        if (TryReexecOnDefaultDesktop(out reexecCode))
        {
            Environment.ExitCode = reexecCode;
            return;
        }
        try
        {
            var dialog = (IFileDialog)new NativeFolderDialog();
            try
            {
                using (var owner = new Form { TopMost = true, Opacity = 0.01, ShowInTaskbar = true, StartPosition = FormStartPosition.CenterScreen, Width = 1, Height = 1, FormBorderStyle = FormBorderStyle.None, Text = "Klasör Seç" })
                {
                    owner.Show();
                IntPtr fg = GetForegroundWindow();
                uint unused;
                uint fgTid = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out unused) : 0;
                uint curTid = GetCurrentThreadId();
                bool attached = fgTid != 0 && fgTid != curTid && AttachThreadInput(curTid, fgTid, true);
                try
                {
                    SetWindowPos(owner.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
                    BringWindowToTop(owner.Handle);
                    owner.Activate();
                    SetForegroundWindow(owner.Handle);
                }
                finally
                {
                    if (attached) AttachThreadInput(curTid, fgTid, false);
                }
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x02000000); // Pick folders, filesystem, existing path, no recent-history write.
                dialog.SetTitle("Proje veya disk klasörünü seçin");
                dialog.SetOkButtonLabel("Klasörü seç");
                var initial = Environment.GetEnvironmentVariable("CLI_AGENT_POOL_PICKER_START");
                if (!String.IsNullOrEmpty(initial) && Directory.Exists(initial))
                {
                    IShellItem start;
                    var iid = typeof(IShellItem).GUID;
                    SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out start);
                    try { dialog.SetFolder(start); } finally { Marshal.ReleaseComObject(start); }
                }
                string selected = null;
                int result = dialog.Show(owner.Handle);
                if (result == 0)
                {
                    IShellItem item;
                    dialog.GetResult(out item);
                    try
                    {
                        IntPtr name;
                        item.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
                        try { selected = Marshal.PtrToStringUni(name); } finally { Marshal.FreeCoTaskMem(name); }
                    }
                    finally { Marshal.ReleaseComObject(item); }
                }
                else if (result != unchecked((int)0x800704C7)) Marshal.ThrowExceptionForHR(result);
                    using (var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
                        output.WriteLine(new JavaScriptSerializer().Serialize(new { path = selected }));
                }
            }
            finally { Marshal.ReleaseComObject(dialog); }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Windows folder picker failed: " + ex.Message);
            Environment.ExitCode = 1;
        }
    }
}
