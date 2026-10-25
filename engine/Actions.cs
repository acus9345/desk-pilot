// desk-pilot engine - one desktop action, then the evidence of what it did.
//
// Every input action reports where input went afterwards (the foreground window and
// the control with keyboard focus). type reads the focused control's value back and
// says whether the text arrived. A step may also carry `expect` - conditions that must
// hold within a timeout - which turns "probably worked" into a checked result and
// stops a batch at the first step whose effect did not happen.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Automation;

namespace DeskPilot
{
    public static class Actions
    {
        static readonly HashSet<string> Pointer = new HashSet<string> { "click", "doubleClick", "rightClick", "middleClick", "move", "scroll", "drag" };

        public static Dictionary<string, object> Run(Request req)
        {
            var p = req.P;
            var action = P.Str(p, "action");
            if (string.IsNullOrWhiteSpace(action)) throw new ArgumentException("action is required");
            var r = new Dictionary<string, object>();
            r["action"] = action;
            var notes = new List<object>();
            IntPtr window = IntPtr.Zero;
            Node control = null;

            switch (action)
            {
                case "windows":
                    r["windows"] = Win.List(P.Str(p, "title"));
                    break;

                case "controls":
                    {
                        window = Win.Resolve(p);
                        if (window == IntPtr.Zero) window = Native.GetForegroundWindow();
                        foreach (var kv in Uia.List(window, P.Bool(p, "meaningfulOnly", true), P.Bool(p, "includeValues", false), req)) r[kv.Key] = kv.Value;
                        break;
                    }

                case "focus":
                    {
                        window = Win.Resolve(p);
                        if (window == IntPtr.Zero) throw new ArgumentException("focus needs a title or an hwnd");
                        if (!Win.Focus(window, req))
                        {
                            var holder = Native.WindowTitle(Native.GetForegroundWindow());
                            var message = "could not bring '" + Native.WindowTitle(window) + "' to the foreground; '" + holder + "' still holds it";
                            if (!P.Bool(p, "tolerant", false))
                                throw new InvalidOperationException(message + ", so input after this step would land there. Pass tolerant: true if that is fine.");
                            notes.Add(message + " (tolerant: continuing)");
                        }
                        break;
                    }

                case "waitFor":
                    if (P.Obj(p, "expect") == null) throw new ArgumentException("waitFor needs expect, e.g. {exists: 'OK'} or {window: 'Save As'}");
                    break;

                case "type":
                    {
                        var text = P.Str(p, "text");
                        if (text == null) throw new ArgumentException("type needs text");
                        window = Win.Resolve(p);
                        if (P.Raw(p, "target") != null)
                        {
                            if (window == IntPtr.Zero) window = TargetWindow(p);
                            control = Resolve(p, window);
                            EnsureFront(window, req);
                            // Focus the control itself; a click could also move a caret or open a menu.
                            try { control.Element.SetFocus(); } catch { Input.MoveTo(Uia.PointOf(control).X, Uia.PointOf(control).Y); Input.Click("left", 1, req); }
                            req.Sleep(60);
                            r["control"] = Uia.Describe(control);
                        }
                        else if (window != IntPtr.Zero) EnsureFront(window, req);
                        req.Check();
                        if ((P.Str(p, "mode") ?? "paste") == "keys") Input.TypeKeys(text, req);
                        else Input.Paste(text, req);
                        break;
                    }

                case "key":
                    {
                        var key = P.Str(p, "key");
                        if (key == null) throw new ArgumentException("key needs a key, e.g. 'enter' or 'ctrl+s'");
                        window = Win.Resolve(p);
                        if (window != IntPtr.Zero) EnsureFront(window, req);
                        req.Check();
                        Input.Chord(key);
                        break;
                    }

                default:
                    if (!Pointer.Contains(action)) throw new ArgumentException("unknown action '" + action + "'");
                    RunPointer(action, p, r, req, out window, out control);
                    break;
            }

            req.Sleep(P.Int(p, "settleMs") ?? 0);

            if (action != "windows" && action != "controls")
            {
                var focused = Uia.Focused();
                if (focused != null) r["focused"] = Uia.Describe(focused);
                if (action == "type" && focused != null) r["typed"] = TypedVerdict(focused, P.Str(p, "text"));
                if (control != null && control.HasToggle && action != "move")
                {
                    try
                    {
                        object pattern;
                        if (control.Element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
                        {
                            var on = ((TogglePattern)pattern).Current.ToggleState == ToggleState.On;
                            notes.Add(Uia.Describe(control) + " is now " + (on ? "on" : "off") + (on == control.Toggled ? " (unchanged)" : ""));
                        }
                    }
                    catch { }
                }
            }

            var expect = P.Obj(p, "expect");
            if (expect != null) r["expect"] = Expect(expect, p, req, action == "waitFor" ? 5000 : 1500);

            if (notes.Count > 0) r["notes"] = notes;
            r["cursor"] = Win.Cursor();
            r["foreground"] = Win.Describe(Native.GetForegroundWindow());
            return r;
        }

        static IntPtr TargetWindow(Dictionary<string, object> p)
        {
            // An index belongs to the window it was listed for; a name defaults to the window in front.
            var target = P.Raw(p, "target");
            var w = target is string ? Native.GetForegroundWindow() : Uia.LastListedWindow();
            if (w == IntPtr.Zero) throw new ArgumentException("target needs a window: pass title or hwnd, or read controls first");
            return w;
        }

        static Node Resolve(Dictionary<string, object> p, IntPtr window)
        {
            var target = P.Raw(p, "target");
            var name = target as string;
            if (name != null) return Uia.ByName(window, name, P.Str(p, "role"));
            int index;
            try { index = Convert.ToInt32(target); }
            catch { throw new ArgumentException("target must be a control index from controls, or a control name"); }
            return Uia.ByIndex(window, index);
        }

        static void EnsureFront(IntPtr window, Request req)
        {
            if (Native.GetForegroundWindow() == window) return;
            if (!Win.Focus(window, req))
                throw new InvalidOperationException("could not bring '" + Native.WindowTitle(window) + "' to the front; '" +
                    Native.WindowTitle(Native.GetForegroundWindow()) + "' holds it, so the input was not sent");
        }

        static void RunPointer(string action, Dictionary<string, object> p, Dictionary<string, object> r, Request req, out IntPtr window, out Node control)
        {
            window = Win.Resolve(p);
            control = null;
            int? x = P.Int(p, "x"), y = P.Int(p, "y");
            if (P.Raw(p, "target") != null)
            {
                if (window == IntPtr.Zero) window = TargetWindow(p);
                control = Resolve(p, window);
                var pt = Uia.PointOf(control);
                x = pt.X; y = pt.Y;
                r["control"] = Uia.Describe(control);
            }
            if (action != "scroll" && (x == null || y == null)) throw new ArgumentException(action + " needs x and y, or a target");
            if (window != IntPtr.Zero && action != "move") EnsureFront(window, req);
            req.Check();
            var button = P.Str(p, "button") ?? "left";
            switch (action)
            {
                case "move": Input.MoveTo(x.Value, y.Value); break;
                case "click": Input.MoveTo(x.Value, y.Value); Input.Click(button, 1, req); break;
                case "doubleClick": Input.MoveTo(x.Value, y.Value); Input.Click(button, 2, req); break;
                case "rightClick": Input.MoveTo(x.Value, y.Value); Input.Click("right", 1, req); break;
                case "middleClick": Input.MoveTo(x.Value, y.Value); Input.Click("middle", 1, req); break;
                case "drag":
                    {
                        int? tx = P.Int(p, "toX"), ty = P.Int(p, "toY");
                        if (tx == null || ty == null) throw new ArgumentException("drag needs toX and toY");
                        Input.Drag(x.Value, y.Value, tx.Value, ty.Value, button, req);
                        break;
                    }
                case "scroll":
                    {
                        if (x != null && y != null) Input.MoveTo(x.Value, y.Value);
                        int amount = P.Int(p, "amount") ?? 3;
                        bool horizontal = (P.Int(p, "toX") ?? 0) != 0;
                        Input.Wheel(amount, horizontal);
                        break;
                    }
            }
        }

        static string Norm(string s)
        {
            return (s ?? "").Replace("\r\n", "\n").Replace("\r", "\n");
        }

        static string TypedVerdict(Node focused, string text)
        {
            if (focused.Password) return "unknown: the focused control is a password field, so its value cannot be read back";
            string value = null;
            try
            {
                object pattern;
                if (focused.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) value = ((ValuePattern)pattern).Current.Value;
            }
            catch { }
            if (value == null) return "unknown: " + Uia.Describe(focused) + " exposes no value to read back";
            return Norm(value).Contains(Norm(text))
                ? "verified: " + Uia.Describe(focused) + " now contains the text"
                : "NOT verified: " + Uia.Describe(focused) + " does not contain the text after typing";
        }

        /// <summary>Wait until every condition holds, or fail naming what did not.</summary>
        static string Expect(Dictionary<string, object> e, Dictionary<string, object> p, Request req, int defaultTimeout)
        {
            int timeout = P.Int(e, "timeoutMs") ?? defaultTimeout;
            var started = DateTime.UtcNow;
            string failing = null;
            while (true)
            {
                failing = Unmet(e, p);
                if (failing == null) return "met after " + (int)(DateTime.UtcNow - started).TotalMilliseconds + " ms";
                if ((DateTime.UtcNow - started).TotalMilliseconds >= timeout) break;
                req.Sleep(100);
            }
            var focused = Uia.Focused();
            throw new InvalidOperationException("expectation not met within " + timeout + " ms: " + failing +
                " (now: foreground '" + Native.WindowTitle(Native.GetForegroundWindow()) + "'" +
                (focused == null ? "" : ", focus " + Uia.Describe(focused)) + ")");
        }

        static string Unmet(Dictionary<string, object> e, Dictionary<string, object> p)
        {
            var window = P.Str(e, "window");
            if (window != null && Win.Find(window) == IntPtr.Zero) return "no window titled '" + window + "'";
            var foreground = P.Str(e, "foreground");
            if (foreground != null && !Win.Clean(Native.WindowTitle(Native.GetForegroundWindow())).Contains(Win.Clean(foreground)))
                return "'" + foreground + "' is not in front";
            var focusedName = P.Str(e, "focused");
            var value = P.Str(e, "value");
            if (focusedName != null || value != null)
            {
                var focused = Uia.Focused();
                if (focusedName != null && (focused == null || !Win.Clean(focused.Name).Contains(Win.Clean(focusedName))))
                    return "focus is not on '" + focusedName + "'";
                if (value != null)
                {
                    string current = null;
                    try
                    {
                        object pattern;
                        if (focused != null && focused.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) current = ((ValuePattern)pattern).Current.Value;
                    }
                    catch { }
                    if (current == null || !Norm(current).Contains(Norm(value))) return "the focused control does not contain '" + value + "'";
                }
            }
            var exists = P.Str(e, "exists");
            var gone = P.Str(e, "gone");
            if (exists != null || gone != null)
            {
                // The step's window when it names one (looked up again: it may have just opened), else the window in front.
                IntPtr scope = IntPtr.Zero;
                var title = P.Str(p, "title");
                if (!string.IsNullOrWhiteSpace(P.Str(p, "hwnd"))) { try { scope = Win.ParseHandle(P.Str(p, "hwnd")); } catch { scope = IntPtr.Zero; } }
                else if (!string.IsNullOrWhiteSpace(title)) scope = Win.Find(title);
                if (scope == IntPtr.Zero) scope = Native.GetForegroundWindow();
                if (exists != null && !Uia.Exists(scope, exists)) return "no control named '" + exists + "'";
                if (gone != null && Uia.Exists(scope, gone)) return "'" + gone + "' is still there";
            }
            return null;
        }
    }
}
