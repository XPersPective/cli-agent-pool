using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

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

    [STAThread]
    private static void Main()
    {
        try
        {
            var dialog = (IFileDialog)new NativeFolderDialog();
            try
            {
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x02000000); // Pick folders, filesystem, existing path, no recent-history write.
                dialog.SetTitle("Proje klasörünü seçin");
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
                int result = dialog.Show(IntPtr.Zero);
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
            finally { Marshal.ReleaseComObject(dialog); }
        }
        catch
        {
            Console.Error.WriteLine("Windows folder picker failed.");
            Environment.ExitCode = 1;
        }
    }
}
