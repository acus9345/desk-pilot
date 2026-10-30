// desk-pilot engine - the on-screen sign that Claude is driving.
//
// Four per-pixel-alpha windows, shown only while Claude acts (and while anything is held):
// a blue glow around the primary screen, a soft halo that follows the pointer, a small
// label beside it, and a control bar at the bottom with Take over and Stop. None of them
// activates or takes focus, and all are excluded from screen capture, so they never
// appear in a frame the model reads. Only the bar takes clicks, and it stops taking them
// while Claude's own pointer action runs, so a click aimed underneath it cannot hit Stop.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DeskPilot
{
    /// <summary>A top-level window drawn from an ARGB bitmap. It never activates.</summary>
    public class Layer : Form
    {
        readonly bool clickThrough;

        public Layer(bool clickThrough)
        {
            this.clickThrough = clickThrough;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                // LAYERED | NOACTIVATE | TOOLWINDOW | TOPMOST
                cp.ExStyle |= 0x00080000 | 0x08000000 | 0x00000080 | 0x00000008;
                if (clickThrough) cp.ExStyle |= 0x00000020; // TRANSPARENT
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0021) { m.Result = new IntPtr(3); return; } // WM_MOUSEACTIVATE: MA_NOACTIVATE
            base.WndProc(ref m);
        }

        public void Present(Bitmap image, int x, int y, byte alpha)
        {
            IntPtr screen = Native.GetDC(IntPtr.Zero), memory = Native.CreateCompatibleDC(screen);
            IntPtr bitmap = image.GetHbitmap(Color.FromArgb(0)), old = Native.SelectObject(memory, bitmap);
            try
            {
                var at = new POINT { X = x, Y = y };
                var origin = new POINT();
                var size = new SIZE { cx = image.Width, cy = image.Height };
                var blend = new BLENDFUNCTION { SourceConstantAlpha = alpha, AlphaFormat = 1 };
                Native.UpdateLayeredWindow(Handle, screen, ref at, ref size, memory, ref origin, 0, ref blend, 2);
            }
            finally
            {
                Native.SelectObject(memory, old);
                Native.DeleteObject(bitmap);
                Native.DeleteDC(memory);
                Native.ReleaseDC(IntPtr.Zero, screen);
            }
        }

        /// <summary>Change the whole window's opacity without resending the bitmap.</summary>
        public void Fade(byte alpha)
        {
            var blend = new BLENDFUNCTION { SourceConstantAlpha = alpha, AlphaFormat = 1 };
            Native.UpdateLayeredWindowAlpha(Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref blend, 2);
        }

        public void MoveTo(int x, int y)
        {
            Native.SetWindowPos(Handle, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010); // NOSIZE | NOZORDER | NOACTIVATE
        }
    }

    /// <summary>The control bar, and the owner of the other three layers and the Esc hotkey.</summary>
    public class Banner : Layer
    {
        static readonly Color Bar = Color.FromArgb(7, 7, 7), Edge = Color.FromArgb(40, 40, 42), Key = Color.FromArgb(36, 36, 36), KeyHover = Color.FromArgb(54, 54, 54);
        static readonly Color Blue = Color.FromArgb(81, 154, 251), Coral = Color.FromArgb(245, 114, 97), Glow = Color.FromArgb(17, 120, 230);

        readonly string caption;
        readonly bool inFrames;
        readonly Layer edge = new Layer(true), halo = new Layer(true), tag = new Layer(true);
        readonly Timer hideTimer = new Timer(), animation = new Timer();
        IntPtr handle;
        bool hotkey;
        float scale = 1;
        int barX, barY, haloSize, frame, lastX = int.MinValue, lastY;
        Rectangle takeOver, stop;
        string hovered, label;
        public bool Pinned; // something is held, so Esc has to keep working

        public Banner(string caption, bool inFrames) : base(false)
        {
            this.caption = caption;
            this.inFrames = inFrames;
            Text = "desk-pilot overlay";
            hideTimer.Interval = 2000;
            hideTimer.Tick += delegate { hideTimer.Stop(); HideNow(); };
            animation.Interval = 33;
            animation.Tick += delegate { Tick(); };
            handle = Handle;
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0312 && m.WParam.ToInt32() == 1) Program.OnEsc();
            base.WndProc(ref m);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            var over = takeOver.Contains(e.Location) ? "takeOver" : stop.Contains(e.Location) ? "stop" : null;
            if (over != hovered) { hovered = over; DrawBar(); }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hovered != null) { hovered = null; DrawBar(); }
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (e.Button == MouseButtons.Left && (takeOver.Contains(e.Location) || stop.Contains(e.Location))) Program.OnEsc();
        }

        /// <summary>Let clicks fall through the bar while Claude's own pointer action runs. Any thread.</summary>
        public void PassThrough(bool on)
        {
            var style = Native.GetWindowLongPtrW(handle, -20).ToInt64();
            Native.SetWindowLongPtrW(handle, -20, new IntPtr(on ? style | 0x20 : style & ~0x20L));
        }

        public void ShowLabel(string text)
        {
            text = string.IsNullOrWhiteSpace(text) ? null : text.Trim();
            if (text != null && text.Length > 60) text = text.Substring(0, 60) + "…";
            if (text == label) return;
            label = text;
            if (!Visible) return;
            DrawTag();
        }

        public void ShowBanner()
        {
            hideTimer.Stop();
            if (Visible) return;
            scale = Math.Max(1, Native.GetDpiForWindow(handle) / 96f);
            var screen = Screen.PrimaryScreen;
            using (var glow = EdgeGlow(screen.Bounds.Width, screen.Bounds.Height, (int)(72 * scale)))
                edge.Present(glow, screen.Bounds.Left, screen.Bounds.Top, 255);
            haloSize = (int)(350 * scale);
            using (var soft = PointerHalo(haloSize, scale)) halo.Present(soft, 0, 0, 255);
            DrawBar();
            lastX = int.MinValue;
            Tick();
            foreach (var layer in new[] { edge, halo, tag, (Layer)this })
            {
                layer.Show();
                // WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+): nothing here reaches a frame.
                if (!inFrames) Native.SetWindowDisplayAffinity(layer.Handle, 0x11);
            }
            DrawTag();
            animation.Start();
            if (!hotkey) hotkey = Native.RegisterHotKey(handle, 1, 0x4000, 0x1B);
        }

        public void HideSoon()
        {
            if (!Visible || Pinned) return;
            hideTimer.Stop();
            hideTimer.Start();
        }

        public void HideNow()
        {
            hideTimer.Stop();
            animation.Stop();
            label = null;
            if (hotkey) { Native.UnregisterHotKey(handle, 1); hotkey = false; }
            foreach (var layer in new[] { edge, halo, tag, (Layer)this }) if (layer.Visible) layer.Hide();
        }

        void Tick()
        {
            frame++;
            POINT p;
            if (Native.GetCursorPos(out p) && (p.X != lastX || p.Y != lastY))
            {
                lastX = p.X;
                lastY = p.Y;
                halo.MoveTo(p.X - haloSize / 2, p.Y - haloSize / 2);
                tag.MoveTo(p.X + (int)(16 * scale), p.Y + (int)(14 * scale));
            }
            if (frame % 2 == 0) edge.Fade((byte)(195 + 60 * Math.Sin(frame * 0.05)));
            if (frame % 3 == 0 && Visible) DrawBar();
        }

        static Font Type(string family, float px)
        {
            return new Font(family, px, FontStyle.Regular, GraphicsUnit.Pixel);
        }

        static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            float d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        static void Smooth(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAlias;
        }

        void DrawKey(Graphics g, Rectangle box, string text, Font font, Color ink, bool hover)
        {
            using (var path = Rounded(box, box.Height * 0.34f))
            using (var fill = new SolidBrush(hover ? KeyHover : Key)) g.FillPath(fill, path);
            using (var brush = new SolidBrush(ink))
            using (var centre = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                g.DrawString(text, font, brush, box, centre);
        }

        void DrawSpinner(Graphics g, float x, float y)
        {
            float inner = 7 * scale, outer = 11.5f * scale;
            for (int i = 0; i < 8; i++)
            {
                double angle = i * Math.PI / 4;
                int age = (i - frame / 3 % 8 + 8) % 8;
                using (var pen = new Pen(Color.FromArgb(70 + age * 26, 255, 255, 255), 2 * scale))
                {
                    pen.StartCap = pen.EndCap = LineCap.Round;
                    float cos = (float)Math.Cos(angle), sin = (float)Math.Sin(angle);
                    g.DrawLine(pen, x + cos * inner, y + sin * inner, x + cos * outer, y + sin * outer);
                }
            }
            float s = scale;
            g.FillPolygon(Brushes.White, new[] { new PointF(x - 2.5f * s, y - 3.5f * s), new PointF(x + 6 * s, y + 1 * s), new PointF(x + 1.5f * s, y + 2.5f * s), new PointF(x + 0.5f * s, y + 7 * s) });
        }

        /// <summary>Same layout as ego lite's bar: grip, spinner, two lines of text, two keys.</summary>
        void DrawBar()
        {
            float s = scale;
            using (var title = Type("Segoe UI Semibold", 15 * s))
            using (var line = Type("Segoe UI", 13.5f * s))
            using (var keyFont = Type("Segoe UI", 14 * s))
            using (var probe = new Bitmap(1, 1))
            using (var measure = Graphics.FromImage(probe))
            {
                const string name = "desk-pilot";
                int textWidth = (int)Math.Ceiling(Math.Max(measure.MeasureString(name, title).Width, measure.MeasureString(caption, line).Width));
                int textX = (int)(66 * s), height = (int)(64 * s), keyH = (int)(35 * s), keyY = (height - keyH) / 2;
                int takeW = (int)(80 * s), stopW = (int)(48 * s), gap = (int)(7 * s);
                int width = textX + textWidth + (int)(16 * s) + takeW + gap + stopW + (int)(11 * s);
                takeOver = new Rectangle(width - (int)(11 * s) - stopW - gap - takeW, keyY, takeW, keyH);
                stop = new Rectangle(width - (int)(11 * s) - stopW, keyY, stopW, keyH);
                var work = Screen.PrimaryScreen.WorkingArea;
                barX = work.Left + (work.Width - width) / 2;
                barY = work.Bottom - height - (int)(20 * s);
                using (var image = new Bitmap(width, height, PixelFormat.Format32bppArgb))
                using (var g = Graphics.FromImage(image))
                {
                    Smooth(g);
                    var box = new RectangleF(0.5f, 0.5f, width - 1, height - 1);
                    using (var path = Rounded(box, height / 2f - 1))
                    using (var fill = new SolidBrush(Bar))
                    using (var border = new Pen(Edge, Math.Max(1, s)))
                    {
                        g.FillPath(fill, path);
                        g.DrawPath(border, path);
                    }
                    using (var grip = new SolidBrush(Color.FromArgb(82, 82, 84)))
                    {
                        g.FillRectangle(grip, 12 * s, height / 2f - 5 * s, 2 * s, 10 * s);
                        g.FillRectangle(grip, 16.5f * s, height / 2f - 5 * s, 2 * s, 10 * s);
                    }
                    DrawSpinner(g, 41 * s, height / 2f);
                    g.DrawString(name, title, Brushes.White, textX - 3 * s, 10 * s);
                    using (var blue = new SolidBrush(Blue)) g.DrawString(caption, line, blue, textX - 3 * s, 33 * s);
                    DrawKey(g, takeOver, "Take over", keyFont, Color.FromArgb(235, 235, 235), hovered == "takeOver");
                    DrawKey(g, stop, "Stop", keyFont, Coral, hovered == "stop");
                    Present(image, barX, barY, 255);
                }
            }
        }

        void DrawTag()
        {
            if (label == null) { if (tag.Visible) tag.Hide(); return; }
            float s = scale;
            using (var font = Type("Segoe UI", 13.5f * s))
            using (var probe = new Bitmap(1, 1))
            using (var measure = Graphics.FromImage(probe))
            {
                var size = measure.MeasureString(label, font);
                int width = (int)Math.Ceiling(size.Width + 20 * s), height = (int)(28 * s);
                using (var image = new Bitmap(width, height, PixelFormat.Format32bppArgb))
                using (var g = Graphics.FromImage(image))
                {
                    Smooth(g);
                    using (var path = Rounded(new RectangleF(0.5f, 0.5f, width - 1, height - 1), height / 2f - 1))
                    using (var fill = new SolidBrush(Color.FromArgb(235, 36, 36, 36)))
                    using (var border = new Pen(Edge, Math.Max(1, s)))
                    {
                        g.FillPath(fill, path);
                        g.DrawPath(border, path);
                    }
                    using (var ink = new SolidBrush(Color.FromArgb(235, 235, 235)))
                    using (var centre = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                        g.DrawString(label, font, ink, new RectangleF(0, 0, width, height), centre);
                    POINT p;
                    Native.GetCursorPos(out p);
                    tag.Present(image, p.X + (int)(16 * s), p.Y + (int)(14 * s), 255);
                }
            }
            if (!tag.Visible) tag.Show();
        }

        static Bitmap FromPixels(int[] pixels, int width, int height)
        {
            var image = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            var data = image.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            image.UnlockBits(data);
            return image;
        }

        /// <summary>Blue light that fades inward from every edge, rounded at the corners.</summary>
        static Bitmap EdgeGlow(int width, int height, int band)
        {
            var pixels = new int[width * height];
            int rgb = Glow.ToArgb() & 0xFFFFFF;
            for (int y = 0; y < height; y++)
            {
                int ey = Math.Max(0, band - Math.Min(y, height - 1 - y));
                for (int x = 0; x < width; x++)
                {
                    int ex = Math.Max(0, band - Math.Min(x, width - 1 - x));
                    if (ex == 0 && ey == 0) continue;
                    double reach = Math.Min(1, Math.Sqrt(ex * ex + ey * ey) / band);
                    pixels[y * width + x] = (int)(190 * Math.Pow(reach, 2.4)) << 24 | rgb;
                }
            }
            return FromPixels(pixels, width, height);
        }

        /// <summary>The soft white light around the pointer, and ego lite's dark arrow over it, tip on the hot spot.
        /// The arrow also keeps the pointer in screenshots, which leave the real one out.</summary>
        static Bitmap PointerHalo(int size, float scale)
        {
            var pixels = new int[size * size];
            double radius = size / 2.0;
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    double dx = x - radius, dy = y - radius, r = Math.Sqrt(dx * dx + dy * dy) / radius;
                    if (r < 1) pixels[y * size + x] = (int)(92 * Math.Pow(1 - r, 3)) << 24 | 0xFFFFFF;
                }
            }
            var image = FromPixels(pixels, size, size);
            using (var g = Graphics.FromImage(image))
            using (var fill = new SolidBrush(Color.FromArgb(18, 18, 20)))
            using (var outline = new Pen(Color.White, 1.6f * scale) { LineJoin = LineJoin.Round })
            {
                Smooth(g);
                float c = size / 2f, s = scale;
                var arrow = new[] { new PointF(c, c), new PointF(c + 17 * s, c + 6.5f * s), new PointF(c + 9 * s, c + 9 * s), new PointF(c + 6.5f * s, c + 17 * s) };
                g.FillPolygon(fill, arrow);
                g.DrawPolygon(outline, arrow);
            }
            return image;
        }
    }
}
