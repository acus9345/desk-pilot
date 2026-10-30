// desk-pilot engine - finding, describing and focusing top-level windows.
//
// Every tool that takes a window resolves it the same way (EnumWindows, not a
// process's "main window"), so a dialog or a second window of a multi-window app is
// as reachable as the first: hwnd wins, then an exact title, then the foreground
// match, then the first visible match. Zero-width characters are ignored.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Threading;

namespace DeskPilot
{
    public static class Win
    {
        static readonly Dictionary<uint, string> processNames = new Dictionary<uint, string>();

        public static string Clean(string s)
        {
            if (s == null) return "";
            var sb = new StringBuilder(s.Length);
            foreach (var c in s)
            {
                if (c == '​' || c == '‌' || c == '‍' || c == '‎' || c == '‏' || c == '⁠' || c == '﻿') continue;
                sb.Append(c);
            }
            return sb.ToString().Trim().ToLowerInvariant();
        }

        public static List<IntPtr> TopLevel()
        {
            var list = new List<IntPtr>();
            Native.EnumWindows(delegate (IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
            return list;
        }

        public static uint Pid(IntPtr h)
        {
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            return pid;
        }

        public static string ProcessName(uint pid)
        {
            string name;
            lock (processNames)
            {
                if (processNames.TryGetValue(pid, out name)) return name;
            }
            try { name = Process.GetProcessById((int)pid).ProcessName; } catch { name = null; }
            lock (processNames) { processNames[pid] = name; }
            return name;
        }

        static readonly uint OwnPid = (uint)Process.GetCurrentProcess().Id;

        static bool IsOwn(IntPtr h)
        {
            return Pid(h) == OwnPid; // the overlay's windows
        }

        /// <summary>Candidate windows: visible, titled, not our banner.</summary>
        public static IEnumerable<IntPtr> Candidates()
        {
            foreach (var h in TopLevel())
            {
                if (!Native.IsWindowVisible(h) || IsOwn(h)) continue;
                if (Native.GetWindowTextLengthW(h) <= 0) continue;
                yield return h;
            }
        }

        public static IntPtr ParseHandle(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return IntPtr.Zero;
            text = text.Trim();
            long value;
            bool ok = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? long.TryParse(text.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value)
                : long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
            if (!ok || value == 0) throw new ArgumentException("hwnd must be a window handle such as 0x1094C (got '" + text + "')");
            var h = new IntPtr(value);
            if (!Native.IsWindow(h)) throw new ArgumentException("the window " + text + " no longer exists; list windows again");
            return h;
        }

        /// <summary>Find a window by title or process substring.</summary>
        public static IntPtr Find(string query)
        {
            var needle = Clean(query);
            if (needle.Length == 0) return IntPtr.Zero;
            var fg = Native.GetForegroundWindow();
            IntPtr exact = IntPtr.Zero, foreground = IntPtr.Zero, first = IntPtr.Zero;
            foreach (var h in Candidates())
            {
                var title = Clean(Native.WindowTitle(h));
                bool hit = title.Contains(needle);
                if (!hit)
                {
                    var name = ProcessName(Pid(h));
                    hit = name != null && name.ToLowerInvariant().Contains(needle);
                }
                if (!hit) continue;
                if (title == needle && exact == IntPtr.Zero) exact = h;
                if (h == fg) foreground = h;
                if (first == IntPtr.Zero) first = h;
            }
            if (exact != IntPtr.Zero) return exact;
            if (foreground != IntPtr.Zero) return foreground;
            return first;
        }

        /// <summary>hwnd, else title, else nothing (IntPtr.Zero). A title that matches nothing throws.</summary>
        public static IntPtr Resolve(Dictionary<string, object> p)
        {
            var hwnd = P.Str(p, "hwnd");
            if (!string.IsNullOrWhiteSpace(hwnd)) return ParseHandle(hwnd);
            var title = P.Str(p, "title") ?? P.Str(p, "window");
            if (string.IsNullOrWhiteSpace(title)) return IntPtr.Zero;
            var h = Find(title);
            if (h == IntPtr.Zero) throw new ArgumentException("no visible window matches '" + title + "'; list windows to see what is open");
            return h;
        }

        public static string Hex(IntPtr h)
        {
            return "0x" + h.ToInt64().ToString("X", CultureInfo.InvariantCulture);
        }

        public static string Bounds(IntPtr h)
        {
            var r = Native.WindowBounds(h);
            return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
        }

        public static Dictionary<string, object> Describe(IntPtr h)
        {
            var d = new Dictionary<string, object>();
            if (h == IntPtr.Zero) return null;
            d["hwnd"] = Hex(h);
            d["title"] = Native.WindowTitle(h);
            var name = ProcessName(Pid(h));
            if (name != null) d["process"] = name;
            d["bounds"] = Bounds(h);
            if (Native.IsIconic(h)) d["minimized"] = true;
            else if (Native.IsZoomed(h)) d["maximized"] = true;
            return d;
        }

        public static List<object> List(string filter)
        {
            var needle = Clean(filter);
            var fg = Native.GetForegroundWindow();
            var list = new List<object>();
            foreach (var h in Candidates())
            {
                var title = Native.WindowTitle(h);
                var name = ProcessName(Pid(h));
                if (needle.Length > 0 && !Clean(title).Contains(needle) && (name == null || !name.ToLowerInvariant().Contains(needle))) continue;
                var d = Describe(h);
                if (Native.IsIconic(h)) d["minimized"] = true;
                if (h == fg) d["foreground"] = true;
                list.Add(d);
            }
            return list;
        }

        /// <summary>Bring a window to the front and report whether Windows actually did.</summary>
        public static bool Focus(IntPtr h, Request req)
        {
            if (Native.GetForegroundWindow() == h) return true;
            if (Native.IsIconic(h)) Native.ShowWindow(h, 9);
            var fg = Native.GetForegroundWindow();
            uint fgPid;
            uint fgThread = fg == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(fg, out fgPid);
            uint me = Native.GetCurrentThreadId();
            bool attached = fgThread != 0 && fgThread != me && Native.AttachThreadInput(me, fgThread, true);
            try
            {
                Native.SetForegroundWindow(h);
                Native.BringWindowToTop(h);
            }
            finally
            {
                if (attached) Native.AttachThreadInput(me, fgThread, false);
            }
            if (WaitForeground(h, 250, req)) return true;
            Native.SwitchToThisWindow(h, true);
            return WaitForeground(h, 350, req);
        }

        /// <summary>Poll the real foreground: the state decides where input lands, not an API's return value.</summary>
        static bool WaitForeground(IntPtr h, int ms, Request req)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            while (true)
            {
                // A window that takes focus and hands it straight back is not focused:
                // require it to hold the foreground for two consecutive checks.
                if (Native.GetForegroundWindow() == h)
                {
                    req.Sleep(40);
                    if (Native.GetForegroundWindow() == h) return true;
                }
                if (DateTime.UtcNow >= until) return false;
                req.Sleep(25);
            }
        }

        public static List<object> Screens()
        {
            var list = new List<object>();
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr dc, ref RECT r, IntPtr d)
            {
                var info = new MONITORINFOEX();
                info.cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(MONITORINFOEX));
                if (Native.GetMonitorInfoW(m, ref info))
                {
                    var s = new Dictionary<string, object>();
                    s["device"] = info.szDevice;
                    s["primary"] = (info.dwFlags & 1) != 0;
                    var b = info.rcMonitor;
                    s["bounds"] = b.Left + "," + b.Top + "," + (b.Right - b.Left) + "," + (b.Bottom - b.Top);
                    var w = info.rcWork;
                    s["work"] = w.Left + "," + w.Top + "," + (w.Right - w.Left) + "," + (w.Bottom - w.Top);
                    uint dpiX, dpiY;
                    if (Native.GetDpiForMonitor(m, 0, out dpiX, out dpiY) == 0) s["scale"] = (int)Math.Round(dpiX / 96.0 * 100);
                    s["l"] = b.Left; s["t"] = b.Top; s["r"] = b.Right; s["b"] = b.Bottom;
                    list.Add(s);
                }
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public static Dictionary<string, object> Cursor()
        {
            POINT p;
            Native.GetCursorPos(out p);
            var d = new Dictionary<string, object>();
            d["x"] = p.X;
            d["y"] = p.Y;
            return d;
        }
    }
}
