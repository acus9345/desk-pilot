// desk-pilot engine - starting apps, by Start Menu name, program name or path.
//
// The Start Menu's own list (shell:AppsFolder) is the only one that knows Store apps as well
// as installed ones, and it holds the names a person sees, in their language. Anything it
// does not know goes to ShellExecute, which finds programs on PATH, App Paths, and URLs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Reflection;

namespace DeskPilot
{
    public static class Apps
    {
        class Entry { public string Name, Id; }

        const int WindowWaitMs = 6000;

        static object Get(object target, string member, BindingFlags kind, params object[] args)
        {
            return target.GetType().InvokeMember(member, kind, null, target, args);
        }

        static List<Entry> StartMenu()
        {
            var list = new List<Entry>();
            Program.OnSta(delegate
            {
                var shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
                var folder = Get(shell, "NameSpace", BindingFlags.InvokeMethod, "shell:AppsFolder");
                foreach (var item in (IEnumerable)Get(folder, "Items", BindingFlags.InvokeMethod))
                    list.Add(new Entry { Name = Convert.ToString(Get(item, "Name", BindingFlags.GetProperty)), Id = Convert.ToString(Get(item, "Path", BindingFlags.GetProperty)) });
            });
            return list;
        }

        static void OpenEntry(Entry entry)
        {
            Process.Start("explorer.exe", "shell:AppsFolder\\" + entry.Id);
        }

        /// <summary>False when Windows knows no such program; other failures are the caller's to see.</summary>
        static bool Shell(string app, string args, string cwd)
        {
            var info = new ProcessStartInfo(app) { UseShellExecute = true, ErrorDialog = false };
            if (args != null) info.Arguments = args;
            if (cwd != null) info.WorkingDirectory = cwd;
            try { Process.Start(info); return true; }
            catch (Win32Exception e)
            {
                if (e.NativeErrorCode == 2 || e.NativeErrorCode == 3) return false;
                throw new InvalidOperationException("Windows could not start '" + app + "': " + e.Message);
            }
        }

        static void Start(string app, string args, string cwd)
        {
            bool isPath = app.IndexOfAny(new[] { '\\', '/', ':' }) >= 0;
            if (isPath)
            {
                if (!Shell(app, args, cwd)) throw new ArgumentException("nothing to open at '" + app + "'");
                return;
            }
            var entries = StartMenu();
            var needle = Win.Clean(app);
            var exact = entries.Find(e => Win.Clean(e.Name) == needle);
            if (exact != null && args == null && cwd == null) { OpenEntry(exact); return; }
            if (Shell(app, args, cwd)) return;
            if (exact != null) throw new ArgumentException("'" + exact.Name + "' is a Start Menu app, which takes no args or cwd; pass its .exe path instead");
            var near = entries.Where(e => Win.Clean(e.Name).Contains(needle)).ToList();
            if (near.Count == 1 && args == null && cwd == null) { OpenEntry(near[0]); return; }
            if (near.Count == 0) throw new ArgumentException("no app named '" + app + "' in the Start Menu or on PATH");
            throw new ArgumentException(near.Count + " apps match '" + app + "': " + string.Join(", ", near.Take(6).Select(e => e.Name).ToArray()) + "; use the full name");
        }

        /// <summary>Start an app and return the window it opened, or null if none appeared in time
        /// (it may have reused an open window, or have no window at all).</summary>
        public static Dictionary<string, object> Launch(string app, string args, string cwd, Request req)
        {
            var before = new HashSet<IntPtr>(Win.Candidates());
            Start(app, args, cwd);
            var until = DateTime.UtcNow.AddMilliseconds(WindowWaitMs);
            while (DateTime.UtcNow < until)
            {
                req.Sleep(100);
                foreach (var h in Win.Candidates())
                    if (!before.Contains(h)) return Win.Describe(h);
            }
            return null;
        }
    }
}
