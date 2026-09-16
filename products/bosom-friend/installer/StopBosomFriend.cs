using System;
using System.Diagnostics;
using System.IO;

internal static class StopBosomFriend
{
    private static int Main(string[] args)
    {
        string dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "BosomFriend");
        foreach (string arg in args)
        {
            if (arg.StartsWith("/dir=", StringComparison.OrdinalIgnoreCase))
                dir = arg.Substring("/dir=".Length).Trim('"');
        }
        string pidFile = Path.Combine(dir, "bosom-friend.pid");
        try
        {
            if (File.Exists(pidFile))
            {
                int pid = int.Parse(File.ReadAllText(pidFile).Trim());
                ProcessStartInfo kill = new ProcessStartInfo("taskkill", "/F /PID " + pid + " /T")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                };
                using (Process proc = Process.Start(kill))
                    proc.WaitForExit(5000);
            }
        }
        catch { }
        try
        {
            ProcessStartInfo ps = new ProcessStartInfo(
                "powershell",
                "-NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + dir + "*' -and $_.Name -in @('pythonw.exe','node.exe','chrome.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
            };
            using (Process proc = Process.Start(ps))
                proc.WaitForExit(10000);
        }
        catch { }
        try { if (File.Exists(pidFile)) File.Delete(pidFile); } catch { }
        return 0;
    }
}
