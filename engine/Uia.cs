// desk-pilot engine - UI Automation: the control tree, finding controls by index or
// by name, and the conditions a step can wait for or verify.
//
// Every read goes through one CacheRequest, so a whole window's tree comes back in a
// single cross-process call instead of one call per property per element.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Windows;
using System.Windows.Automation;

namespace DeskPilot
{
    public class Node
    {
        public AutomationElement Element;
        public string Role, Name, AutomationId, RuntimeId, Value;
        public Rect Box;
        public bool Enabled, Offscreen, Focused, Password, HasToggle, Toggled, HasSelect, Selected;
    }

    public class Listing
    {
        public IntPtr Window;
        public List<Node> Nodes;
    }

    public static class Uia
    {
        const int MaxElements = 4000;
        // Roles a person operates. Named Pane/Custom/Group count too: Win32 dialogs bridged
        // through MSAA and many custom toolkits report their buttons that way.
        static readonly HashSet<string> Operable = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Button", "CheckBox", "ComboBox", "Edit", "Hyperlink", "ListItem", "MenuItem", "RadioButton", "Slider",
            "Spinner", "SplitButton", "TabItem", "TreeItem", "DataItem", "Document", "HeaderItem"
        };
        static readonly HashSet<string> NamedOnly = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Pane", "Custom" };

        static readonly Dictionary<IntPtr, Listing> listings = new Dictionary<IntPtr, Listing>();
        static IntPtr lastListed = IntPtr.Zero;

        static CacheRequest Cache()
        {
            var c = new CacheRequest();
            c.TreeFilter = Automation.ControlViewCondition;
            c.TreeScope = TreeScope.Element;
            c.Add(AutomationElement.NameProperty);
            c.Add(AutomationElement.ControlTypeProperty);
            c.Add(AutomationElement.BoundingRectangleProperty);
            c.Add(AutomationElement.IsEnabledProperty);
            c.Add(AutomationElement.IsOffscreenProperty);
            c.Add(AutomationElement.HasKeyboardFocusProperty);
            c.Add(AutomationElement.AutomationIdProperty);
            c.Add(AutomationElement.IsPasswordProperty);
            c.Add(AutomationElement.RuntimeIdProperty);
            c.Add(AutomationElement.IsTogglePatternAvailableProperty);
            c.Add(AutomationElement.IsSelectionItemPatternAvailableProperty);
            c.Add(AutomationElement.IsValuePatternAvailableProperty);
            c.Add(TogglePattern.ToggleStateProperty);
            c.Add(SelectionItemPattern.IsSelectedProperty);
            c.Add(ValuePattern.ValueProperty);
            return c;
        }

        static T Cached<T>(AutomationElement e, AutomationProperty prop, T fallback)
        {
            try
            {
                var v = e.GetCachedPropertyValue(prop, true);
                if (v == null || v == AutomationElement.NotSupported) return fallback;
                return (T)v;
            }
            catch { return fallback; }
        }

        static string RoleOf(ControlType type)
        {
            if (type == null) return "Unknown";
            var n = type.ProgrammaticName ?? "";
            return n.StartsWith("ControlType.") ? n.Substring(12) : n;
        }

        static Node ToNode(AutomationElement e)
        {
            var n = new Node();
            n.Element = e;
            n.Role = RoleOf(Cached<ControlType>(e, AutomationElement.ControlTypeProperty, null));
            n.Name = Cached<string>(e, AutomationElement.NameProperty, "") ?? "";
            n.AutomationId = Cached<string>(e, AutomationElement.AutomationIdProperty, "") ?? "";
            n.Box = Cached<Rect>(e, AutomationElement.BoundingRectangleProperty, Rect.Empty);
            n.Enabled = Cached<bool>(e, AutomationElement.IsEnabledProperty, true);
            n.Offscreen = Cached<bool>(e, AutomationElement.IsOffscreenProperty, false);
            n.Focused = Cached<bool>(e, AutomationElement.HasKeyboardFocusProperty, false);
            n.Password = Cached<bool>(e, AutomationElement.IsPasswordProperty, false);
            var rid = Cached<int[]>(e, AutomationElement.RuntimeIdProperty, null);
            n.RuntimeId = rid == null ? "" : string.Join(".", rid.Select(x => x.ToString(CultureInfo.InvariantCulture)).ToArray());
            n.HasToggle = Cached<bool>(e, AutomationElement.IsTogglePatternAvailableProperty, false);
            if (n.HasToggle) n.Toggled = Cached<ToggleState>(e, TogglePattern.ToggleStateProperty, ToggleState.Off) == ToggleState.On;
            n.HasSelect = Cached<bool>(e, AutomationElement.IsSelectionItemPatternAvailableProperty, false);
            if (n.HasSelect) n.Selected = Cached<bool>(e, SelectionItemPattern.IsSelectedProperty, false);
            if (Cached<bool>(e, AutomationElement.IsValuePatternAvailableProperty, false))
                n.Value = Cached<string>(e, ValuePattern.ValueProperty, null);
            return n;
        }

