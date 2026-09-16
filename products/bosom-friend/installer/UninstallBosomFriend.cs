using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class UninstallBosomFriend
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

        // 1) 停止本应用相关进程（当前安装目录内的 node/python/chrome/electron 与 3080 端口占用）
        try
        {
            string ps = "-NoProfile -Command \"$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force }; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine.Contains('" + dir + "') -and $_.Name -in @('node.exe','pythonw.exe','python.exe','chrome.exe','electron.exe','BosomFriendDesktop.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"";
            Process p = Process.Start(new ProcessStartInfo("powershell", ps)
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetTempPath(),
            });
            if (p != null)
                p.WaitForExit(15000);
        }
        catch { }

        // 2) 删除桌面与开始菜单快捷方式
        try
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Bosom Friend");
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
        catch { }

        // 3) 删除卸载注册表项
        try
        {
            Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BosomFriend", false);
        }
        catch { }

        // 4) 删除安装目录（先换出 cwd 并等进程释放；失败再走 cmd rmdir 兜底）
        try { Environment.CurrentDirectory = Path.GetTempPath(); } catch { }
        Thread.Sleep(2000);
        for (int attempt = 0; attempt < 8 && Directory.Exists(dir); attempt++)
        {
            try
            {
                Directory.Delete(dir, true);
            }
            catch { Thread.Sleep(1500); }
        }
        if (Directory.Exists(dir))
        {
            try
            {
                // 自身 exe 正在运行会锁住目录：用分离进程在退出后删除整个目录。
                ProcessStarter.StartDetached("cmd.exe", "/c rmdir /s /q \"" + dir + "\"");
            }
            catch { }
        }
        return 0;
    }
}

internal static class ProcessStarter
{
    public static void StartHidden(string exe, string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(exe, args)
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetTempPath(),
            };
            Process p = Process.Start(psi);
            if (p != null)
                p.WaitForExit(20000);
        }
        catch { }
    }

    public static void StartDetached(string exe, string args)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(exe, args)
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetTempPath(),
            };
            Process.Start(psi);
        }
        catch { }
    }
}
