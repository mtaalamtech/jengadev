using System;
using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

// A brand-new, unsigned exe with no PE version metadata at all (no company,
// product, or description - just a bare icon) is itself a weak signal some
// AV heuristics weigh when deciding whether something "looks like" a
// dropper, on top of the real behavioral trigger: this spawns another
// hidden process (JengaDev.exe) and registers a tray-only window, which is
// a legitimate and extremely common pattern (every tray-icon app does the
// window registration; plenty of legitimate updater/launcher tools spawn a
// hidden child), but also happens to overlap with how actual malware
// behaves. This metadata alone doesn't fix AV false positives - code
// signing is the real, durable fix for that, and isn't something to do
// unilaterally - but it's a free, in-our-control improvement that helps
// both static scanners and a human looking at file properties.
[assembly: AssemblyTitle("JengaDev")]
[assembly: AssemblyDescription("JengaDev tray launcher - starts and manages the JengaDev local dev server daemon")]
[assembly: AssemblyCompany("Core Mtaalam Technologies")]
[assembly: AssemblyProduct("JengaDev")]
[assembly: AssemblyCopyright("Copyright © Core Mtaalam Technologies")]
[assembly: AssemblyVersion("1.0.33.0")]
[assembly: AssemblyFileVersion("1.0.33.0")]

namespace JengaDevTrayApp
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool silent = Array.IndexOf(args, "--silent") >= 0;
            // Without this, clicking the Start Menu/Desktop shortcut a second
            // time while JengaDev is already running spawns a second tray
            // icon, whose own startup logic kills the first instance's
            // daemon process out from under it - confusing at best. A named
            // mutex means the second launch just reopens the dashboard in
            // the already-running instance and exits immediately instead.
            bool createdNew;
            using (var mutex = new Mutex(true, "Global\\JengaDevTrayAppSingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    if (!silent)
                    {
                        try
                        {
                            string tokenPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config", "daemon_token.txt");
                            string token = File.ReadAllText(tokenPath).Trim();
                            Process.Start(new ProcessStartInfo("http://127.0.0.1:4000/?token=" + token) { UseShellExecute = true });
                        }
                        catch { }
                    }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new JengaDevContext(silent));
            }
        }
    }

    public class JengaDevContext : ApplicationContext
    {
        private NotifyIcon trayIcon;
        private Process daemonProcess;
        private readonly string baseDir;
        private readonly string exePath;
        private readonly string tokenPath;

        public JengaDevContext(bool silent)
        {
            baseDir = AppDomain.CurrentDomain.BaseDirectory;
            exePath = Path.Combine(baseDir, "JengaDev.exe");
            tokenPath = Path.Combine(baseDir, "config", "daemon_token.txt");

            trayIcon = new NotifyIcon();
            string icoPath = Path.Combine(baseDir, "JengaDev.ico");
            trayIcon.Icon = File.Exists(icoPath) ? new System.Drawing.Icon(icoPath) : SystemIcons.Application;
            trayIcon.Text = "JengaDev";
            trayIcon.Visible = true;

            ContextMenu menu = new ContextMenu();
            menu.MenuItems.Add(new MenuItem("Open Dashboard", OpenDashboard));
            menu.MenuItems.Add("-");
            menu.MenuItems.Add(new MenuItem("Start All Servers", StartAll));
            menu.MenuItems.Add(new MenuItem("Stop All Servers", StopAll));
            menu.MenuItems.Add("-");
            menu.MenuItems.Add(new MenuItem("Quit", Quit));
            trayIcon.ContextMenu = menu;
            trayIcon.DoubleClick += OpenDashboard;

            StartDaemon(silent);

            Application.ApplicationExit += (s, e) => { trayIcon.Visible = false; };
        }

        // Reads the token fresh on every call rather than caching it once at
        // startup - the daemon creates the file on its own first run, which
        // can land a moment after this process starts spawning it.
        private string ReadToken()
        {
            try { return File.ReadAllText(tokenPath).Trim(); } catch { return ""; }
        }

        private void StartDaemon(bool silent)
        {
            try
            {
                // Only ever touch a process that IS JengaDev.exe, not "every
                // node.exe on the machine" - this used to kill every Node
                // process system-wide (the user's own projects, editors,
                // anything), which would have been a nasty surprise on a dev
                // machine. Only relevant if a previous instance didn't exit
                // cleanly; the normal path is just starting fresh.
                foreach (var proc in Process.GetProcessesByName("JengaDev"))
                {
                    try { proc.Kill(); proc.WaitForExit(3000); } catch { }
                }

                if (!File.Exists(exePath))
                {
                    MessageBox.Show("JengaDev.exe not found at " + exePath, "JengaDev", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                var psi = new ProcessStartInfo
                {
                    FileName = exePath,
                    // --silent tells the daemon not to auto-open a browser
                    // tab on startup - needed for the autostartup shortcut,
                    // where nobody wants a tab popping up on every Windows
                    // login. The tray icon itself covers "open the
                    // dashboard" from then on regardless.
                    Arguments = silent ? "--silent" : "",
                    WorkingDirectory = baseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                daemonProcess = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to start JengaDev: " + ex.Message, "JengaDev", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        void OpenDashboard(object sender, EventArgs e)
        {
            string token = ReadToken();
            string url = "http://127.0.0.1:4000/" + (token.Length > 0 ? "?token=" + token : "");
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }

        void StartAll(object sender, EventArgs e)
        {
            foreach (var svc in new[] { "caddy", "php", "mysql", "postgres", "mailpit" })
                PostApi(svc, "/api/start");
        }

        void StopAll(object sender, EventArgs e)
        {
            foreach (var svc in new[] { "caddy", "php", "mysql", "postgres", "mailpit" })
                PostApi(svc, "/api/stop");
        }

        void PostApi(string service, string endpoint)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4000" + endpoint);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Headers.Add("X-JengaDev-Token", ReadToken());
                using (var streamWriter = new StreamWriter(request.GetRequestStream()))
                {
                    streamWriter.Write("{\"service\":\"" + service + "\"}");
                }
                using (var response = (HttpWebResponse)request.GetResponse()) { }
            }
            catch { }
        }

        void Quit(object sender, EventArgs e)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4000/api/quit");
                request.Method = "POST";
                request.Headers.Add("X-JengaDev-Token", ReadToken());
                using (var response = (HttpWebResponse)request.GetResponse()) { }
            }
            catch { }

            // Belt and suspenders: if /api/quit didn't actually bring the
            // daemon down (wrong/missing token, daemon already wedged),
            // killing the process directly still guarantees Quit means quit.
            try
            {
                if (daemonProcess != null && !daemonProcess.HasExited) daemonProcess.Kill();
            }
            catch { }

            trayIcon.Visible = false;
            Application.Exit();
        }
    }
}
