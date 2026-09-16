using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

internal static class StartBosomFriend
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
        string desktopExe = Path.Combine(dir, "runtime", "electron", "BosomFriendDesktop.exe");
        try
        {
            if (!File.Exists(desktopExe))
                return 1;
            Process.Start(new ProcessStartInfo(desktopExe, "--no-sandbox")
            {
                WorkingDirectory = dir,
                UseShellExecute = true,
            });
        }
        catch { }
        return 0;
    }
}
