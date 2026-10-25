// desk-pilot engine - mouse, keyboard and text input through SendInput.
using System;
using System.Collections.Generic;
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

        public static void MoveTo(int x, int y)
        {
            if (!Native.SetCursorPos(x, y)) throw new InvalidOperationException("the pointer could not be moved to " + x + "," + y);
        }

        static uint DownFlag(string button)
        {
            switch (button) { case "right": return 0x0008; case "middle": return 0x0020; default: return 0x0002; }
        }

        static uint UpFlag(string button)
        {
            switch (button) { case "right": return 0x0010; case "middle": return 0x0040; default: return 0x0004; }
        }

        public static void Click(string button, int count, Request req)
        {
            for (int i = 0; i < count; i++)
            {
                req.Check();
                Send(Mouse(DownFlag(button), 0), Mouse(UpFlag(button), 0));
                if (i + 1 < count) Thread.Sleep(45);
            }
        }

        /// <summary>Drag in small steps; the button is released whatever happens.</summary>
        public static void Drag(int fromX, int fromY, int toX, int toY, string button, Request req)
        {
            MoveTo(fromX, fromY);
            Thread.Sleep(30);
            Send(Mouse(DownFlag(button), 0));
            try
            {
                int steps = Math.Max(8, Math.Min(60, (int)(Math.Sqrt((toX - fromX) * (double)(toX - fromX) + (toY - fromY) * (double)(toY - fromY)) / 12)));
                for (int s = 1; s <= steps; s++)
                {
                    req.Check();
                    MoveTo(fromX + (toX - fromX) * s / steps, fromY + (toY - fromY) * s / steps);
                    Thread.Sleep(8);
                }
                Thread.Sleep(30);
            }
            finally
            {
                Send(Mouse(UpFlag(button), 0));
            }
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

        /// <summary>"ctrl+shift+s", "alt+tab", "enter", "f5", "win+r", "ctrl++".</summary>
        public static void Chord(string spec)
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
