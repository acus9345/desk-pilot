// desk-pilot engine - mouse, keyboard and text input through SendInput.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace DeskPilot
{
    public static class Input
    {
        static readonly int Size = Marshal.SizeOf(typeof(INPUT));

        static void Send(params INPUT[] inputs)
        {
            uint sent = Native.SendInput((uint)inputs.Length, inputs, Size);
            if (sent != inputs.Length)
                throw new InvalidOperationException("Windows refused the input (another desktop, a lock screen, or an elevated window in front)");
        }

        static INPUT Mouse(uint flags, int data)
        {
            var i = new INPUT();
            i.type = Native.INPUT_MOUSE;
            i.u.mi.dwFlags = flags;
            i.u.mi.mouseData = data;
            return i;
        }

        static INPUT Key(ushort vk, ushort scan, uint flags)
        {
            var i = new INPUT();
            i.type = Native.INPUT_KEYBOARD;
            i.u.ki.wVk = vk;
            i.u.ki.wScan = scan;
            i.u.ki.dwFlags = flags;
            return i;
        }

        /// <summary>Put the pointer on a point with a real move event, then let the app notice it.
        /// XAML apps such as Paint track the pointer from input, so after SetCursorPos alone they
        /// still believe it is where it was, and spend the next press on catching up.</summary>
        public static void MoveTo(int x, int y)
        {
            Slide(new Point(x, y));
            POINT now;
            if (Native.GetCursorPos(out now) && (now.X != x || now.Y != y) && !Native.SetCursorPos(x, y))
                throw new InvalidOperationException("the pointer could not be moved to " + x + "," + y);
        }

        static INPUT Button(string button, bool down)
        {
            switch (button)
            {
                case "right": return Mouse(down ? 0x0008u : 0x0010u, 0);
                case "middle": return Mouse(down ? 0x0020u : 0x0040u, 0);
                case "back": return Mouse(down ? 0x0080u : 0x0100u, 1);
                case "forward": return Mouse(down ? 0x0080u : 0x0100u, 2);
                default: return Mouse(down ? 0x0002u : 0x0004u, 0);
            }
        }

        // As long as a quick human press. A press and release in one instant is missed by canvases
        // that sample input once per frame.
        const int PressMs = 40, ArriveMs = 25;

        /// <summary>Move, give the app a moment to see the pointer arrive, click.</summary>
        public static void ClickAt(int x, int y, string button, int count, int holdMs, Request req)
        {
            MoveTo(x, y);
            Thread.Sleep(ArriveMs);
            Click(button, count, holdMs, req);
        }

        public static void Click(string button, int count, int holdMs, Request req)
        {
            for (int i = 0; i < count; i++)
            {
                req.Check();
                Send(Button(button, true));
                try { req.Sleep(holdMs > 0 ? holdMs : PressMs); }
                finally { Send(Button(button, false)); }
                if (i + 1 < count) Thread.Sleep(45);
            }
        }

        // Pointer paths: one event every few pixels at about mouse speed. Windows merges moves
        // an app has not read yet, so a faster pace would flatten curves into chords.
        public const int MaxGestureMs = 15000;
        const int StepPx = 6;
        const double PxPerMs = 1.0;

        static double Dist(Point a, Point b)
        {
            double dx = b.X - a.X, dy = b.Y - a.Y;
            return Math.Sqrt(dx * dx + dy * dy);
        }

        static double Length(List<Point> path)
        {
            double total = 0;
            for (int i = 0; i + 1 < path.Count; i++) total += Dist(path[i], path[i + 1]);
            return total;
        }

        static int Pace(double px)
        {
            return (int)Math.Max(120, Math.Min(MaxGestureMs, px / PxPerMs));
        }

        static int Curve(int a, int b, int c, int d, double t)
        {
            return (int)Math.Round(0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t));
        }

        /// <summary>Fill in a stroke: straight segments, or a Catmull-Rom curve through the points.</summary>
        static List<Point> Trace(List<Point> points, bool smooth)
        {
            var path = new List<Point> { points[0] };
            for (int i = 0; i + 1 < points.Count; i++)
            {
                Point a = points[Math.Max(0, i - 1)], b = points[i], c = points[i + 1], d = points[Math.Min(points.Count - 1, i + 2)];
                int steps = Math.Max(1, (int)Math.Ceiling(Dist(b, c) / StepPx));
                for (int s = 1; s <= steps; s++)
                {
                    double t = s / (double)steps;
                    var q = smooth
                        ? new Point(Curve(a.X, b.X, c.X, d.X, t), Curve(a.Y, b.Y, c.Y, d.Y, t))
                        : new Point(b.X + (int)Math.Round((c.X - b.X) * t), b.Y + (int)Math.Round((c.Y - b.Y) * t));
                    if (q != path[path.Count - 1]) path.Add(q);
                }
            }
            return path;
        }

        /// <summary>A real move event: raw-input apps never see SetCursorPos.</summary>
        static void Slide(Point p)
        {
            int left = Native.GetSystemMetrics(76), top = Native.GetSystemMetrics(77);
            int width = Native.GetSystemMetrics(78), height = Native.GetSystemMetrics(79);
            var move = Mouse(0x0001 | 0x4000 | 0x8000, 0); // MOVE | VIRTUALDESK | ABSOLUTE
            move.u.mi.dx = (int)(((long)(p.X - left) * 65536 + width - 1) / width);
            move.u.mi.dy = (int)(((long)(p.Y - top) * 65536 + height - 1) / height);
            Send(move);
        }

        /// <summary>Follow a path on schedule. Sleep has ~15 ms resolution, so the last stretch of each wait spins.</summary>
        static void Walk(List<Point> path, int ms, Request req)
        {
            int count = path.Count - 1;
            var clock = Stopwatch.StartNew();
            for (int i = 1; i <= count; i++)
            {
                long due = ms * (long)i / count;
                long left = due - clock.ElapsedMilliseconds;
                if (left > 20) req.Sleep((int)left - 16);
                while (clock.ElapsedMilliseconds < due) { req.Check(); Thread.Yield(); }
                req.Check();
                Slide(path[i]);
            }
            POINT now;
            var end = path[count];
            if (Native.GetCursorPos(out now) && (now.X != end.X || now.Y != end.Y)) MoveTo(end.X, end.Y);
        }

        /// <summary>Press, follow the path, release. The button comes up whatever happens.</summary>
        static void Stroke(List<Point> path, string button, int dwellMs, int ms, Request req)
        {
            MoveTo(path[0].X, path[0].Y);
            Thread.Sleep(ArriveMs);
            Send(Button(button, true));
            try
            {
                if (dwellMs > 0) req.Sleep(dwellMs);
                Walk(path, ms, req);
                Thread.Sleep(30);
            }
            finally
            {
                Send(Button(button, false));
            }
        }

        public static void Drag(int fromX, int fromY, int toX, int toY, string button, int holdMs, int? durationMs, Request req)
        {
            var path = Trace(new List<Point> { new Point(fromX, fromY), new Point(toX, toY) }, false);
            Stroke(path, button, holdMs, durationMs ?? Pace(Length(path)), req);
        }

        /// <summary>Each stroke is one press-move-release. durationMs spans all of them, shared by length.</summary>
        public static int Draw(List<List<Point>> strokes, bool smooth, string button, int? durationMs, Request req)
        {
            var paths = new List<List<Point>>();
            double total = 0;
            foreach (var stroke in strokes)
            {
                var path = Trace(stroke, smooth);
                paths.Add(path);
                total += Length(path);
            }
            int ms = durationMs ?? Pace(total);
            foreach (var path in paths)
            {
                req.Check();
                Stroke(path, button, 0, total > 0 ? (int)(ms * Length(path) / total) : 0, req);
            }
            return (int)total;
        }

        /// <summary>Travel to a point through every step between, as a hand would.</summary>
        public static void Glide(int x, int y, int? durationMs, Request req)
        {
            POINT at;
            if (!Native.GetCursorPos(out at)) throw new InvalidOperationException("the pointer position could not be read");
            var path = Trace(new List<Point> { new Point(at.X, at.Y), new Point(x, y) }, false);
            Walk(path, durationMs ?? Pace(Length(path)), req);
        }

        public static void Wheel(int notches, bool horizontal)
        {
            Send(Mouse(horizontal ? 0x1000u : 0x0800u, notches * 120));
        }

        static readonly Dictionary<string, ushort> names = BuildNames();

        static Dictionary<string, ushort> BuildNames()
        {
            var d = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
            d["enter"] = 0x0D; d["return"] = 0x0D; d["tab"] = 0x09; d["esc"] = 0x1B; d["escape"] = 0x1B;
            d["space"] = 0x20; d["backspace"] = 0x08; d["bksp"] = 0x08; d["delete"] = 0x2E; d["del"] = 0x2E;
            d["insert"] = 0x2D; d["ins"] = 0x2D; d["home"] = 0x24; d["end"] = 0x23;
            d["pageup"] = 0x21; d["pgup"] = 0x21; d["pagedown"] = 0x22; d["pgdn"] = 0x22;
            d["left"] = 0x25; d["up"] = 0x26; d["right"] = 0x27; d["down"] = 0x28;
            d["ctrl"] = 0x11; d["control"] = 0x11; d["alt"] = 0x12; d["shift"] = 0x10;
            d["win"] = 0x5B; d["windows"] = 0x5B; d["meta"] = 0x5B; d["cmd"] = 0x5B;
            d["menu"] = 0x5D; d["apps"] = 0x5D; d["capslock"] = 0x14; d["printscreen"] = 0x2C; d["prtsc"] = 0x2C;
            d["plus"] = 0xBB; d["minus"] = 0xBD;
            for (int f = 1; f <= 24; f++) d["f" + f] = (ushort)(0x70 + f - 1);
            return d;
        }

        static bool Extended(ushort vk)
        {
            return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x2C;
        }

        static INPUT VkEvent(ushort vk, bool up)
        {
            ushort scan = (ushort)Native.MapVirtualKeyW(vk, 0);
            uint flags = (up ? Native.KEYEVENTF_KEYUP : 0) | (Extended(vk) ? Native.KEYEVENTF_EXTENDEDKEY : 0);
            return Key(vk, scan, flags);
        }

        /// <summary>Modifiers to hold during a click: ["ctrl","shift"] or "ctrl+shift".</summary>
        public static List<ushort> Modifiers(object raw, out string label)
        {
            var list = new List<ushort>();
            var names = new List<string>();
            label = "";
            if (raw == null) return list;
            var items = new List<string>();
            var array = raw as object[];
            if (array != null) foreach (var o in array) items.Add(Convert.ToString(o));
            else items.AddRange(Convert.ToString(raw).Split('+'));
            foreach (var item in items)
            {
                var name = (item ?? "").Trim().ToLowerInvariant();
                if (name.Length == 0) continue;
                ushort vk;
                switch (name)
                {
                    case "ctrl": case "control": vk = 0x11; name = "ctrl"; break;
                    case "shift": vk = 0x10; break;
                    case "alt": vk = 0x12; break;
                    case "win": case "windows": case "meta": vk = 0x5B; name = "win"; break;
                    default: throw new ArgumentException("modifiers can be ctrl, shift, alt or win (got '" + item + "')");
                }
                if (!list.Contains(vk)) { list.Add(vk); names.Add(name); }
            }
            label = string.Join("+", names.ToArray());
            return list;
        }

        /// <summary>The keys in "w" or "shift+w", for down and up.</summary>
        public static List<ushort> KeyList(string spec)
        {
            var list = new List<ushort>();
            foreach (var part in spec.Split('+'))
            {
                var name = part.Trim();
                if (name.Length == 0) continue;
                ushort vk;
                if (!names.TryGetValue(name, out vk))
                {
                    short scan = name.Length == 1 ? Native.VkKeyScanW(name[0]) : (short)-1;
                    if (scan == -1) throw new ArgumentException("unknown key '" + name + "'");
                    vk = (ushort)(scan & 0xFF);
                }
                if (!list.Contains(vk)) list.Add(vk);
            }
            if (list.Count == 0) throw new ArgumentException("key '" + spec + "' names no key");
            return list;
        }

        public static void Press(List<ushort> keys)
        {
            if (keys.Count == 0) return;
            var seq = new List<INPUT>();
            foreach (var k in keys) seq.Add(VkEvent(k, false));
            Send(seq.ToArray());
        }

        /// <summary>Release in reverse order. Never throws: it runs in finally blocks.</summary>
        public static void Release(List<ushort> keys)
        {
            if (keys.Count == 0) return;
            var seq = new List<INPUT>();
            for (int i = keys.Count - 1; i >= 0; i--) seq.Add(VkEvent(keys[i], true));
            try { Send(seq.ToArray()); } catch { }
        }

        // Keys and buttons held across calls by down and up. They come up on up, Esc, a cancel,
        // engine exit or the holdMs deadline; a killed engine leaves a marker file so the next
        // one can release them. While anything is held the banner, and so Esc, stays up.
        static readonly object heldLock = new object();
        static readonly List<ushort> heldKeys = new List<ushort>();
        static readonly List<string> heldButtons = new List<string>();
        static System.Threading.Timer holdTimer;
        static string expired;

        public static bool ButtonHeld { get { lock (heldLock) return heldButtons.Count > 0; } }

        static string KeyName(ushort vk)
        {
            foreach (var kv in names) if (kv.Value == vk) return kv.Key;
            return ((Keys)vk).ToString().ToLowerInvariant();
        }

        /// <summary>What is held right now, or null.</summary>
        public static string Held()
        {
            lock (heldLock)
            {
                var all = new List<string>(heldButtons);
                foreach (var k in heldKeys) all.Add(KeyName(k));
                return all.Count == 0 ? null : string.Join(", ", all.ToArray());
            }
        }

        /// <summary>What a holdMs deadline released since the last call, or null.</summary>
        public static string TakeExpired()
        {
            lock (heldLock)
            {
                var gone = expired;
                expired = null;
                return gone;
            }
        }

        static string Marker()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "held-" + Process.GetCurrentProcess().Id + ".txt");
        }

        static void HeldChanged(int limitMs)
        {
            bool any = heldKeys.Count + heldButtons.Count > 0;
            try
            {
                if (any)
                {
                    var lines = new List<string>();
                    foreach (var k in heldKeys) lines.Add("k" + k);
                    foreach (var b in heldButtons) lines.Add("b" + b);
                    File.WriteAllLines(Marker(), lines);
                }
                else File.Delete(Marker());
            }
            catch { }
            if (!any && holdTimer != null) { holdTimer.Dispose(); holdTimer = null; }
            if (any && limitMs > 0)
            {
                if (holdTimer == null) holdTimer = new System.Threading.Timer(delegate { Expire(); });
                holdTimer.Change(limitMs, Timeout.Infinite);
            }
            Program.PinBanner(any);
        }

        static void Expire()
        {
            lock (heldLock)
            {
                expired = Held();
                LetGoAll();
            }
        }

        public static void HoldButton(string button, int limitMs)
        {
            lock (heldLock)
            {
                if (!heldButtons.Contains(button))
                {
                    Send(Button(button, true));
                    heldButtons.Add(button);
                }
                HeldChanged(limitMs);
            }
        }

        public static void HoldKeys(List<ushort> keys, int limitMs)
        {
            lock (heldLock)
            {
                var fresh = NotHeld(keys);
                Press(fresh);
                heldKeys.AddRange(fresh);
                HeldChanged(limitMs);
            }
        }

        /// <summary>Drop what is already held down, so a gesture's own release cannot let go of it.</summary>
        public static List<ushort> NotHeld(List<ushort> keys)
        {
            lock (heldLock) return keys.FindAll(k => !heldKeys.Contains(k));
        }

        /// <summary>Release the named key(s) or button, or everything. False if none of it was held.</summary>
        public static bool LetGo(string keySpec, string button)
        {
            lock (heldLock)
            {
                if (keySpec == null && button == null)
                {
                    bool any = heldKeys.Count + heldButtons.Count > 0;
                    LetGoAll();
                    return any;
                }
                bool released = false;
                if (button != null && heldButtons.Remove(button))
                {
                    Send(Button(button, false));
                    released = true;
                }
                if (keySpec != null)
                {
                    var keys = KeyList(keySpec).FindAll(k => heldKeys.Contains(k));
                    Release(keys);
                    heldKeys.RemoveAll(k => keys.Contains(k));
                    released |= keys.Count > 0;
                }
                HeldChanged(0);
                return released;
            }
        }

        /// <summary>Never throws: it runs on Esc, cancels and process exit.</summary>
        public static void LetGoAll()
        {
            lock (heldLock)
            {
                if (heldKeys.Count + heldButtons.Count == 0) return;
                foreach (var b in heldButtons) { try { Send(Button(b, false)); } catch { } }
                Release(heldKeys);
                heldButtons.Clear();
                heldKeys.Clear();
                HeldChanged(0);
            }
        }

        /// <summary>A killed engine cannot release anything, so the next one does, from its marker.</summary>
        public static void ReleaseOrphans()
        {
            try
            {
                foreach (var file in Directory.GetFiles(AppDomain.CurrentDomain.BaseDirectory, "held-*.txt"))
                {
                    int pid;
                    if (!int.TryParse(Path.GetFileNameWithoutExtension(file).Substring(5), out pid) || Running(pid)) continue;
                    foreach (var line in File.ReadAllLines(file))
                    {
                        if (line.StartsWith("k")) Send(VkEvent(ushort.Parse(line.Substring(1)), true));
                        else if (line.StartsWith("b")) Send(Button(line.Substring(1), false));
                    }
                    File.Delete(file);
                }
            }
            catch { }
        }

        static bool Running(int pid)
        {
            try { return !Process.GetProcessById(pid).HasExited; }
            catch { return false; }
        }

        /// <summary>"ctrl+shift+s", "alt+tab", "enter", "f5", "win+r", "ctrl++". holdMs keeps it down, repeating like a real key.</summary>
        public static void Chord(string spec, int holdMs = 0, Request req = null)
        {
            if (string.IsNullOrWhiteSpace(spec)) throw new ArgumentException("key needs a key name or chord such as 'ctrl+s'");
            spec = spec.Trim();
            var parts = new List<string>();
            if (spec.EndsWith("++")) { parts.AddRange(spec.Substring(0, spec.Length - 2).Split('+')); parts.Add("+"); }
            else if (spec == "+") parts.Add("+");
            else parts.AddRange(spec.Split('+'));
            parts.RemoveAll(s => s.Length == 0);
            if (parts.Count == 0) throw new ArgumentException("key '" + spec + "' names no key");

            var mods = new List<ushort>();
            for (int i = 0; i < parts.Count - 1; i++)
            {
                ushort vk;
                if (!names.TryGetValue(parts[i].Trim(), out vk) || (vk != 0x11 && vk != 0x12 && vk != 0x10 && vk != 0x5B))
                    throw new ArgumentException("'" + parts[i] + "' is not a modifier (use ctrl, alt, shift or win)");
                mods.Add(vk);
            }
            var last = parts[parts.Count - 1].Trim();
            ushort main;
            bool shiftForChar = false;
            if (!names.TryGetValue(last, out main))
            {
                if (last.Length != 1) throw new ArgumentException("unknown key '" + last + "'");
                short scan = Native.VkKeyScanW(last[0]);
                if (scan == -1)
                {
                    if (mods.Count > 0) throw new ArgumentException("'" + last + "' cannot be combined with modifiers on this keyboard layout");
                    TypeKeys(last, null);
                    return;
                }
                main = (ushort)(scan & 0xFF);
                // A bare capital or symbol carries its own shift; with explicit modifiers the
                // caller said what they meant (ctrl+S is ctrl+s).
                shiftForChar = mods.Count == 0 && ((scan >> 8) & 1) != 0;
                if (shiftForChar) mods.Add(0x10);
            }
            if (holdMs > 0)
            {
                var keys = new List<ushort>(mods);
                keys.Add(main);
                Press(keys);
                try
                {
                    var clock = Stopwatch.StartNew();
                    while (clock.ElapsedMilliseconds < holdMs)
                    {
                        req.Sleep(Math.Min(33, holdMs - (int)clock.ElapsedMilliseconds));
                        if (clock.ElapsedMilliseconds >= 400) Send(VkEvent(main, false));
                    }
                }
                finally { Release(keys); }
                return;
            }
            var seq = new List<INPUT>();
            foreach (var m in mods) seq.Add(VkEvent(m, false));
            seq.Add(VkEvent(main, false));
            seq.Add(VkEvent(main, true));
            for (int i = mods.Count - 1; i >= 0; i--) seq.Add(VkEvent(mods[i], true));
            Send(seq.ToArray());
        }

        /// <summary>Type as Unicode keystrokes: no clipboard involved, any script.</summary>
        public static void TypeKeys(string text, Request req)
        {
            foreach (var c in text.Replace("\r\n", "\n"))
            {
                if (req != null) req.Check();
                if (c == '\n') { Send(VkEvent(0x0D, false), VkEvent(0x0D, true)); continue; }
                if (c == '\t') { Send(VkEvent(0x09, false), VkEvent(0x09, true)); continue; }
                Send(Key(0, c, Native.KEYEVENTF_UNICODE), Key(0, c, Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP));
            }
        }

        /// <summary>Type as one paste, then put the clipboard back the way it was.</summary>
        public static void Paste(string text, Request req)
        {
            DataObject saved = null;
            bool hadData = false;
            Program.OnSta(delegate
            {
                try
                {
                    var current = Clipboard.GetDataObject();
                    if (current != null)
                    {
                        saved = new DataObject();
                        foreach (var format in current.GetFormats(false))
                        {
                            try
                            {
                                var data = current.GetData(format, false);
                                if (data != null) { saved.SetData(format, false, data); hadData = true; }
                            }
                            catch { }
                        }
                    }
                }
                catch { }
                SetClipboardText(text);
            });
            try
            {
                req.Check();
                Chord("ctrl+v");
                // The target reads the clipboard asynchronously; restoring too early pastes the old content.
                Thread.Sleep(150);
            }
            finally
            {
                Program.OnSta(delegate
                {
                    try
                    {
                        if (hadData) Clipboard.SetDataObject(saved, true, 5, 40);
                        else Clipboard.Clear();
                    }
                    catch { }
                });
            }
        }

        static void SetClipboardText(string text)
        {
            for (int attempt = 0; ; attempt++)
            {
                try { Clipboard.SetDataObject(new DataObject(DataFormats.UnicodeText, text), true, 5, 40); return; }
                catch (Exception)
                {
                    if (attempt >= 3) throw new InvalidOperationException("the clipboard is locked by another application, so the text could not be pasted; retry with mode: 'keys'");
                    Thread.Sleep(60);
                }
            }
        }
    }
}
