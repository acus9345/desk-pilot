// desk-pilot engine - screen capture.
//
// What makes a frame cheap: it is shrunk here to the model's image budget (so the
// size reported is the size seen), an identical frame is not encoded at all, and
// with diff only the rectangle that changed since the frame the model already has is
// sent. Rulers are drawn after scaling, so their labels stay legible at any size, and
// the cursor crosshair is drawn on the delivered copy only, so a moving pointer does
// not make an unchanged screen look changed.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

namespace DeskPilot
{
    public static class Capture
    {
        class Frame { public string Key; public int W, H; public int[] Pixels; public string Hash; }
        static readonly List<Frame> frames = new List<Frame>();

        static Rectangle VirtualScreen()
        {
            return new Rectangle(Native.GetSystemMetrics(76), Native.GetSystemMetrics(77), Native.GetSystemMetrics(78), Native.GetSystemMetrics(79));
        }

        static Rectangle FromBounds(Dictionary<string, object> s)
        {
            int l = (int)s["l"], t = (int)s["t"], r = (int)s["r"], b = (int)s["b"];
            return new Rectangle(l, t, r - l, b - t);
        }

        static Bitmap Grab(Rectangle rect)
        {
            var bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
                g.CopyFromScreen(rect.X, rect.Y, 0, 0, rect.Size, CopyPixelOperation.SourceCopy);
            return bmp;
        }

        static int[] Pixels(Bitmap bmp)
        {
            var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var px = new int[bmp.Width * bmp.Height];
                if (data.Stride == bmp.Width * 4) Marshal.Copy(data.Scan0, px, 0, px.Length);
                else for (int y = 0; y < bmp.Height; y++) Marshal.Copy(data.Scan0 + y * data.Stride, px, y * bmp.Width, bmp.Width);
                return px;
            }
            finally { bmp.UnlockBits(data); }
        }

        static string Hash(int[] px, int w, int h)
        {
            ulong x = 14695981039346656037UL;
            x ^= (uint)w; x *= 1099511628211UL;
            x ^= (uint)h; x *= 1099511628211UL;
            for (int i = 0; i < px.Length; i++) { x ^= (uint)px[i]; x *= 1099511628211UL; }
            return x.ToString("x16", CultureInfo.InvariantCulture);
        }

