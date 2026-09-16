using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace BosomFriendInstaller
{
    internal static class Program
    {
        private const string Magic = "BFPAYLD1";
        private const string ProductVersion = "0.13.9";
        internal static readonly string BootstrapPath = Path.Combine(Path.GetTempPath(), "BosomFriend-install.log");

        internal static void BootstrapLog(string message)
        {
            try
            {
                lock (BootstrapPath)
                {
                    File.AppendAllText(BootstrapPath,
                        DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine,
                        new UTF8Encoding(false));
                }
            }
            catch { }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            BootstrapLog("=== BosomFriend installer start ===");
            BootstrapLog("args=" + string.Join(" ", args));
            bool silent = false;
            bool launch = false;
            bool testMode = false;
            string customDir = null;
            foreach (string arg in args)
            {
                string lower = arg.ToLowerInvariant();
                if (lower == "/silent") silent = true;
                else if (lower == "/nolaunch") launch = false;
                else if (lower == "/test") testMode = true;
                else if (lower.StartsWith("/dir=", StringComparison.Ordinal))
                    customDir = arg.Substring("/dir=".Length).Trim('"');
                else if (lower == "/uninstall")
                    return Uninstall();
            }

            if (silent)
            {
                return RunSilent(customDir, launch, testMode);
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new InstallerForm(customDir, launch))
            {
                Application.Run(form);
                return form.Success ? 0 : 1;
            }
        }

        private static int RunSilent(string customDir, bool launch, bool testMode)
        {
            string dir = ResolveInstallDir(customDir);
            string log = Path.Combine(dir, "install.log");
            try
            {
                Directory.CreateDirectory(dir);
                using (var writer = new StreamWriter(log, false, new UTF8Encoding(false)))
                {
                    Log(writer, "Install start: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
                    if (!InstallTo(dir, null, writer, testMode))
                        return 1;
                }
                if (launch)
                    LaunchApp(dir);
                return 0;
            }
            catch (Exception ex)
            {
                try { File.AppendAllText(log, "FATAL: " + ex + Environment.NewLine); }
                catch { }
                return 1;
            }
        }

        private static int Uninstall()
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "BosomFriend");
            try
            {
                StopApp(dir);
                DeleteShortcuts();
                DeleteRegistry();
                Thread.Sleep(500);
                if (Directory.Exists(dir))
                    Directory.Delete(dir, true);
            }
            catch { }
            return 0;
        }

        internal static string ResolveInstallDir(string customDir)
        {
            if (!string.IsNullOrEmpty(customDir))
                return Path.GetFullPath(customDir);
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "BosomFriend");
        }

        internal static void Log(TextWriter writer, string message)
        {
            try
            {
                writer.WriteLine(message);
                writer.Flush();
            }
            catch { }
        }

        internal static bool InstallTo(string dir, IProgress reporter, TextWriter writer, bool testMode)
        {
            Log(writer, "Target: " + dir);
            Directory.CreateDirectory(dir);
            if (Directory.Exists(Path.Combine(dir, "runtime")) && !IsEmptyDir(dir))
            {
                Log(writer, "Existing install found, stopping Bosom Friend and removing");
                StopRunningBosomFriend(dir);
                Thread.Sleep(1500);
                CleanDir(dir);
            }

            string self = Assembly.GetExecutingAssembly().Location;
            long zipLen = 0;
            long zipOffset = 0;
            using (var fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (fs.Length < 16)
                    throw new InvalidDataException("No payload footer");
                fs.Seek(-16, SeekOrigin.End);
                byte[] footer = new byte[16];
                fs.Read(footer, 0, 16);
                string magic = Encoding.ASCII.GetString(footer, 0, 8);
                if (magic != Magic)
                    throw new InvalidDataException("Payload footer mismatch");
                zipLen = BitConverter.ToInt64(footer, 8);
                zipOffset = fs.Length - 16 - zipLen;
                if (zipOffset < 0)
                    throw new InvalidDataException("Payload offset invalid");
            }
            Log(writer, "Payload zip bytes: " + zipLen);

            long total = 0;
            using (var fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                fs.Seek(zipOffset, SeekOrigin.Begin);
                using (var bounded = new BoundedStream(fs, zipOffset, zipLen, true))
                using (var archive = new ZipArchive(bounded, ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                        total += entry.Length;

                    long done = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string target = Path.Combine(dir, entry.FullName);
                        if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal))
                        {
                            Directory.CreateDirectory(target);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (Stream input = entry.Open())
                        using (var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            input.CopyTo(output);
                        }
                        done += entry.Length;
                        if (reporter != null)
                            reporter.Report((int)(done * 100 / Math.Max(1, total)), "解压文件 " + entry.FullName);
                        Log(writer, "X " + entry.FullName);
                    }
                }
            }

            if (reporter != null)
                reporter.Report(55, "修复 Python 引擎路径...");
            RewritePyvenv(dir);

            if (reporter != null)
                reporter.Report(60, "安装依赖（首次需要联网，约 3-10 分钟）...");
            if (!RunProcess(Path.Combine(dir, "runtime", "node", "node.exe"),
                    "runtime\\pnpm\\pnpm.cjs install --ignore-scripts", dir, writer))
            {
                Log(writer, "pnpm install failed");
                return false;
            }

            if (reporter != null)
                reporter.Report(92, "生成插件链接...");
            if (!RunProcess(Path.Combine(dir, "runtime", "node", "node.exe"),
                    "products\\bosom-friend\\launcher\\scripts\\setup-fallback.mjs", dir, writer))
            {
                Log(writer, "setup-fallback failed");
                return false;
            }

            WriteVbs(dir);
            if (!testMode)
            {
                CreateShortcuts(dir);
                WriteRegistry(dir);
            }
            Log(writer, "Install complete");
            return true;
        }

        private static bool IsEmptyDir(string dir)
        {
            try
            {
                return Directory.GetFileSystemEntries(dir).Length == 0;
            }
            catch
            {
                return false;
            }
        }

        private static void StopRunningBosomFriend(string dir)
        {
            try
            {
                string ps = "-NoProfile -Command \"$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*" + dir + "*' -or $_.ExecutablePath -like '*BosomFriend*') -and $_.Name -in @('node.exe','pythonw.exe','python.exe','chrome.exe','electron.exe','BosomFriendDesktop.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"";
                Process p = Process.Start(new ProcessStartInfo("powershell", ps)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetTempPath(),
                });
                if (p != null)
                    p.WaitForExit(15000);
            }
            catch { }
        }

        private static void CleanDir(string dir)
        {
            foreach (string entry in Directory.GetFileSystemEntries(dir))
            {
                try
                {
                    if (Directory.Exists(entry))
                        Directory.Delete(entry, true);
                    else
                        File.Delete(entry);
                }
                catch { }
            }
        }

        private static void RewritePyvenv(string dir)
        {
            string cfg = Path.Combine(dir, "engine", ".venv", "pyvenv.cfg");
            if (!File.Exists(cfg))
                return;
            string pythonDir = Path.Combine(dir, "runtime", "python");
            List<string> lines = new List<string>(File.ReadAllLines(cfg));
            for (int i = 0; i < lines.Count; i++)
            {
                if (lines[i].StartsWith("home = ", StringComparison.Ordinal))
                    lines[i] = "home = " + pythonDir;
                else if (lines[i].StartsWith("executable = ", StringComparison.Ordinal))
                    lines[i] = "executable = " + Path.Combine(pythonDir, "python.exe");
                else if (lines[i].StartsWith("command = ", StringComparison.Ordinal))
                    lines[i] = "command = " + Path.Combine(pythonDir, "python.exe") + " -m venv";
            }
            File.WriteAllLines(cfg, lines.ToArray(), new UTF8Encoding(false));
        }

        private static bool RunProcess(string exe, string args, string cwd, TextWriter writer)
        {
            Log(writer, "RUN " + exe + " " + args);
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = args,
                WorkingDirectory = cwd,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            using (Process proc = Process.Start(psi))
            {
                proc.OutputDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log(writer, e.Data); };
                proc.ErrorDataReceived += (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log(writer, "ERR " + e.Data); };
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                if (!proc.WaitForExit(20 * 60 * 1000))
                {
                    try { proc.Kill(); } catch { }
                    Log(writer, "process timeout");
                    return false;
                }
                Log(writer, "exit=" + proc.ExitCode);
                return proc.ExitCode == 0;
            }
        }

        private static void WriteVbs(string dir)
        {
            string desktopExe = Path.Combine(dir, "runtime", "electron", "BosomFriendDesktop.exe");
            string startVbs = Path.Combine(dir, "启动BosomFriend.vbs");
            string stopVbs = Path.Combine(dir, "Stop-BosomFriend.vbs");
            string uninstallVbs = Path.Combine(dir, "Uninstall-BosomFriend.vbs");
            string stopPs1 = Path.Combine(dir, "Stop-BosomFriend.ps1");
            Encoding enc = Encoding.Default;
            File.WriteAllText(startVbs,
                "Set sh = CreateObject(\"WScript.Shell\")\r\n" +
                "sh.CurrentDirectory = \"" + dir + "\"\r\n" +
                "sh.Run \"\"\"" + desktopExe + "\"\"\", 1, False\r\n", enc);
            File.WriteAllText(stopPs1,
                "$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue\r\n" +
                "if ($c) { Stop-Process -Id $c.OwningProcess -Force }\r\n" +
                "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine.Contains('" + dir + "') -and $_.Name -in @('pythonw.exe','node.exe','chrome.exe','BosomFriendDesktop.exe','electron.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\r\n", new UTF8Encoding(false));
            File.WriteAllText(stopVbs,
                "Set sh = CreateObject(\"WScript.Shell\")\r\n" +
                "sh.CurrentDirectory = \"" + dir + "\"\r\n" +
                "sh.Run \"powershell -NoProfile -ExecutionPolicy Bypass -File \"\"" + stopPs1 + "\"\"\", 0, True\r\n", enc);
            File.WriteAllText(uninstallVbs,
                "Set sh = CreateObject(\"WScript.Shell\")\r\n" +
                "Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n" +
                "sh.Run \"powershell -NoProfile -ExecutionPolicy Bypass -File \"\"" + stopPs1 + "\"\"\", 0, True\r\n" +
                "desktop = sh.SpecialFolders(\"Desktop\")\r\n" +
                "startmenu = sh.SpecialFolders(\"StartMenu\") & \"\\Programs\"\r\n" +
                "For Each f In Array(desktop & \"\\Bosom Friend.lnk\", startmenu & \"\\Bosom Friend.lnk\", desktop & \"\\Stop Bosom Friend.lnk\", startmenu & \"\\Stop Bosom Friend.lnk\")\r\n" +
                "  If fso.FileExists(f) Then fso.DeleteFile f, True\r\n" +
                "Next\r\n" +
                "If fso.FolderExists(startmenu) Then fso.DeleteFolder startmenu, True\r\n" +
                "sh.RegDelete \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BosomFriend\\\"\r\n" +
                "sh.Run \"cmd /c cd /d \"\"%TEMP%\"\" && rmdir /s /q \"\"" + dir + "\"\"\", 0, True\r\n", enc);
        }

        private static void CreateShortcuts(string dir)
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string startMenu = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Bosom Friend");
            Directory.CreateDirectory(startMenu);
            string appExe = Path.Combine(dir, "runtime", "electron", "BosomFriendDesktop.exe");
            string appIcon = Path.Combine(dir, "bosom-friend.ico");
            CreateShortcut(Path.Combine(desktop, "Bosom Friend.lnk"), appExe,
                "", dir, appIcon);
            CreateShortcut(Path.Combine(startMenu, "Bosom Friend.lnk"), appExe,
                "", dir, appIcon);
            // 关窗口即停服务，桌面只保留一个启动入口，避免重复快捷方式造成困惑。
        }

        private static void CreateShortcut(string lnkPath, string target, string args, string workDir, string icon)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(lnkPath);
                shortcut.TargetPath = target;
                shortcut.Arguments = args;
                shortcut.WorkingDirectory = workDir;
                shortcut.IconLocation = icon + ",0";
                shortcut.Description = "Bosom Friend";
                shortcut.Save();
            }
            catch (Exception ex)
            {
                try { File.AppendAllText(Path.Combine(workDir, "install.log"), "SHORTCUT FAIL " + ex + Environment.NewLine); }
                catch { }
            }
        }

        private static void WriteRegistry(string dir)
        {
            try
            {
                using (Microsoft.Win32.RegistryKey key =
                    Microsoft.Win32.Registry.CurrentUser.CreateSubKey(
                        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BosomFriend"))
                {
                    if (key == null)
                        return;
                    key.SetValue("DisplayName", "Bosom Friend AI 内容营销系统");
                    key.SetValue("DisplayVersion", ProductVersion);
                    key.SetValue("Publisher", "Bosom Friend");
                    key.SetValue("InstallLocation", dir);
                    key.SetValue("UninstallString", "\"" + Path.Combine(dir, "UninstallBosomFriend.exe") + "\"");
                    key.SetValue("DisplayIcon", Path.Combine(dir, "runtime", "electron", "BosomFriendDesktop.exe"));
                    key.SetValue("NoModify", 1);
                    key.SetValue("NoRepair", 1);
                    key.SetValue("EstimatedSize", 1400000);
                }
            }
            catch { }
        }

        private static void DeleteRegistry()
        {
            try
            {
                Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BosomFriend", false);
            }
            catch { }
        }

        private static void DeleteShortcuts()
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string startMenu = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Bosom Friend");
            foreach (string path in new[]
            {
                Path.Combine(desktop, "Bosom Friend.lnk"),
                Path.Combine(desktop, "Stop Bosom Friend.lnk"),
                Path.Combine(startMenu, "Bosom Friend.lnk"),
                Path.Combine(startMenu, "Stop Bosom Friend.lnk"),
            })
            {
                try { if (File.Exists(path)) File.Delete(path); } catch { }
            }
            try { if (Directory.Exists(startMenu)) Directory.Delete(startMenu, true); } catch { }
        }

        private static void StopApp(string dir)
        {
            try
            {
                string stopVbs = Path.Combine(dir, "Stop-BosomFriend.vbs");
                if (File.Exists(stopVbs))
                {
                    Process.Start(new ProcessStartInfo("wscript.exe", "\"" + stopVbs + "\"") { UseShellExecute = false })
                        .WaitForExit(30000);
                }
            }
            catch { }
        }

        internal static void LaunchApp(string dir)
        {
            try
            {
                string desktopExe = Path.Combine(dir, "runtime", "electron", "BosomFriendDesktop.exe");
                if (!File.Exists(desktopExe))
                    return;
                Process.Start(new ProcessStartInfo(desktopExe, "--no-sandbox")
                {
                    WorkingDirectory = dir,
                    UseShellExecute = true,
                });
            }
            catch { }
        }

        internal interface IProgress
        {
            void Report(int percent, string status);
        }

        private sealed class BoundedStream : Stream
        {
            private readonly Stream _inner;
            private readonly long _start;
            private readonly long _length;
            private readonly bool _leaveOpen;
            private long _pos;

            public BoundedStream(Stream inner, long start, long length, bool leaveOpen)
            {
                _inner = inner;
                _start = start;
                _length = length;
                _leaveOpen = leaveOpen;
                _pos = 0;
            }

            public override bool CanRead { get { return true; } }
            public override bool CanSeek { get { return true; } }
            public override bool CanWrite { get { return false; } }
            public override long Length { get { return _length; } }
            public override long Position
            {
                get { return _pos; }
                set { Seek(value, SeekOrigin.Begin); }
            }

            public override int Read(byte[] buffer, int offset, int count)
            {
                long remaining = _length - _pos;
                if (remaining <= 0)
                    return 0;
                int toRead = (int)Math.Min(count, remaining);
                int read = _inner.Read(buffer, offset, toRead);
                _pos += read;
                return read;
            }

            public override long Seek(long offset, SeekOrigin origin)
            {
                long target = origin == SeekOrigin.Begin ? offset
                    : origin == SeekOrigin.Current ? _pos + offset
                    : _length + offset;
                if (target < 0 || target > _length)
                    throw new IOException("Seek outside payload");
                _inner.Seek(_start + target, SeekOrigin.Begin);
                _pos = target;
                return _pos;
            }

            public override void Flush() { }
            public override void SetLength(long value) { throw new NotSupportedException(); }
            public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }

            protected override void Dispose(bool disposing)
            {
                if (disposing && !_leaveOpen)
                    _inner.Dispose();
                base.Dispose(disposing);
            }
        }
    }

    internal sealed class InstallerForm : Form, Program.IProgress
    {
        private readonly string _dir;
        private readonly bool _launch;
        private readonly Label _status = new Label();
        private readonly ProgressBar _bar = new ProgressBar();
        private readonly CheckBox _autoLaunch = new CheckBox();
        private readonly Button _finish = new Button();
        private volatile bool _success;
        private volatile bool _done;

        public bool Success { get { return _success; } }

        public InstallerForm(string customDir, bool launch)
        {
            _dir = Program.ResolveInstallDir(customDir);
            _launch = launch;
            Text = "Bosom Friend 安装";
            ClientSize = new Size(520, 200);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;

            _status.SetBounds(20, 18, 480, 40);
            _status.Text = "正在准备安装...";

            _bar.SetBounds(20, 66, 480, 22);
            _bar.Minimum = 0;
            _bar.Maximum = 100;

            _autoLaunch.SetBounds(20, 104, 360, 24);
            _autoLaunch.Text = "安装完成后启动 Bosom Friend";
            // 默认不自动启动，避免安装完成后强制打开浏览器/页面；
            // 用户需要时可在安装完成前手动勾选“安装完成后启动 Bosom Friend”。
            _autoLaunch.Checked = false;

            _finish.SetBounds(400, 150, 100, 34);
            _finish.Text = "完成";
            _finish.Enabled = false;
            _finish.Click += (s, e) =>
            {
                if (_success && _autoLaunch.Checked)
                    Program.LaunchApp(_dir);
                Close();
            };

            Controls.Add(_status);
            Controls.Add(_bar);
            Controls.Add(_autoLaunch);
            Controls.Add(_finish);
            Shown += OnShown;
        }

        private void OnShown(object sender, EventArgs e)
        {
            Thread thread = new Thread(() =>
            {
                string lastError = null;
                try
                {
                    Directory.CreateDirectory(_dir);
                    Program.BootstrapLog("GUI install start dir=" + _dir);
                    using (var writer = new StreamWriter(Path.Combine(_dir, "install.log"), false, new UTF8Encoding(false)))
                    {
                        Program.Log(writer, "GUI install start " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
                        _success = Program.InstallTo(_dir, this, writer, false);
                    }
                }
                catch (Exception ex)
                {
                    lastError = ex.ToString();
                    Program.BootstrapLog("GUI EX: " + lastError);
                    _success = false;
                }
                _done = true;
                BeginInvoke((Action)(() =>
                {
                    _finish.Enabled = true;
                    if (_success)
                    {
                        SetStatus("安装完成！");
                        _bar.Value = 100;
                    }
                    else
                    {
                        SetStatus("安装失败，请查看 %TEMP%\\BosomFriend-install.log" + (lastError == null ? " 和 " + Path.Combine(_dir, "install.log") : ""));
                    }
                }));
            });
            thread.IsBackground = true;
            thread.Start();
        }

        public void Report(int percent, string status)
        {
            BeginInvoke((Action)(() =>
            {
                if (percent >= 0)
                    _bar.Value = Math.Max(0, Math.Min(100, percent));
                SetStatus(status);
            }));
        }

        private void SetStatus(string text)
        {
            _status.Text = text;
        }
    }
}