        /// <summary>Every element of a window's control view, in document order.</summary>
        public static List<Node> ReadAll(IntPtr window, out bool truncated)
        {
            var nodes = new List<Node>();
            truncated = false;
            AutomationElement root;
            var cache = Cache();
            using (cache.Activate())
            {
                root = AutomationElement.FromHandle(window);
                var found = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                foreach (AutomationElement e in found)
                {
                    if (nodes.Count >= MaxElements) { truncated = true; break; }
                    nodes.Add(ToNode(e));
                }
            }
            return nodes;
        }

        public static bool IsOperable(Node n)
        {
            if (Operable.Contains(n.Role)) return true;
            return NamedOnly.Contains(n.Role) && n.Name.Trim().Length > 0;
        }

        static string Clip(string s, int max)
        {
            if (s == null) return "";
            s = s.Replace("\r", " ").Replace("\n", " ").Replace("'", "’");
            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }

        public static string Line(int index, Node n, bool includeValues, bool bounds)
        {
            var sb = new StringBuilder();
            sb.Append(index).Append(" [").Append(n.Role).Append("] '").Append(Clip(n.Name, 80)).Append("'");
            if (bounds && !n.Box.IsEmpty)
                sb.Append(" @ ").Append((int)n.Box.X).Append(',').Append((int)n.Box.Y).Append(' ')
                  .Append((int)n.Box.Width).Append('x').Append((int)n.Box.Height);
            if (n.Name.Trim().Length == 0 && n.AutomationId.Length > 0) sb.Append(" id=").Append(Clip(n.AutomationId, 40));
            if (!n.Enabled) sb.Append(" disabled");
            if (n.Offscreen) sb.Append(" offscreen");
            if (n.Focused) sb.Append(" focused");
            if (n.HasToggle) sb.Append(n.Toggled ? " on" : " off");
            if (n.HasSelect && n.Selected) sb.Append(" selected");
            if (includeValues && n.Value != null)
                sb.Append(" value='").Append(n.Password ? "••••" : Clip(n.Value, 80)).Append("'");
            return sb.ToString();
        }

        /// <summary>The controls action: list a window's operable controls and remember the listing.</summary>
        public static Dictionary<string, object> List(IntPtr window, bool meaningfulOnly, bool includeValues, bool bounds, Request req)
        {
            bool truncated;
            var all = ReadAll(window, out truncated);
            // Chromium and Electron build their accessibility tree lazily, on the first
            // request; a near-empty first answer is retried once instead of trusted.
            if (all.Count < 5)
            {
                req.Sleep(300);
                all = ReadAll(window, out truncated);
            }
            // Off-screen rows (scrolled-away history, collapsed panes) are most of a big tree and
            // none of what can be clicked now; name targets still search the whole tree.
            var kept = meaningfulOnly ? all.Where(n => IsOperable(n) && !n.Offscreen).ToList() : all;
            var lines = new List<object>();
            for (int i = 0; i < kept.Count; i++) lines.Add(Line(i, kept[i], includeValues, bounds));
            lock (listings)
            {
                listings[window] = new Listing { Window = window, Nodes = kept };
                lastListed = window;
            }
            var r = new Dictionary<string, object>();
            r["window"] = Win.Describe(window);
            r["controls"] = lines;
            r["total"] = all.Count;
            r["kept"] = kept.Count;
            if (truncated) r["truncated"] = true;
            return r;
        }

        public static IntPtr LastListedWindow()
        {
            lock (listings) { return lastListed; }
        }

        static Node Fresh(IntPtr window, string runtimeId)
        {
            bool truncated;
            foreach (var n in ReadAll(window, out truncated))
                if (n.RuntimeId == runtimeId) return n;
            return null;
        }