        static Rectangle Diff(int[] a, int[] b, int w, int h)
        {
            int minX = w, minY = h, maxX = -1, maxY = -1;
            for (int y = 0; y < h; y++)
            {
                int row = y * w;
                for (int x = 0; x < w; x++)
                {
                    if (a[row + x] == b[row + x]) continue;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
            return maxX < 0 ? Rectangle.Empty : Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1);
        }

        static Frame Lookup(string key)
        {
            lock (frames) { return frames.Find(f => f.Key == key); }
        }

        static void Store(Frame frame)
        {
            lock (frames)
            {
                frames.RemoveAll(f => f.Key == frame.Key);
                frames.Insert(0, frame);
                while (frames.Count > 4) frames.RemoveAt(frames.Count - 1);
            }
        }

        public static Dictionary<string, object> Run(Request req)
        {
            var p = req.P;
            var screens = Win.Screens();
            Rectangle rect;
            string kind;
            var region = P.Str(p, "region");
            IntPtr window = IntPtr.Zero;
            if (!string.IsNullOrWhiteSpace(region))
            {
                var parts = region.Split(new[] { ',', ' ' }, StringSplitOptions.RemoveEmptyEntries);
                int[] v = new int[4];
                if (parts.Length != 4) throw new ArgumentException("region must be 'x,y,width,height' (got '" + region + "')");
                for (int i = 0; i < 4; i++)
                    if (!int.TryParse(parts[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out v[i])) throw new ArgumentException("region must be four integers (got '" + region + "')");
                rect = new Rectangle(v[0], v[1], v[2], v[3]);
                kind = "region";
            }
            else if (!string.IsNullOrWhiteSpace(P.Str(p, "hwnd")) || !string.IsNullOrWhiteSpace(P.Str(p, "window")))
            {
                window = Win.Resolve(p);
                if (Native.IsIconic(window)) throw new ArgumentException("'" + Native.WindowTitle(window) + "' is minimized; focus it first");
                var r = Native.WindowBounds(window);
                rect = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
                kind = "window";
            }
            else
            {
                var screen = (P.Str(p, "screen") ?? "primary").Trim().ToLowerInvariant();
                if (screen == "all") { rect = VirtualScreen(); kind = "all"; }
                else if (screen == "primary" || screen.Length == 0)
                {
                    var primary = screens.Find(s => (bool)((Dictionary<string, object>)s)["primary"]) as Dictionary<string, object>;
                    rect = primary != null ? FromBounds(primary) : VirtualScreen();
                    kind = "primary";
                }
                else
                {
                    int index;
                    if (!int.TryParse(screen, out index)) throw new ArgumentException("screen must be 'primary', 'all' or a monitor index (got '" + screen + "')");
                    if (index < 0 || index >= screens.Count) throw new ArgumentException("monitor " + index + " does not exist (0.." + (screens.Count - 1) + ")");
                    rect = FromBounds((Dictionary<string, object>)screens[index]);
                    kind = "screen:" + index;
                }
            }
            rect.Intersect(VirtualScreen());
            if (rect.Width <= 0 || rect.Height <= 0) throw new ArgumentException("the area to capture is off-screen");

            // Settle: grab until two consecutive grabs agree (the UI stopped repainting) or the
            // budget runs out. A static screen costs one extra grab, not a fixed sleep.
            var started = DateTime.UtcNow;
            int settleMax = P.Int(p, "settleMaxMs") ?? 0;
            req.Check();
            var bmp = Grab(rect);
            var px = Pixels(bmp);
            var hash = Hash(px, rect.Width, rect.Height);
            if (settleMax > 0)
            {
                while ((DateTime.UtcNow - started).TotalMilliseconds < settleMax)
                {
                    req.Sleep(60);
                    var next = Grab(rect);
                    var nextPx = Pixels(next);
                    var nextHash = Hash(nextPx, rect.Width, rect.Height);
                    bmp.Dispose();
                    bmp = next; px = nextPx;
                    bool stable = nextHash == hash;
                    hash = nextHash;
                    if (stable) break;
                }
            }
            int settled = (int)(DateTime.UtcNow - started).TotalMilliseconds;

            var key = P.Str(p, "key") ?? (kind + ":" + rect.X + "," + rect.Y + "," + rect.Width + "," + rect.Height);
            var baseHash = P.Str(p, "baseHash");
            bool force = P.Bool(p, "force", false);
            var previous = Lookup(key);
            Store(new Frame { Key = key, W = rect.Width, H = rect.Height, Pixels = px, Hash = hash });

            var result = new Dictionary<string, object>();
            result["kind"] = kind;
            result["area"] = rect.X + "," + rect.Y + "," + rect.Width + "," + rect.Height;
            result["hash"] = hash;
            result["settledMs"] = settled;
            result["cursor"] = Win.Cursor();
            result["foreground"] = Win.Describe(Native.GetForegroundWindow());
            var screenList = new List<object>();
            foreach (Dictionary<string, object> s in screens)
            {
                var d = new Dictionary<string, object>();
                d["device"] = s["device"]; d["primary"] = s["primary"]; d["bounds"] = s["bounds"];
                screenList.Add(d);
            }
            result["screens"] = screenList;
            if (window != IntPtr.Zero) result["window"] = Win.Describe(window);

            try
            {
                if (!force && baseHash != null && baseHash == hash)
                {
                    result["unchanged"] = true;
                    return result;
                }
                var crop = new Rectangle(0, 0, rect.Width, rect.Height);
                if (P.Bool(p, "diff", false) && !force && previous != null && previous.Hash == baseHash && previous.W == rect.Width && previous.H == rect.Height)
                {
                    var changed = Diff(previous.Pixels, px, rect.Width, rect.Height);
                    if (changed.IsEmpty) { result["unchanged"] = true; return result; }
                    if ((long)changed.Width * changed.Height < 0.6 * rect.Width * rect.Height)
                    {
                        changed.Inflate(16, 16);
                        changed.Intersect(crop);
                        crop = changed;
                        result["changedOnly"] = true;
                    }
                }
                int maxEdge = P.Int(p, "maxEdge") ?? 1568;
                int maxPixels = P.Int(p, "maxPixels") ?? 1150000;
                double s = 1.0;
                if (maxEdge > 0) s = Math.Min(s, maxEdge / (double)Math.Max(crop.Width, crop.Height));
                if (maxPixels > 0) s = Math.Min(s, Math.Sqrt(maxPixels / ((double)crop.Width * crop.Height)));
                int dw = Math.Max(1, (int)Math.Floor(crop.Width * s));
                int dh = Math.Max(1, (int)Math.Floor(crop.Height * s));
                double sx = dw / (double)crop.Width, sy = dh / (double)crop.Height;
                int originX = rect.X + crop.X, originY = rect.Y + crop.Y;

                using (var output = new Bitmap(dw, dh, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(output))
                    {
                        if (dw == crop.Width && dh == crop.Height)
                        {
                            g.InterpolationMode = InterpolationMode.NearestNeighbor;
                            g.DrawImage(bmp, new Rectangle(0, 0, dw, dh), crop, GraphicsUnit.Pixel);
                        }
                        else
                        {
                            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                            using (var attrs = new ImageAttributes())
                            {
                                attrs.SetWrapMode(WrapMode.TileFlipXY);
                                g.DrawImage(bmp, new Rectangle(0, 0, dw, dh), crop.X, crop.Y, crop.Width, crop.Height, GraphicsUnit.Pixel, attrs);
                            }
                        }
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        if (P.Bool(p, "includeCursor", true)) DrawCursor(g, originX, originY, sx, sy, dw, dh);
                        if (P.Bool(p, "rulers", true)) DrawRulers(g, originX, originY, sx, sy, dw, dh);
                    }
                    using (var ms = new MemoryStream())
                    {
                        output.Save(ms, ImageFormat.Png);
                        result["png"] = Convert.ToBase64String(ms.ToArray());
                        result["bytes"] = (int)ms.Length;
                    }
                }
                var origin = new Dictionary<string, object>(); origin["x"] = originX; origin["y"] = originY;
                var captured = new Dictionary<string, object>(); captured["w"] = crop.Width; captured["h"] = crop.Height;
                var delivered = new Dictionary<string, object>(); delivered["w"] = dw; delivered["h"] = dh;
                result["origin"] = origin;
                result["captured"] = captured;
                result["delivered"] = delivered;
                return result;
            }
            finally { bmp.Dispose(); }
        }

        static void DrawCursor(Graphics g, int ox, int oy, double sx, double sy, int dw, int dh)
        {
            POINT c;
            if (!Native.GetCursorPos(out c)) return;
            float x = (float)((c.X - ox) * sx), y = (float)((c.Y - oy) * sy);
            if (x < 0 || y < 0 || x >= dw || y >= dh) return;
            using (var halo = new Pen(Color.FromArgb(200, 255, 255, 255), 4))
            using (var pen = new Pen(Color.FromArgb(255, 230, 20, 20), 2))
            {
                g.DrawLine(halo, x - 13, y, x + 13, y); g.DrawLine(halo, x, y - 13, x, y + 13);
                g.DrawLine(pen, x - 12, y, x + 12, y); g.DrawLine(pen, x, y - 12, x, y + 12);
            }
        }

        /// <summary>Ticks along the top and left edge, labelled with SCREEN coordinates.</summary>
        static void DrawRulers(Graphics g, int ox, int oy, double sx, double sy, int dw, int dh)
        {
            int[] steps = { 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000 };
            int step = steps[steps.Length - 1];
            foreach (var candidate in steps) { if (candidate * sx >= 90) { step = candidate; break; } }
            using (var font = new Font("Segoe UI", 12f, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var ink = new SolidBrush(Color.FromArgb(255, 235, 40, 40)))
            using (var shade = new SolidBrush(Color.FromArgb(190, 255, 255, 255)))
            using (var tick = new Pen(Color.FromArgb(220, 235, 40, 40), 1))
            {
                int first = (int)Math.Ceiling(ox / (double)step) * step;
                for (int v = first; ; v += step)
                {
                    float x = (float)((v - ox) * sx);
                    if (x >= dw) break;
                    if (x < 24) continue;
                    g.DrawLine(tick, x, 0, x, 9);
                    Label(g, v.ToString(CultureInfo.InvariantCulture), x + 2, 8, font, ink, shade);
                }
                first = (int)Math.Ceiling(oy / (double)step) * step;
                for (int v = first; ; v += step)
                {
                    float y = (float)((v - oy) * sy);
                    if (y >= dh) break;
                    if (y < 24) continue;
                    g.DrawLine(tick, 0, y, 9, y);
                    Label(g, v.ToString(CultureInfo.InvariantCulture), 2, y + 1, font, ink, shade);
                }
            }
        }

        static void Label(Graphics g, string text, float x, float y, Font font, Brush ink, Brush shade)
        {
            var size = g.MeasureString(text, font);
            g.FillRectangle(shade, x - 1, y, size.Width - 2, size.Height - 2);
            g.DrawString(text, font, ink, x - 2, y - 1);
        }
    }
}
