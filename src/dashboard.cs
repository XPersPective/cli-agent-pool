using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Dashboard {
    delegate bool EnumCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;

    static string Quote(string value) {
        // Windows paths and these fixed browser arguments cannot contain embedded quotes.
        if (value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0) throw new ArgumentException("Invalid launch argument");
        return "\"" + value + new string('\\', value.Length - value.TrimEnd('\\').Length) + "\"";
    }
    static HashSet<uint> ProfileProcesses(string profile) {
        var ids = new HashSet<uint>();
        using (var search = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe' OR Name='chrome.exe'"))
        using (var processes = search.Get()) {
            foreach (ManagementObject process in processes) {
                var command = Convert.ToString(process["CommandLine"]);
                if (command.IndexOf("--user-data-dir=" + profile, StringComparison.OrdinalIgnoreCase) >= 0 || command.IndexOf("--user-data-dir=\"" + profile + "\"", StringComparison.OrdinalIgnoreCase) >= 0)
                    ids.Add(Convert.ToUInt32(process["ProcessId"]));
            }
        }
        return ids;
    }
    static List<IntPtr> Windows(string profile) {
        var ids = ProfileProcesses(profile);
        var windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint pid; GetWindowThreadProcessId(window, out pid);
            if (ids.Contains(pid) && IsWindowVisible(window)) {
                var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
                if (name.ToString() == "Chrome_WidgetWin_1" && GetWindowTextLength(window) > 0) {
                    RECT rect;
                    if (IsIconic(window) || (GetWindowRect(window, out rect) && (rect.Right - rect.Left) >= 120 && (rect.Bottom - rect.Top) >= 120))
                        windows.Add(window);
                }
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }
    static void RetireWindowlessProfile(string profile) {
        var ids = ProfileProcesses(profile);
        if (ids.Count == 0) return;
        foreach (uint pid in ids) {
            try { using (var proc = Process.GetProcessById((int)pid)) { proc.Kill(); proc.WaitForExit(2000); } }
            catch { }
        }
        Thread.Sleep(250);
    }
    static void Activate(List<IntPtr> windows) {
        // Retire duplicate Pool windows only; workers and personal browser profiles are unrelated.
        for (int i=1; i<windows.Count; i++) PostMessage(windows[i], 0x0010, IntPtr.Zero, IntPtr.Zero);
        IntPtr target = windows[0];
        IntPtr fg = GetForegroundWindow();
        uint unused;
        uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out unused) : 0;
        uint curThread = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != curThread && AttachThreadInput(curThread, fgThread, true);
        try {
            ShowWindow(target, IsIconic(target) ? 9 : 5);
            SetWindowPos(target, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetWindowPos(target, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(target);
            SetForegroundWindow(target);
        } finally {
            if (attached) AttachThreadInput(curThread, fgThread, false);
        }
    }
    static string EnsureUrl(string directory, string node, string pool, string ensureCommand) {
        var start = new ProcessStartInfo(node, Quote(pool) + " " + ensureCommand) { UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true, WorkingDirectory=directory };
        start.EnvironmentVariables["CLI_AGENT_POOL_HOME"] = directory;
        start.StandardOutputEncoding = Encoding.UTF8;
        start.StandardErrorEncoding = Encoding.UTF8;
        using (var process = Process.Start(start)) {
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(30000)) { process.Kill(); throw new Exception("Servis yaniti zaman asimina ugradi."); }
            string text = output.Result;
            if (process.ExitCode != 0) {
                try { var failure = new JavaScriptSerializer().Deserialize<Dictionary<string,object>>((text + error.Result).Substring((text + error.Result).IndexOf("{\"error\""))); throw new ApplicationException(Convert.ToString(((Dictionary<string,object>)failure["error"])["message"])); }
                catch (ApplicationException) { throw; }
                catch { File.WriteAllText(Path.Combine(directory,"dashboard-start-error.log"), "Exit: " + process.ExitCode + "\r\n" + error.Result); throw new Exception("Servis baslatilamadi (" + process.ExitCode + "): " + error.Result); }
            }
            int jsonStart = text.IndexOf('{');
            Dictionary<string,object> payload = jsonStart >= 0 ? new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(text.Substring(jsonStart)) : null;
            string dashboard = payload != null && payload.ContainsKey("dashboard") ? Convert.ToString(payload["dashboard"]) : null;
            if (string.IsNullOrWhiteSpace(dashboard)) {
                File.WriteAllText(Path.Combine(directory,"dashboard-start-error.log"), "Exit: 0\r\nStdout: " + text + "\r\nStderr: " + error.Result);
                throw new Exception("Servis pencere baglantisini dondurmedi. Kurulumu (npm run setup) kontrol edin.");
            }
            return dashboard;
        }
    }
    [STAThread] static int Main(string[] args) {
        try {
            if (args.Length != 3 && args.Length != 4) throw new ArgumentException("Invalid dashboard launch arguments");
            bool isRemote = (args.Length == 4 && args[3] == "remote") || args[1] == "--remote-url";
            string appTitle = isRemote ? "CLI Agent Remote" : "CLI Agent Pool";
            // The MSIX host may virtualize LocalAppData. The installed helper's physical
            // parent is the runtime actually containing its config and service capability.
            string directory = Directory.GetParent(Path.GetDirectoryName(Application.ExecutablePath)).FullName;
            string profile = Path.Combine(directory, isRemote ? "remote-browser" : "dashboard-browser");
            string key;
            using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(directory.ToUpperInvariant()))).Replace("-", "");
            using (var mutex = new Mutex(false, (isRemote ? "Local\\CLI-Agent-Remote-UI-" : "Local\\CLI-Agent-Pool-UI-") + key)) {
                bool owned;
                try { owned=mutex.WaitOne(45000); } catch (AbandonedMutexException) { owned=true; }
                if (!owned) throw new Exception("Pencere acilisi halen devam ediyor. Biraz sonra yeniden deneyin.");
                try {
                    // A user may have stopped the service while leaving this browser window open.
                    // Every normal shortcut invocation must repair service state before focusing it.
                    string url = (args[1] == "--url" || args[1] == "--remote-url")
                        ? args[2]
                        : EnsureUrl(directory, args[1], args[2], isRemote ? "remote-ensure" : "ensure");
                    var windows = Windows(profile);
                    if (windows.Count > 0) { Activate(windows); return 0; }
                    RetireWindowlessProfile(profile);
                    var uri = new Uri(url);
                    if (uri.Scheme != "http" || uri.Host != "127.0.0.1") throw new Exception("Invalid local dashboard URL");
                    string browser = null;
                    foreach (string candidate in new [] {
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe") }) if (File.Exists(candidate)) { browser=candidate; break; }
                    if (browser == null) throw new Exception("Microsoft Edge veya Google Chrome bulunamadi.");
                    var start = new ProcessStartInfo(browser, Quote("--app="+url) + " --new-window " + Quote("--user-data-dir="+profile) + " --no-first-run --no-default-browser-check --disable-background-mode --no-service-autorun") { UseShellExecute=false, WindowStyle=ProcessWindowStyle.Normal };
                    using (var process = Process.Start(start)) { }
                    for (int i=0; i<100; i++) {
                        Thread.Sleep(200); windows=Windows(profile);
                        if (windows.Count>0) { Activate(windows); return 0; }
                    }
                    throw new Exception("Tarayici baslatildi fakat pencere olusmadi.");
                } finally { mutex.ReleaseMutex(); }
            }
        } catch (Exception error) {
            if (args.Length>1 && (args[1]=="--url" || args[1]=="--remote-url")) Console.Error.WriteLine(error.Message);
            else MessageBox.Show(error.Message, "CLI Agent Pool", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