        /// <summary>Index target: the row of the last listing of this window, found again by its
        /// runtime id (so it survives rows moving) and refused if it is no longer the same control.</summary>
        public static Node ByIndex(IntPtr window, int index)
        {
            Listing listing;
            lock (listings) { listings.TryGetValue(window, out listing); }
            if (listing == null) throw new ArgumentException("no controls listing for '" + Native.WindowTitle(window) + "' yet; read controls first");
            if (index < 0 || index >= listing.Nodes.Count) throw new ArgumentException("index " + index + " is outside the last listing (0.." + (listing.Nodes.Count - 1) + "); read controls again");
            var was = listing.Nodes[index];
            var now = was.RuntimeId.Length > 0 ? Fresh(window, was.RuntimeId) : null;
            if (now == null)
                throw new ArgumentException("the control at index " + index + " ([" + was.Role + "] '" + Clip(was.Name, 60) + "') is gone; read controls again");
            if (now.Role != was.Role || now.Name != was.Name)
                throw new ArgumentException("the control at index " + index + " is not the one that was listed: expected [" + was.Role + "] '" + Clip(was.Name, 60) +
                    "', found [" + now.Role + "] '" + Clip(now.Name, 60) + "'. Read controls again.");
            return now;
        }

        /// <summary>Name target: exact (case-insensitive) beats contains; on-screen and enabled
        /// beat hidden and disabled; still ambiguous is an error that lists the candidates.</summary>
        public static Node ByName(IntPtr window, string name, string role)
        {
            bool truncated;
            var all = ReadAll(window, out truncated);
            var needle = Win.Clean(name);
            Func<Node, bool> roleOk = n => string.IsNullOrWhiteSpace(role) || string.Equals(n.Role, role.Trim(), StringComparison.OrdinalIgnoreCase);
            var exact = all.Where(n => roleOk(n) && Win.Clean(n.Name) == needle).ToList();
            var pool = exact.Count > 0 ? exact : all.Where(n => roleOk(n) && needle.Length > 0 && Win.Clean(n.Name).Contains(needle)).ToList();
            if (pool.Count == 0)
            {
                var what = string.IsNullOrWhiteSpace(role) ? "control" : role + " ";
                throw new ArgumentException("no " + what + "named '" + name + "' in '" + Native.WindowTitle(window) + "'; read controls to see what is there");
            }
            var visible = pool.Where(n => !n.Offscreen && !n.Box.IsEmpty && n.Box.Width > 0).ToList();
            if (visible.Count > 0) pool = visible;
            if (pool.Count > 1)
            {
                var operable = pool.Where(IsOperable).ToList();
                if (operable.Count > 0) pool = operable;
            }
            if (pool.Count > 1)
            {
                var some = string.Join("; ", pool.Take(5).Select(n => "[" + n.Role + "] '" + Clip(n.Name, 40) + "' @ " + (int)n.Box.X + "," + (int)n.Box.Y).ToArray());
                throw new ArgumentException(pool.Count + " controls match '" + name + "' (" + some + "); add role, or read controls and use an index");
            }
            return pool[0];
        }

        /// <summary>Where to click a control: the centre of its rectangle, scrolled into view if needed.</summary>
        public static System.Drawing.Point PointOf(Node n)
        {
            if (!n.Enabled) throw new ArgumentException("[" + n.Role + "] '" + Clip(n.Name, 60) + "' is disabled; clicking it would do nothing");
            var box = n.Box;
            if (n.Offscreen || box.IsEmpty || box.Width <= 0 || box.Height <= 0)
            {
                try
                {
                    object pattern;
                    if (n.Element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern))
                    {
                        ((ScrollItemPattern)pattern).ScrollIntoView();
                        System.Threading.Thread.Sleep(120);
                        box = n.Element.Current.BoundingRectangle;
                    }
                }
                catch { }
                if (box.IsEmpty || box.Width <= 0 || box.Height <= 0)
                    throw new ArgumentException("[" + n.Role + "] '" + Clip(n.Name, 60) + "' has no on-screen rectangle (scrolled away or hidden)");
            }
            return new System.Drawing.Point((int)(box.X + box.Width / 2), (int)(box.Y + box.Height / 2));
        }

        public static string Describe(Node n)
        {
            return "[" + n.Role + "] '" + Clip(n.Name, 60) + "'";
        }

        /// <summary>The element with keyboard focus, or null.</summary>
        public static Node Focused()
        {
            try
            {
                var cache = Cache();
                using (cache.Activate())
                {
                    var e = AutomationElement.FocusedElement;
                    return e == null ? null : ToNode(e);
                }
            }
            catch { return null; }
        }

        /// <summary>A named control exists (anywhere in the window's control view).</summary>
        public static bool Exists(IntPtr window, string name)
        {
            if (window == IntPtr.Zero) return false;
            bool truncated;
            var needle = Win.Clean(name);
            return ReadAll(window, out truncated).Any(n => !n.Offscreen && Win.Clean(n.Name).Contains(needle));
        }
    }
}
