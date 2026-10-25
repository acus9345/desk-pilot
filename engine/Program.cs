// desk-pilot engine - process entry, line protocol, cancellation and the Esc banner.
//
// Protocol: one JSON object per line on stdin and stdout, UTF-8.
//   in : {"id","op":"action"|"capture"|"ping", ...}   a request, answered once
//        {"op":"cancel","id"}                           stop that request at its next check
//        {"op":"overlay","show":true|false}             banner up / down (down lingers 2 s)
//        {"op":"quit"}
//   out: {"event":"ready","pid","dpi"}  {"event":"esc","at"}  {"id","ok":true,...}  {"id","ok":false,"error",...}
//
// Threads: the main thread is STA and pumps messages (banner, Esc hotkey, clipboard);
// a reader thread takes lines and flips cancel flags immediately; one executor thread
// runs requests in order. Cancellation is an in-memory flag checked between every
// sub-step of an action, so neither Esc nor a cancel can be lost to a file race.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace DeskPilot
{
    public class StopException : Exception
    {
        public StopException(string message) : base(message) { }
    }

    public class Request
    {
        public string Id;
        public string Op;
        public Dictionary<string, object> P;
        public volatile bool Cancelled;
        public volatile bool Esc;

        public void Check()
        {
            if (Cancelled) throw new StopException(Esc ? "the person pressed Esc and cancelled this" : "cancelled before it finished");
        }

        /// <summary>Sleep in short slices so a cancel lands within ~20 ms.</summary>
        public void Sleep(int ms)
        {
            var until = DateTime.UtcNow.AddMilliseconds(Math.Max(0, ms));
            while (true)
            {
                Check();
                var left = (int)(until - DateTime.UtcNow).TotalMilliseconds;
                if (left <= 0) return;
                Thread.Sleep(Math.Min(20, left));
            }
        }
    }

    public static class P
    {
        public static string Str(Dictionary<string, object> p, string key)
        {
            object v;
            if (p == null || !p.TryGetValue(key, out v) || v == null) return null;
            var s = Convert.ToString(v, CultureInfo.InvariantCulture);
            return s;
        }

        public static int? Int(Dictionary<string, object> p, string key)
        {
            object v;
            if (p == null || !p.TryGetValue(key, out v) || v == null) return null;
            try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); }
            catch { throw new ArgumentException(key + " must be an integer"); }
        }

        public static bool Bool(Dictionary<string, object> p, string key, bool fallback)
        {
            object v;
            if (p == null || !p.TryGetValue(key, out v) || v == null) return fallback;
            if (v is bool) return (bool)v;
            return string.Equals(Convert.ToString(v, CultureInfo.InvariantCulture), "true", StringComparison.OrdinalIgnoreCase);
        }

        public static Dictionary<string, object> Obj(Dictionary<string, object> p, string key)
        {
            object v;
            if (p == null || !p.TryGetValue(key, out v)) return null;
            return v as Dictionary<string, object>;
        }

        public static object Raw(Dictionary<string, object> p, string key)
        {
            object v;
            if (p == null || !p.TryGetValue(key, out v)) return null;
            return v;
        }
    }

    /// <summary>The "who is driving" banner. Never activates, never takes clicks, and is
    /// excluded from screen capture so it never appears in a frame the model reads.</summary>
    public class Banner : Form
    {
        readonly Label label;
        readonly System.Windows.Forms.Timer hideTimer;
        bool hotkey;
        public bool CaptureExcluded;

        public Banner(string caption)
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(28, 28, 32);
            Opacity = 0.9;
            label = new Label();
            label.AutoSize = true;
            label.ForeColor = Color.White;
            label.BackColor = Color.Transparent;
            label.Text = caption;
            Controls.Add(label);
            hideTimer = new System.Windows.Forms.Timer();
            hideTimer.Interval = 2000;
            hideTimer.Tick += delegate { hideTimer.Stop(); HideNow(); };
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                // NOACTIVATE | TOOLWINDOW | TRANSPARENT (click-through) | TOPMOST
                cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020 | 0x00000008;
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0312 && m.WParam.ToInt32() == 1) Program.OnEsc();
            base.WndProc(ref m);
        }

        void Place()
        {
            var screen = Screen.PrimaryScreen.Bounds;
            float px = Math.Max(18f, screen.Height / 42f);
            label.Font = new Font("Microsoft YaHei UI", px, FontStyle.Bold, GraphicsUnit.Pixel);
            int padX = (int)(px * 1.1), padY = (int)(px * 0.45);
            var size = label.PreferredSize;
            label.Location = new Point(padX, padY);
            Size = new Size(size.Width + padX * 2, size.Height + padY * 2);
            Location = new Point(screen.Left + (screen.Width - Width) / 2, screen.Top + (int)(px * 0.8));
            int r = (int)(px * 0.7);
            var path = new System.Drawing.Drawing2D.GraphicsPath();
            path.AddArc(0, 0, r, r, 180, 90);
            path.AddArc(Width - r, 0, r, r, 270, 90);
            path.AddArc(Width - r, Height - r, r, r, 0, 90);
            path.AddArc(0, Height - r, r, r, 90, 90);
            path.CloseFigure();
            Region = new Region(path);
        }

        public void ShowBanner()
        {
            hideTimer.Stop();
            if (Visible) return;
            Place();
            Show();
            // WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+): the banner stays out of every frame.
            CaptureExcluded = Native.SetWindowDisplayAffinity(Handle, 0x11);
            if (!hotkey) hotkey = Native.RegisterHotKey(Handle, 1, 0x4000, 0x1B);
        }

        public void HideSoon()
        {
            if (!Visible) return;
            hideTimer.Stop();
            hideTimer.Start();
        }

        public void HideNow()
        {
            hideTimer.Stop();
            if (hotkey) { Native.UnregisterHotKey(Handle, 1); hotkey = false; }
            if (Visible) Hide();
        }
    }

    public static class Program
    {
        public static JavaScriptSerializer Json;
        static TextWriter output;
        static readonly object outputLock = new object();
        static readonly ConcurrentDictionary<string, Request> pending = new ConcurrentDictionary<string, Request>();
        static readonly BlockingCollection<Request> queue = new BlockingCollection<Request>();
        static volatile Request current;
        public static Banner Banner;
        public static string Dpi;

        [STAThread]
        public static int Main(string[] args)
        {
            Dpi = Native.MakeDpiAware();
            Json = new JavaScriptSerializer();
            Json.MaxJsonLength = int.MaxValue;
            Json.RecursionLimit = 64;
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

            string caption = "Claude is operating this computer · Press Esc to cancel";
            bool once = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--once") once = true;
                if (args[i] == "--caption" && i + 1 < args.Length)
                {
                    try { caption = Encoding.UTF8.GetString(Convert.FromBase64String(args[i + 1])); } catch { }
                }
            }

            if (once)
            {
                // One request, on this STA thread, no banner: the fallback when the warm
                // engine keeps dying. Still ~100 ms, not a PowerShell start.
                var line = input.ReadLine();
                if (line == null) return 1;
                var req = Parse(line);
                if (req == null) return 1;
                Write(Run(req));
                return 0;
            }

            Banner = new Banner(caption);
            var handle = Banner.Handle; // create it on this thread so Invoke works before first show

            var executor = new Thread(ExecuteLoop);
            executor.IsBackground = true;
            executor.SetApartmentState(ApartmentState.MTA);
            executor.Start();

            var reader = new Thread(delegate () { ReadLoop(input); });
            reader.IsBackground = true;
            reader.Start();

            var ready = new Dictionary<string, object>();
            ready["event"] = "ready";
            ready["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
            ready["dpi"] = Dpi;
            Write(ready);

            Application.Run();
            return 0;
        }

        static Request Parse(string line)
        {
            Dictionary<string, object> p;
            try { p = Json.DeserializeObject(line) as Dictionary<string, object>; }
            catch { return null; }
            if (p == null) return null;
            var req = new Request();
            req.Id = P.Str(p, "id") ?? "";
            req.Op = P.Str(p, "op") ?? "";
            req.P = p;
            return req;
        }

        static void ReadLoop(TextReader input)
        {
            while (true)
            {
                string line;
                try { line = input.ReadLine(); }
                catch { line = null; }
                if (line == null) { Environment.Exit(0); return; }
                line = line.Trim();
                if (line.Length == 0) continue;
                var req = Parse(line);
                if (req == null) continue;
                if (req.Op == "cancel")
                {
                    Request target;
                    if (pending.TryGetValue(req.Id, out target)) target.Cancelled = true;
                    continue;
                }
                if (req.Op == "quit") { Environment.Exit(0); return; }
                if (req.Op == "overlay")
                {
                    bool show = P.Bool(req.P, "show", false);
                    try
                    {
                        Banner.BeginInvoke((Action)delegate { if (show) Banner.ShowBanner(); else Banner.HideSoon(); });
                    }
                    catch { }
                    continue;
                }
                pending[req.Id] = req;
                queue.Add(req);
            }
        }

        static void ExecuteLoop()
        {
            foreach (var req in queue.GetConsumingEnumerable())
            {
                current = req;
                Dictionary<string, object> result;
                try { result = Run(req); }
                finally
                {
                    current = null;
                    Request removed;
                    pending.TryRemove(req.Id, out removed);
                }
                Write(result);
            }
        }

        static Dictionary<string, object> Run(Request req)
        {
            Dictionary<string, object> result;
            try
            {
                req.Check();
                switch (req.Op)
                {
                    case "action": result = Actions.Run(req); break;
                    case "capture": result = Capture.Run(req); break;
                    case "ping": result = new Dictionary<string, object>(); break;
                    default: throw new ArgumentException("unknown op '" + req.Op + "'");
                }
                result["ok"] = true;
            }
            catch (StopException e)
            {
                result = Fail(e.Message);
                result["cancelled"] = true;
                if (req.Esc) result["esc"] = true;
            }
            catch (Exception e)
            {
                result = Fail(e.Message);
            }
            result["id"] = req.Id;
            return result;
        }

        static Dictionary<string, object> Fail(string message)
        {
            var r = new Dictionary<string, object>();
            r["ok"] = false;
            r["error"] = message;
            return r;
        }

        public static void Write(Dictionary<string, object> payload)
        {
            var line = Json.Serialize(payload);
            lock (outputLock)
            {
                output.Write(line);
                output.Write('\n');
                output.Flush();
            }
        }

        /// <summary>Esc on the banner: stop what is running and tell the host, which stops the batch.</summary>
        public static void OnEsc()
        {
            var running = current;
            if (running != null) { running.Esc = true; running.Cancelled = true; }
            var e = new Dictionary<string, object>();
            e["event"] = "esc";
            e["at"] = DateTime.UtcNow.ToString("o");
            Write(e);
            if (Banner != null) Banner.HideNow();
        }

        /// <summary>Run on the STA message thread (clipboard), or inline in once-mode.</summary>
        public static void OnSta(Action action)
        {
            if (Banner == null) { action(); return; }
            Exception failure = null;
            Banner.Invoke((Action)delegate { try { action(); } catch (Exception e) { failure = e; } });
            if (failure != null) throw failure;
        }
    }
}
