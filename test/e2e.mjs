// End-to-end test of desk-pilot through the real MCP protocol.
//
// Starts dist/server.mjs as Claude Code would (stdio) and drives it only against
// throwaway windows it creates: a main form that logs everything it receives, and a
// second window of the same process that hands the foreground straight back. The log
// proves what happened and in which order.
//
// Usage: node test/e2e.mjs   (needs an interactive Windows desktop)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A hung step must fail the run, not stall it.
setTimeout(() => {
	console.log('FAIL the whole run took longer than 3 minutes');
	process.exit(2);
}, 180000).unref();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'desk-e2e-'));
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const measurements = {};
let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` - ${detail}`}`);
	if (!ok) failures += 1;
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const textOf = (r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const imageOf = (r) => r.content.find((b) => b.type === 'image');
const pngSize = (b64) => {
	const bytes = Buffer.from(b64, 'base64');
	return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20), bytes: bytes.length };
};

// ── throwaway windows ───────────────────────────────────────────────────────
const stamp = Math.random().toString(36).slice(2, 8);
const title = `desk-e2e café ${stamp}`;
const thiefTitle = `desk-thief ${stamp}`;
const canvasTitle = `desk-canvas ${stamp}`;
const logFile = join(work, 'log.txt');
const readyFile = join(work, 'ready.txt');
const rawFile = join(work, 'raw.txt');
writeFileSync(logFile, '', 'utf8');
const formScript = `
# Per-monitor DPI aware, like a modern app: Windows then sizes the form in exact
# physical pixels instead of scaling a 96-DPI window by 1.5.
Add-Type -Namespace DeskE2e -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);'
$null = [DeskE2e.Dpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName System.Windows.Forms
# Counts raw mouse input, which real input events reach and SetCursorPos does not.
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Windows.Forms;
namespace DeskE2e { public class Raw : NativeWindow {
	[StructLayout(LayoutKind.Sequential)] struct D { public ushort Page, Usage; public uint Flags; public IntPtr Target; }
	[DllImport("user32.dll")] static extern bool RegisterRawInputDevices(D[] d, uint n, uint s);
	public int Count;
	public Raw() { CreateHandle(new CreateParams()); var d = new D { Page = 1, Usage = 2, Flags = 0x100, Target = Handle }; RegisterRawInputDevices(new[] { d }, 1, (uint)Marshal.SizeOf(typeof(D))); }
	protected override void WndProc(ref Message m) { if (m.Msg == 0xFF) Count++; base.WndProc(ref m); }
} }
'@
$raw = New-Object DeskE2e.Raw
$rawTimer = New-Object System.Windows.Forms.Timer; $rawTimer.Interval = 100
$rawTimer.Add_Tick({ [System.IO.File]::WriteAllText('${rawFile}', [string]$raw.Count) }); $rawTimer.Start()
$log = '${logFile}'
function W([string] $m) { [System.IO.File]::AppendAllText($log, $m + [char]10, (New-Object System.Text.UTF8Encoding($false))) }
function B([string] $text, [int] $x, [int] $y) { $b = New-Object System.Windows.Forms.Button; $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Width = 96; $b.Add_Click({ $m = [System.Windows.Forms.Control]::ModifierKeys; if ($m -ne 'None') { W ('click ' + $this.Text + ' mods=' + $m) } else { W ('click ' + $this.Text) } }.GetNewClosure()); $form.Controls.Add($b); return $b }
$form = New-Object System.Windows.Forms.Form
$form.Text = '${title}'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(140, 140)
$form.Size = New-Object System.Drawing.Size(640, 300)
$box = New-Object System.Windows.Forms.TextBox
$box.AccessibleName = 'Input'
$box.Location = New-Object System.Drawing.Point(12, 12)
$box.Width = 560
$box.Add_KeyDown({ if ($_.KeyCode -eq 'Enter') { W ('enter:' + $box.Text); $_.SuppressKeyPress = $true } })
$box.Add_TextChanged({ W ('text:' + $box.Text) })
$form.Controls.Add($box)
$check = New-Object System.Windows.Forms.CheckBox
$check.Text = 'Remember'; $check.Location = New-Object System.Drawing.Point(12, 44)
$check.Add_CheckedChanged({ W ('checked:' + $check.Checked) })
$form.Controls.Add($check)
$alpha = B 'Alpha' 12 80
$beta = B 'Beta' 116 80
$swap = New-Object System.Windows.Forms.Button; $swap.Text = 'Swap'; $swap.Location = New-Object System.Drawing.Point(220, 80); $swap.Width = 96
$swap.Add_Click({ $t = $alpha.Text; $alpha.Text = $beta.Text; $beta.Text = $t; W 'swapped' }); $form.Controls.Add($swap)
$null = B 'Same' 12 120
$null = B 'Same' 116 120
$locked = B 'Locked' 220 120; $locked.Enabled = $false
$delayed = B 'Delayed' 324 120; $delayed.Visible = $false
$later = New-Object System.Windows.Forms.Button; $later.Text = 'Show later'; $later.Location = New-Object System.Drawing.Point(324, 80); $later.Width = 96
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 1200
$timer.Add_Tick({ $timer.Stop(); $delayed.Visible = $true; W 'delayed shown' })
$later.Add_Click({ W 'click Show later'; $timer.Start() }); $form.Controls.Add($later)
$thief = New-Object System.Windows.Forms.Form
$thief.Text = '${thiefTitle}'
$thief.StartPosition = 'Manual'
$thief.Location = New-Object System.Drawing.Point(840, 140)
$thief.Size = New-Object System.Drawing.Size(320, 180)
$thief.BackColor = [System.Drawing.Color]::FromArgb(40, 90, 160)
$thief.Add_Activated({ W 'thief activated'; $null = $form.BeginInvoke([Action] { $form.Activate() }) })
$canvas = New-Object System.Windows.Forms.Form
$canvas.Text = '${canvasTitle}'
$canvas.StartPosition = 'Manual'
$canvas.Location = New-Object System.Drawing.Point(140, 660)
$canvas.Size = New-Object System.Drawing.Size(740, 420)
$canvas.KeyPreview = $true
$canvas.Add_KeyDown({ W ('keydown ' + $_.KeyCode) })
$canvas.Add_KeyUp({ W ('keyup ' + $_.KeyCode) })
$pad = New-Object System.Windows.Forms.Panel
$pad.AccessibleName = 'Pad'
$pad.Location = New-Object System.Drawing.Point(10, 10)
$pad.Size = New-Object System.Drawing.Size(460, 350)
$pad.BackColor = [System.Drawing.Color]::White
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(30, 60, 200), 2)
$script:pts = New-Object System.Collections.Generic.List[string]
$script:prev = $null
$script:pressedAt = 0
$pad.Add_MouseDown({ $script:pts.Clear(); $script:pts.Add(('{0},{1}' -f $_.X, $_.Y)); $script:prev = $_.Location; $script:pressedAt = [Environment]::TickCount; W ('down ' + $_.Button) })
$pad.Add_MouseMove({ if ($_.Button -ne 'None') { $script:pts.Add(('{0},{1}' -f $_.X, $_.Y)); $g = $pad.CreateGraphics(); $g.DrawLine($pen, $script:prev, $_.Location); $g.Dispose(); $script:prev = $_.Location } })
$pad.Add_MouseUp({ W ('up ' + $_.Button + ' ms=' + ([Environment]::TickCount - $script:pressedAt) + ' pts=' + ($script:pts -join ';')) })
$canvas.Controls.Add($pad)
$source = New-Object System.Windows.Forms.Button
$source.Text = 'Drag me'; $source.Location = New-Object System.Drawing.Point(500, 20); $source.Width = 120
$source.Add_MouseDown({ if ($_.Button -eq 'Left') { $done = $source.DoDragDrop('payload', [System.Windows.Forms.DragDropEffects]::Copy); W ('drag finished ' + $done) } })
$canvas.Controls.Add($source)
$drop = New-Object System.Windows.Forms.Panel
$drop.AccessibleName = 'Drop here'
$drop.AllowDrop = $true
$drop.Location = New-Object System.Drawing.Point(500, 100)
$drop.Size = New-Object System.Drawing.Size(200, 140)
$drop.BackColor = [System.Drawing.Color]::LightGray
$drop.Add_DragEnter({ $_.Effect = [System.Windows.Forms.DragDropEffects]::Copy })
$drop.Add_DragDrop({ W ('dropped ' + $_.Data.GetData([string]) + ' keys=' + $_.KeyState) })
$canvas.Controls.Add($drop)
$form.Add_Shown({ $thief.Show(); $canvas.Show(); $form.Activate(); [System.IO.File]::WriteAllText('${readyFile}', ('{0}|0x{1:X}|0x{2:X}' -f $PID, $form.Handle.ToInt64(), $thief.Handle.ToInt64())) })
[System.Windows.Forms.Application]::Run($form)
`;
const formPath = join(work, 'throwaway.ps1');
writeFileSync(formPath, `﻿${formScript}`, 'utf8');
// Not windowsHide: Windows would apply that SW_HIDE to the first form shown.
spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', formPath], { stdio: 'ignore' });
for (let waited = 0; !existsSync(readyFile) && waited < 20000; waited += 100) await sleep(100);
const [windowPid, formHwnd, thiefHwnd] = existsSync(readyFile) ? readFileSync(readyFile, 'utf8').split('|') : [];
check('the throwaway windows came up', windowPid !== undefined, `pid=${windowPid} form=${formHwnd} thief=${thiefHwnd}`);
if (windowPid === undefined) process.exit(1);
await sleep(500);
const log = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean);

// ── server ──────────────────────────────────────────────────────────────────
async function startServer(env = {}) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(root, 'dist', 'server.mjs')],
		env: { ...process.env, DESK_PILOT_DATA_DIR: join(work, 'data'), ...env },
		stderr: 'pipe'
	});
	const client = new Client({ name: 'desk-e2e', version: '0' });
	await client.connect(transport);
	return { client, transport };
}
const call = (client, name, args, options) => client.callTool({ name, arguments: args }, undefined, { timeout: 60000, ...options });
async function timed(fn) {
	const t = performance.now();
	const value = await fn();
	return { value, ms: Math.round(performance.now() - t) };
}
function enginePids(serverPid) {
	const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
		`Get-CimInstance Win32_Process -Filter "ParentProcessId=${serverPid}" | Where-Object { $_.Name -like 'desk-engine-*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
	return out.split(/\s+/u).filter(Boolean).map(Number);
}
const kill = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });

const firstStart = performance.now();
const a = await startServer();
const serverPid = a.transport.pid;

const listed = await a.client.listTools();
check('exactly three tools', listed.tools.map((t) => t.name).sort().join(',') === 'desktop_control,desktop_sequence,screen_view');
check('screen_view is read-only', listed.tools.find((t) => t.name === 'screen_view')?.annotations?.readOnlyHint === true);
measurements.toolsListChars = JSON.stringify(listed.tools).length;

const firstCall = await timed(() => call(a.client, 'desktop_control', { action: 'windows', title: stamp }));
measurements.firstCallMs = firstCall.ms;
measurements.serverStartToFirstResultMs = Math.round(performance.now() - firstStart);
check('windows lists both throwaway windows', textOf(firstCall.value).includes(title) && textOf(firstCall.value).includes(thiefTitle), textOf(firstCall.value).split('\n').filter((l) => l.includes(stamp)).join(' | '));

// frames: any window (a process's second window too), dedup, diff, budget
const thiefShot = await call(a.client, 'screen_view', { window: thiefTitle, includeCursor: false });
const thiefImage = imageOf(thiefShot);
check('a second window of the same process can be framed by title', thiefImage !== undefined && /^<frame window /u.test(textOf(thiefShot)), textOf(thiefShot).split('\n')[0]);
check('a 1:1 frame states its origin', /1:1 with the screen: screen x = \d+ \+ image_x/u.test(textOf(thiefShot)), textOf(thiefShot).split('\n')[1]);
const again = await call(a.client, 'screen_view', { window: thiefTitle, includeCursor: false });
check('an identical frame is not re-sent', imageOf(again) === undefined && / unchanged /u.test(textOf(again)));
const forced = await call(a.client, 'screen_view', { window: thiefTitle, includeCursor: false, forceImage: true });
check('forceImage re-sends it', imageOf(forced) !== undefined);

const primaryTimes = [];
let primary;
for (let i = 0; i < 4; i += 1) {
	const shot = await timed(() => call(a.client, 'screen_view', { forceImage: true }));
	primaryTimes.push(shot.ms);
	primary = shot.value;
}
const primarySize = pngSize(imageOf(primary).data);
check('the primary frame fits the image budget', Math.max(primarySize.w, primarySize.h) <= 1568 && primarySize.w * primarySize.h <= 1150000, `${primarySize.w}x${primarySize.h}, ${primarySize.bytes} bytes`);
check('and the text gives the exact multiplier', new RegExp(`image ${primarySize.w}x${primarySize.h} shows \\d+x\\d+ screen pixels: screen x = image_x \\* [\\d.]+`, 'u').test(textOf(primary)), textOf(primary).split('\n')[1]);
measurements.primaryCapture = { delivered: `${primarySize.w}x${primarySize.h}`, pngBytes: primarySize.bytes, roundTripMs: primaryTimes, medianMs: median(primaryTimes.slice(1)) };
writeFileSync(join(work, 'primary.png'), Buffer.from(imageOf(primary).data, 'base64'));
const small = await call(a.client, 'screen_view', { maxEdge: 800, forceImage: true });
const smallSize = pngSize(imageOf(small).data);
check('maxEdge makes a smaller frame', Math.max(smallSize.w, smallSize.h) === 800, `${smallSize.w}x${smallSize.h}`);

// controls
const controlsRun = await timed(() => call(a.client, 'desktop_control', { action: 'controls', title }));
const controls = textOf(controlsRun.value);
writeFileSync(join(work, 'controls.txt'), controls, 'utf8');
const idx = (name) => Number(controls.match(new RegExp(`^(\\d+) \\[\\w+\\] '${name}'`, 'mu'))?.[1]);
check('controls lists the edit box by its name', /\[Edit\] 'Input'/u.test(controls), controls.split('\n').find((l) => l.includes('Input')));
check('controls lists buttons, check box state and disabled state', /\[Button\] 'Alpha'/u.test(controls) && /\[CheckBox\] 'Remember'.* off/u.test(controls) && /'Locked'.* disabled/u.test(controls));
check('controls hides the invisible button', !/'Delayed'/u.test(controls));
measurements.controls = { ms: controlsRun.ms, chars: controls.length, lines: controls.split('\n').length };

// targets by name
let before = log().length;
const alpha = await call(a.client, 'desktop_control', { action: 'click', title, target: 'Alpha', role: 'Button' });
await sleep(250);
check('a name target clicks that control', !alpha.isError && log().slice(before).includes('click Alpha'), textOf(alpha).split('\n')[0]);
const same = await call(a.client, 'desktop_control', { action: 'click', title, target: 'Same' });
check('an ambiguous name is refused with the candidates', same.isError === true && /2 controls match 'Same'/u.test(textOf(same)), textOf(same).slice(0, 140));
before = log().length;
const locked = await call(a.client, 'desktop_control', { action: 'click', title, target: 'Locked' });
await sleep(250);
check('a disabled control is refused, not clicked', locked.isError === true && /disabled/u.test(textOf(locked)) && log().length === before, textOf(locked).slice(0, 120));
const remember = await call(a.client, 'desktop_control', { action: 'click', title, target: 'Remember' });
check('a check box click reports its new state', /'Remember' is now on/u.test(textOf(remember)), textOf(remember).split('\n').slice(1).join(' | '));

// stale index
await call(a.client, 'desktop_control', { action: 'controls', title });
const alphaIndex = idx('Alpha');
await call(a.client, 'desktop_control', { action: 'click', title, target: 'Swap' });
await sleep(250);
before = log().length;
const stale = await call(a.client, 'desktop_control', { action: 'click', title, target: alphaIndex });
await sleep(250);
check('a stale index fails loudly and clicks nothing', stale.isError === true && /not the one that was listed: expected \[Button\] 'Alpha', found \[Button\] 'Beta'/u.test(textOf(stale)) && log().length === before, textOf(stale).slice(0, 160));
await call(a.client, 'desktop_control', { action: 'click', title, target: 'Swap' });

// type, verified; then a diff frame of the window shows only the box
await call(a.client, 'screen_view', { window: title, includeCursor: false, forceImage: true });
const typed = await call(a.client, 'desktop_control', { action: 'type', title, target: 'Input', text: 'café naïve abc' });
await sleep(250);
check('type into a named control is read back and verified', /typed: verified/u.test(textOf(typed)) && log().includes('text:café naïve abc'), textOf(typed).split('\n').slice(0, 2).join(' | '));
const diffShot = await call(a.client, 'screen_view', { window: title, includeCursor: false, diff: true });
const diffImage = imageOf(diffShot);
const diffSize = diffImage ? pngSize(diffImage.data) : undefined;
check('diff sends only the changed region', diffImage !== undefined && / changed-only/u.test(textOf(diffShot)) && diffSize.w * diffSize.h < 0.3 * 960 * 450, diffSize ? `${diffSize.w}x${diffSize.h}; ${textOf(diffShot).split('\n')[2]}` : textOf(diffShot));
measurements.diffFrame = diffSize;

// a checked batch with waitFor
before = log().length;
const batch = await timed(() => call(a.client, 'desktop_sequence', {
	steps: [
		{ action: 'focus', title },
		{ action: 'click', target: 'Show later', title },
		{ action: 'waitFor', title, expect: { exists: 'Delayed' } },
		{ action: 'click', target: 'Delayed', title },
		{ action: 'type', target: 'Input', title, text: ' + more', expect: { value: 'more' } },
		{ action: 'key', key: 'enter', title }
	],
	capture: 'window'
}));
await sleep(300);
const batchText = textOf(batch.value);
check('a six-step batch with waitFor runs every step', /done=6\/6/u.test(batchText), batchText.split('\n').filter((l) => l.startsWith('#')).join(' | '));
check('in order, as the window saw it', ['click Show later', 'delayed shown', 'click Delayed'].every((line) => log().slice(before).includes(line)) && log().slice(before).some((line) => line.startsWith('enter:') && line.endsWith('+ more')), log().slice(before).join(' | '));
check('the batch ends with one frame', imageOf(batch.value) !== undefined, textOf(batch.value).split('\n').find((l) => l.startsWith('<end-frame')));
measurements.batch6 = { roundTripMs: batch.ms, chars: batchText.length };

// an unmet expectation stops the batch
before = log().length;
const unmet = await call(a.client, 'desktop_sequence', {
	steps: [{ action: 'click', target: 'Beta', title, expect: { exists: 'Nope', timeoutMs: 300 } }, { action: 'type', target: 'Input', title, text: 'SHOULD-NOT' }],
	capture: 'none'
});
await sleep(250);
check('an unmet expect fails its step and stops the batch', /#1 click FAILED .*expectation not met within 300 ms: no control named 'Nope'/u.test(textOf(unmet)) && /1 step\(s\) not run/u.test(textOf(unmet)) && !log().slice(before).some((l) => l.includes('SHOULD-NOT')), textOf(unmet).split('\n').slice(1, 3).join(' | '));

// a refused focus stops the batch
before = log().length;
const refused = await call(a.client, 'desktop_sequence', { steps: [{ action: 'focus', hwnd: thiefHwnd }, { action: 'type', text: 'WRONG' }], capture: 'none' });
await sleep(300);
check('a refused focus fails and nothing is typed', /#1 focus FAILED .*could not bring 'desk-thief/u.test(textOf(refused)) && !log().slice(before).some((l) => l.includes('WRONG')), textOf(refused).split('\n')[1]);

// risk gate and hook
const medium = await call(a.client, 'desktop_sequence', { steps: [{ action: 'type', text: 'RISKY' }], risk: 'medium' });
check('a medium batch without confirm is refused', medium.isError === true && /refused before touching the desktop: this batch is medium risk/u.test(textOf(medium)));
const high = await call(a.client, 'desktop_sequence', { steps: [{ action: 'key', key: 'enter', risk: 'high', riskNote: 'sends it' }] });
check('a high step without confirm is refused and named', high.isError === true && /#1 key \(sends it\)/u.test(textOf(high)));
const dry = await call(a.client, 'desktop_sequence', { steps: [{ action: 'type', text: 'RISKY', risk: 'high', target: 'Input' }], confirm: true, dryRun: true });
check('dryRun lists the plan without acting', /dry-run/u.test(textOf(dry)) && /1\. type 'Input' "RISKY" \[high\]/u.test(textOf(dry)) && !log().some((l) => l.includes('RISKY')), textOf(dry).split('\n')[1]);
const hook = (input) => {
	const run = spawnSync(process.execPath, [join(root, 'hooks', 'risk-gate.mjs')], { input: JSON.stringify({ tool_input: input }), encoding: 'utf8' });
	return run.stdout.trim();
};
const hookStarted = performance.now();
const asked = hook({ steps: [{ action: 'key', key: 'enter', risk: 'high', riskNote: 'sends it' }], confirm: true });
measurements.hookMs = Math.round(performance.now() - hookStarted);
check('the hook asks for a confirmed high batch', JSON.parse(asked || '{}').hookSpecificOutput?.permissionDecision === 'ask', `${measurements.hookMs} ms`);
check('the hook is silent for low, unconfirmed and dry-run batches', hook({ steps: [{ action: 'wait', ms: 1 }] }) === '' && hook({ steps: [{ action: 'wait', ms: 1 }], risk: 'high' }) === '' && hook({ steps: [{ action: 'wait', ms: 1 }], risk: 'high', confirm: true, dryRun: true }) === '');

// Esc mid-batch, and the banner stays out of frames
before = log().length;
const esc = spawn('powershell.exe', ['-NoProfile', '-Command',
	"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DeskEsc { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e); }'; Start-Sleep -Milliseconds 2500; [DeskEsc]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); [DeskEsc]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)"], { stdio: 'ignore' });
// Listen now: the helper may exit before the batch returns.
const escSent = new Promise((resolvePromise) => esc.on('close', resolvePromise));
const escStarted = performance.now();
const escRun = call(a.client, 'desktop_sequence', { steps: [{ action: 'focus', title }, { action: 'wait', ms: 9000 }, { action: 'type', target: 'Input', title, text: 'LATE' }], capture: 'none' });
await sleep(1500);
const bannerShot = await call(a.client, 'screen_view', { region: '0,0,2560,160', forceImage: true, rulers: false });
writeFileSync(join(work, 'banner-region.png'), Buffer.from(imageOf(bannerShot)?.data ?? '', 'base64'));
const escResult = await escRun;
const escMs = Math.round(performance.now() - escStarted);
await escSent;
await sleep(400);
check('Esc stops the batch in the middle of a wait', /stopped: the person pressed Esc/u.test(textOf(escResult)) && escMs < 6000, `${escMs} ms for a 9 s wait`);
check('nothing after Esc ran', !log().slice(before).some((l) => l.includes('LATE')));
measurements.escStopMs = escMs;

// MCP cancellation (what an interrupted Claude Code turn sends)
before = log().length;
const controller = new AbortController();
const cancelRun = call(a.client, 'desktop_sequence', { steps: [{ action: 'wait', ms: 4000 }, { action: 'type', target: 'Input', title, text: 'CANCELLED' }], capture: 'none' }, { signal: controller.signal });
await sleep(800);
controller.abort();
let cancelError;
try {
	await cancelRun;
} catch (error) {
	cancelError = error;
}
await sleep(4000);
check('a cancelled call rejects and its batch stops', cancelError !== undefined && !log().slice(before).some((l) => l.includes('CANCELLED')), cancelError?.message);

// modifier clicks: held for the click, released afterwards
before = log().length;
const ctrlClick = await call(a.client, 'desktop_control', { action: 'click', title, target: 'Alpha', modifiers: ['ctrl'] });
await call(a.client, 'desktop_control', { action: 'click', title, target: 'Alpha', modifiers: ['shift'] });
await call(a.client, 'desktop_sequence', { steps: [{ action: 'click', title, target: 'Alpha', modifiers: ['ctrl', 'shift'] }, { action: 'click', title, target: 'Alpha' }], capture: 'none' });
await sleep(300);
const modLog = log().slice(before);
check('ctrl+click reaches the control with ctrl held', modLog.includes('click Alpha mods=Control') && /with ctrl/u.test(textOf(ctrlClick)), modLog.join(' | '));
check('shift+click and ctrl+shift+click too', modLog.includes('click Alpha mods=Shift') && modLog.includes('click Alpha mods=Shift, Control'));
check('modifiers are released afterwards (the next plain click has none)', modLog.at(-1) === 'click Alpha', modLog.at(-1));
const badMods = await call(a.client, 'desktop_control', { action: 'move', x: 10, y: 10, modifiers: ['ctrl'] });
check('modifiers on a move are refused', badMods.isError === true && /modifiers apply to clicks/u.test(textOf(badMods)));

// window: move/resize the visible frame, then maximize, minimize and restore
const boundsOf = async () => textOf(await call(a.client, 'desktop_control', { action: 'windows', title })).split('\n').find((l) => l.includes(title)) ?? '';
// The throwaway form runs in DPI-unaware Windows PowerShell, so at 150% scaling Windows
// can only give it widths in 1.5-pixel steps: accept 2 px of slack, but only when the
// result says so instead of claiming the exact size.
const frameOf = (line) => (line.match(/@ (-?\d+),(-?\d+),(\d+),(\d+)/u) ?? []).slice(1).map(Number);
const near = (line, [x, y, w, h]) => {
	const [bx, by, bw, bh] = frameOf(line);
	return bx === x && by === y && Math.abs(bw - w) <= 2 && Math.abs(bh - h) <= 2;
};
const exact = (line, [x, y, w, h]) => line.includes(`@ ${x},${y},${w},${h}`);
const placed = await call(a.client, 'desktop_control', { action: 'window', title, x: 200, y: 180, width: 900, height: 480 });
const placedAt = await boundsOf();
check('window moves and resizes the visible frame, and says so when the app snaps it', !placed.isError && near(placedAt, [200, 180, 900, 480]) && (exact(placedAt, [200, 180, 900, 480]) || /the window settled at/u.test(textOf(placed))), `${placedAt} | ${textOf(placed).split('\n').slice(1).join(' ')}`);
await call(a.client, 'desktop_control', { action: 'window', title, show: 'maximize' });
check('maximize', (await boundsOf()).includes('maximized'), await boundsOf());
await call(a.client, 'desktop_control', { action: 'window', title, show: 'minimize' });
check('minimize', (await boundsOf()).includes('minimized'), await boundsOf());
await call(a.client, 'desktop_control', { action: 'window', title, show: 'restore' });
check('restore from minimized brings it back maximized', (await boundsOf()).includes('maximized'), await boundsOf());
await call(a.client, 'desktop_control', { action: 'window', title, show: 'restore' });
check('restore again returns it to its normal frame', (await boundsOf()).includes(`@ ${frameOf(placedAt).join(',')}`) && !/maximized|minimized/u.test(await boundsOf()), await boundsOf());
const inBatch = await call(a.client, 'desktop_sequence', { steps: [{ action: 'window', title, x: 140, y: 140 }, { action: 'click', title, target: 'Alpha' }], capture: 'none' });
check('window works as a batch step, and controls still resolve after the move', /done=2\/2/u.test(textOf(inBatch)) && (await boundsOf()).includes(`@ 140,140,${frameOf(placedAt)[2]},${frameOf(placedAt)[3]}`), textOf(inBatch).split('\n').slice(1, 3).join(' | '));
const noArgs = await call(a.client, 'desktop_control', { action: 'window', title });
check('window with nothing to do is refused', noArgs.isError === true && /needs show/u.test(textOf(noArgs)));

// drawing, dragging and holding, on a pad that records every point it receives
const canvasControls = textOf(await call(a.client, 'desktop_control', { action: 'controls', title: canvasTitle, bounds: true }));
const boxOf = (name) => (canvasControls.match(new RegExp(`'${name}'.*? @ (-?\\d+),(-?\\d+) (\\d+)x(\\d+)`, 'u')) ?? []).slice(1).map(Number);
const [padX, padY] = boxOf('Pad');
check('the pad is listed as a control', Number.isInteger(padX), canvasControls.split('\n').find((l) => l.includes("'Pad'")));
const onPad = ([x, y]) => [padX + x, padY + y];
const strokeLines = (from) => log().slice(from).filter((l) => l.startsWith('up '));
const pointsOf = (line) => line.split('pts=')[1].split(';').map((p) => p.split(',').map(Number));
const heldMsOf = (line) => Number(line.match(/ms=(\d+)/u)?.[1]);
const toSegment = ([px, py], [ax, ay], [bx, by]) => {
	const dx = bx - ax;
	const dy = by - ay;
	const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
	return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
const toLine = (p, line) => Math.min(...line.slice(1).map((b, i) => toSegment(p, line[i], b)));

const zigzag = [[30, 40], [220, 40], [220, 200], [60, 200], [60, 90], [150, 90]];
before = log().length;
const drawn = await timed(() => call(a.client, 'desktop_control', { action: 'draw', title: canvasTitle, strokes: [zigzag.map(onPad)] }));
await sleep(300);
const zigzagLine = strokeLines(before)[0] ?? '';
const zigzagPoints = zigzagLine ? pointsOf(zigzagLine) : [];
const zigzagOff = Math.max(...zigzagPoints.map((p) => toLine(p, zigzag)));
const cornersOff = Math.max(...zigzag.map((v) => Math.min(...zigzagPoints.map(([x, y]) => Math.hypot(x - v[0], y - v[1])))));
check('draw follows a polyline point by point', /drew 1 stroke, 710 px/u.test(textOf(drawn.value)) && zigzagPoints.length > 40 && zigzagOff <= 1.5, `${zigzagPoints.length} points, worst ${zigzagOff.toFixed(1)} px off, ${drawn.ms} ms; ${textOf(drawn.value).split('\n')[0]}`);
check('and reaches every corner, without cutting it', cornersOff <= 4, `worst corner ${cornersOff.toFixed(1)} px`);
check('and ends exactly on the last point', zigzagPoints.at(-1)?.join() === zigzag.at(-1).join(), zigzagPoints.at(-1)?.join());
measurements.draw = { points: zigzagPoints.length, worstPx: Number(zigzagOff.toFixed(2)), worstCornerPx: Number(cornersOff.toFixed(2)), ms: drawn.ms };

const circle = Array.from({ length: 13 }, (_, i) => [230 + 90 * Math.cos(i * Math.PI / 6), 180 + 90 * Math.sin(i * Math.PI / 6)].map(Math.round));
before = log().length;
await call(a.client, 'desktop_control', { action: 'draw', title: canvasTitle, strokes: [circle.map(onPad)], smooth: true });
await sleep(300);
const circlePoints = strokeLines(before)[0] ? pointsOf(strokeLines(before)[0]) : [];
const circleOff = Math.max(...circlePoints.map(([x, y]) => Math.abs(Math.hypot(x - 230, y - 180) - 90)));
const straightOff = 90 - 90 * Math.cos(Math.PI / 12);
check('smooth curves through the points instead of cutting straight chords', circlePoints.length > 30 && circleOff < 2.5, `worst ${circleOff.toFixed(1)} px from the circle; 12 chords would sag ${straightOff.toFixed(1)} px`);
measurements.smoothCircleWorstPx = Number(circleOff.toFixed(2));

before = log().length;
await call(a.client, 'desktop_control', { action: 'draw', title: canvasTitle, strokes: [[[40, 300], [120, 300]].map(onPad), [[160, 300], [240, 300]].map(onPad), [[300, 300]].map(onPad)], button: 'right' });
await sleep(300);
const threeStrokes = strokeLines(before);
check('each stroke lifts the button, with a single point as a dot', threeStrokes.length === 3 && threeStrokes.every((l) => l.startsWith('up Right')) && pointsOf(threeStrokes[0])[0].join() === '40,300' && pointsOf(threeStrokes[1])[0].join() === '160,300', threeStrokes.map((l) => l.split(' pts=')[0]).join(' | '));
const typo = await call(a.client, 'desktop_sequence', { steps: [{ action: 'move', x: 10, y: 10, button2: 'left' }] });
check('a misspelled step field is refused before anything runs', typo.isError === true && /unknown field "button2"/u.test(textOf(typo)), textOf(typo));
const badDraw = await call(a.client, 'desktop_sequence', { steps: [{ action: 'draw', strokes: [] }] });
check('a draw with no strokes is refused before anything runs', badDraw.isError === true && /needs strokes/u.test(textOf(badDraw)));

before = log().length;
const paced = await timed(() => call(a.client, 'desktop_control', { action: 'drag', title: canvasTitle, x: onPad([40, 330])[0], y: onPad([40, 330])[1], toX: onPad([420, 330])[0], toY: onPad([420, 330])[1], durationMs: 900, holdMs: 200 }));
await sleep(300);
const pacedLine = strokeLines(before)[0] ?? '';
check('drag keeps to durationMs and holdMs', heldMsOf(pacedLine) >= 1050 && heldMsOf(pacedLine) < 1500 && pointsOf(pacedLine).length > 20, `${heldMsOf(pacedLine)} ms button down, ${pacedLine ? pointsOf(pacedLine).length : 0} points`);
measurements.pacedDragMs = heldMsOf(pacedLine);

before = log().length;
const dropped = await call(a.client, 'desktop_control', { action: 'drag', title: canvasTitle, target: 'Drag me', toTarget: 'Drop here' });
await sleep(400);
check('drag and drop between two controls, through the real Windows drop', log().slice(before).includes('dropped payload keys=0') && log().slice(before).includes('drag finished Copy') && /onto \[Pane\] 'Drop here'/u.test(textOf(dropped)), `${log().slice(before).join(' | ')} / ${textOf(dropped).split('\n')[0]}`);
before = log().length;
await call(a.client, 'desktop_sequence', { steps: [{ action: 'drag', title: canvasTitle, target: 'Drag me', toTarget: 'Drop here', modifiers: ['ctrl'] }], capture: 'none' });
await sleep(400);
check('ctrl stays held through the drop', (Number(log().slice(before).find((l) => l.startsWith('dropped'))?.split('keys=')[1]) & 8) === 8, log().slice(before).join(' | '));

const padCentre = onPad([230, 180]);
before = log().length;
await call(a.client, 'desktop_control', { action: 'click', title: canvasTitle, x: padCentre[0], y: padCentre[1], holdMs: 700 });
await sleep(250);
check('a long press stays down for holdMs', heldMsOf(strokeLines(before)[0] ?? '') >= 650, strokeLines(before)[0]?.split(' pts=')[0]);
before = log().length;
await call(a.client, 'desktop_control', { action: 'tripleClick', title: canvasTitle, x: padCentre[0], y: padCentre[1] });
await sleep(250);
check('tripleClick is three presses', log().slice(before).filter((l) => l === 'down Left').length === 3);
before = log().length;
const backClick = await call(a.client, 'desktop_control', { action: 'click', title: canvasTitle, x: padCentre[0], y: padCentre[1], button: 'back' });
await call(a.client, 'desktop_control', { action: 'click', title: canvasTitle, x: padCentre[0], y: padCentre[1], button: 'forward' });
await sleep(250);
// XMouseButtonControl sits on the back and forward buttons, so on a machine running it a miss proves nothing.
const remapped = spawnSync('tasklist', ['/FI', 'IMAGENAME eq XMouseButtonControl.exe'], { encoding: 'utf8' }).stdout.includes('XMouseButtonControl');
if (remapped) console.log('skip the back and forward mouse buttons - XMouseButtonControl is running and intercepts them');
else check('the back and forward mouse buttons', log().slice(before).includes('down XButton1') && log().slice(before).includes('down XButton2'), `${log().slice(before).filter((l) => l.startsWith('down')).join(' | ')} / ${textOf(backClick).split(String.fromCharCode(10))[0]}`);

// held across calls: a stroke built from separate steps
before = log().length;
const pressed = await call(a.client, 'desktop_control', { action: 'down', title: canvasTitle, x: onPad([60, 60])[0], y: onPad([60, 60])[1] });
check('down reports what it is holding', /HOLDING left/u.test(textOf(pressed)), textOf(pressed).split('\n')[0]);
await call(a.client, 'desktop_control', { action: 'move', x: onPad([200, 60])[0], y: onPad([200, 60])[1] });
await call(a.client, 'desktop_control', { action: 'move', x: onPad([200, 160])[0], y: onPad([200, 160])[1], durationMs: 300 });
const liftNone = strokeLines(before).length;
const lifted = await call(a.client, 'desktop_control', { action: 'up' });
await sleep(250);
const heldLine = strokeLines(before)[0] ?? '';
check('the button stays down across calls until up', liftNone === 0 && !/HOLDING/u.test(textOf(lifted)) && heldLine.startsWith('up Left'), heldLine.split(' pts=')[0]);
check('and the moves between were real strokes', heldLine !== '' && pointsOf(heldLine).length > 20 && Math.max(...pointsOf(heldLine).map((p) => toLine(p, [[60, 60], [200, 60], [200, 160]]))) <= 1.5, `${heldLine ? pointsOf(heldLine).length : 0} points`);

before = log().length;
await call(a.client, 'desktop_control', { action: 'down', key: 'shift', title });
const whileHeld = await call(a.client, 'desktop_control', { action: 'click', title, target: 'Alpha', modifiers: ['shift'] });
await call(a.client, 'desktop_control', { action: 'click', title, target: 'Alpha' });
await call(a.client, 'desktop_control', { action: 'up', key: 'shift' });
await call(a.client, 'desktop_control', { action: 'click', title, target: 'Alpha' });
await sleep(250);
check('a held key applies until up, even through a click naming it too', log().slice(before).join('|') === 'click Alpha mods=Shift|click Alpha mods=Shift|click Alpha' && /HOLDING shift/u.test(textOf(whileHeld)), log().slice(before).join(' | '));
const nothing = await call(a.client, 'desktop_control', { action: 'up', key: 'shift' });
check('up with nothing held says so', /nothing to release/u.test(textOf(nothing)));

before = log().length;
await call(a.client, 'desktop_control', { action: 'key', key: 'a', holdMs: 1000, title: canvasTitle });
await sleep(250);
const repeats = log().slice(before).filter((l) => l === 'keydown A').length;
check('a key held for holdMs repeats, then comes up once', repeats >= 5 && log().slice(before).filter((l) => l === 'keyup A').length === 1, `${repeats} repeats`);

before = log().length;
await call(a.client, 'desktop_control', { action: 'down', title: canvasTitle, x: padCentre[0], y: padCentre[1], holdMs: 400 });
await sleep(800);
const afterDeadline = await call(a.client, 'desktop_control', { action: 'move', x: padCentre[0] + 4, y: padCentre[1] });
check('a forgotten hold is released at its deadline, and the next result says so', strokeLines(before).length === 1 && /left was released automatically/u.test(textOf(afterDeadline)), textOf(afterDeadline).split('\n').slice(1).join(' '));

// past the banner's 2 s linger, when nothing is running: Esc must still reach the hold
before = log().length;
await call(a.client, 'desktop_control', { action: 'down', title: canvasTitle, x: padCentre[0], y: padCentre[1] });
await sleep(3000);
const escHold = spawn('powershell.exe', ['-NoProfile', '-Command',
	"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DeskEsc2 { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e); }'; [DeskEsc2]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); [DeskEsc2]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)"], { stdio: 'ignore' });
await new Promise((resolvePromise) => escHold.on('close', resolvePromise));
await sleep(500);
check('Esc releases a hold while no call is running', strokeLines(before).length === 1 && heldMsOf(strokeLines(before)[0]) >= 3000, strokeLines(before)[0]?.split(' pts=')[0]);

// an interrupted stroke lifts the button
before = log().length;
const stopping = new AbortController();
const longDraw = call(a.client, 'desktop_control', { action: 'draw', title: canvasTitle, strokes: [[[20, 20], [440, 20], [440, 330]].map(onPad)], durationMs: 6000 }, { signal: stopping.signal });
await sleep(900);
stopping.abort();
await longDraw.catch(() => {});
await sleep(400);
const cutLine = strokeLines(before)[0] ?? '';
check('an interrupted draw stops and lifts the button', cutLine.startsWith('up Left') && heldMsOf(cutLine) < 2500, cutLine.split(' pts=')[0]);

// the overlay: excluded from frames by default, drawn when the debug switch lets it in, and Stop works
const fullFrame = textOf(primary).match(/shows (\d+)x(\d+) screen pixels/u).slice(1).map(Number);
const barRegion = `${Math.round(fullFrame[0] / 2) - 420},${fullFrame[1] - 260},840,240`;
const regionHash = async (client) => textOf(await call(client, 'screen_view', { region: barRegion, includeCursor: false, rulers: false, forceImage: true })).match(/hash=(\w+)/u)[1];
// Over a still window: any live window in the region would change the hash by itself.
const coverRegion = barRegion.split(',').map(Number);
await call(a.client, 'desktop_control', { action: 'window', title: canvasTitle, x: coverRegion[0] - 20, y: coverRegion[1] - 50, width: coverRegion[2] + 40, height: coverRegion[3] + 70 });
await call(a.client, 'desktop_control', { action: 'focus', title: canvasTitle });
await sleep(2600); // the overlay's linger, so it is really gone
// Another program's view of the same pixels, and of the overlay's windows: read from outside the engine.
const outside = () => spawnSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DeskSeen { public delegate bool Each(IntPtr h, IntPtr l); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool EnumWindows(Each e, IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); public static int Excluded(string title) { uint owner, pid, affinity; int n = 0; GetWindowThreadProcessId(FindWindow(null, title), out owner); EnumWindows(delegate (IntPtr h, IntPtr l) { GetWindowThreadProcessId(h, out pid); if (pid == owner && GetWindowDisplayAffinity(h, out affinity) && affinity != 0) n++; return true; }, IntPtr.Zero); return n; } }'; $null = [DeskSeen]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)); $x, $y, $w, $h = '${barRegion}'.Split(','); $b = New-Object System.Drawing.Bitmap ([int]$w), ([int]$h); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen([int]$x, [int]$y, 0, 0, $b.Size); $m = New-Object IO.MemoryStream; $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Bmp); Write-Output ([Convert]::ToBase64String([Security.Cryptography.MD5]::Create().ComputeHash($m.ToArray())) + ' ' + [DeskSeen]::Excluded('desk-pilot overlay'))`], { encoding: 'utf8' }).stdout.trim().split(' ');
const quiet = await regionHash(a.client);
const [quietOutside] = outside();
const idleBatch = call(a.client, 'desktop_sequence', { steps: [{ action: 'wait', ms: 4000 }], capture: 'none' });
await sleep(900);
const busy = [];
for (let i = 0; i < 6; i++) busy.push(await regionHash(a.client));
const [busyOutside, excluded] = outside();
await idleBatch;
check('the overlay never appears in a frame', busy.every((hash) => hash === quiet), `${quiet} / ${busy.join(' ')}`);
check('other programs still see the overlay, and it survives a grab', quietOutside !== busyOutside, `${quietOutside} / ${busyOutside}`);
check('no overlay window is excluded from capture, which ends NVIDIA recordings', excluded === '0', `excluded ${excluded}`);

const bar = await startServer({ DESK_PILOT_DATA_DIR: join(work, 'data-bar'), DESK_PILOT_OVERLAY_IN_FRAMES: '1' });
await call(bar.client, 'desktop_control', { action: 'focus', title: canvasTitle });
await sleep(2600);
const barQuiet = await regionHash(bar.client);
const barRun = call(bar.client, 'desktop_sequence', { steps: [{ action: 'move', x: padCentre[0], y: padCentre[1], label: 'checking the overlay' }, { action: 'wait', ms: 2500 }, { action: 'type', target: 'Input', title, text: 'AFTER-STOP' }], capture: 'none' });
await sleep(1000);
const barShot = await call(bar.client, 'screen_view', { region: barRegion, includeCursor: false, rulers: false, forceImage: true });
const barBusy = textOf(barShot).match(/hash=(\w+)/u)[1];
writeFileSync(join(work, 'overlay-bar.png'), Buffer.from(imageOf(barShot).data, 'base64'));
const fullShot = await call(bar.client, 'screen_view', { screen: 'primary', includeCursor: false, rulers: false, forceImage: true });
writeFileSync(join(work, 'overlay-full.png'), Buffer.from(imageOf(fullShot).data, 'base64'));
check('with the debug switch the overlay is drawn', barQuiet !== barBusy, `${barQuiet} / ${barBusy}`);
const foregroundBefore = textOf(barShot).match(/foreground ('.*?')/u)?.[1];
before = log().length;
const stopClick = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DeskStop { public struct R { public int L, T, Rt, B; } [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, IntPtr e); }'; $null = [DeskStop]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)); $h = [DeskStop]::FindWindow([NullString]::Value, 'desk-pilot overlay'); $r = New-Object DeskStop+R; $null = [DeskStop]::GetWindowRect($h, [ref]$r); $s = [DeskStop]::GetDpiForWindow($h) / 96; $null = [DeskStop]::SetCursorPos($r.Rt - [int](35 * $s), [int](($r.T + $r.B) / 2)); Start-Sleep -Milliseconds 120; [DeskStop]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); [DeskStop]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); Write-Output $r.Rt`], { encoding: 'utf8' });
const barResult = textOf(await barRun);
check('clicking Stop on the bar stops the batch, like Esc', /stopped: the person pressed Esc/u.test(barResult) && !log().slice(before).some((l) => l.includes('AFTER-STOP')), `${stopClick.stdout.trim()} / ${barResult.split('\n').find((l) => l.startsWith('stopped')) ?? barResult.slice(0, 160)}`);
const fgAfter = textOf(await call(bar.client, 'desktop_control', { action: 'windows', title: canvasTitle }));
check('and taking that click did not steal the foreground', /\[foreground/u.test(fgAfter), fgAfter.split('\n')[1]);
await bar.client.close();
await sleep(300);
await call(a.client, 'desktop_control', { action: 'window', title: canvasTitle, x: padX - 19, y: padY - 53, width: 722, height: 411 });

// launching: a throwaway form started through the tool, with its arguments and folder
const launchedTitle = `desk-launched ${stamp}`;
const launchedFile = join(work, 'launched.txt');
const launchedScript = join(work, 'launched.ps1');
writeFileSync(launchedScript, `\uFEFFAdd-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form; $f.Text = '${launchedTitle}'
$f.Add_Shown({ [System.IO.File]::WriteAllText('${launchedFile}', ($PID.ToString() + '|' + (Get-Location).Path + '|' + $args[0])) })
[System.Windows.Forms.Application]::Run($f)
`, 'utf8');
const launched = await call(a.client, 'desktop_control', { action: 'launch', app: 'powershell.exe', args: `-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "${launchedScript}"`, cwd: work, expect: { window: launchedTitle, timeoutMs: 8000 } });
for (let waited = 0; !existsSync(launchedFile) && waited < 5000; waited += 100) await sleep(100);
const [launchedPid, launchedCwd] = existsSync(launchedFile) ? readFileSync(launchedFile, 'utf8').split('|') : [];
check('launch starts a program with its arguments and working folder', !launched.isError && launchedCwd === work, `${launchedCwd} / ${textOf(launched).split('\n')[0]}`);
if (launchedPid) kill(Number(launchedPid));
const noApp = await call(a.client, 'desktop_control', { action: 'launch', app: 'no-such-app-xyz' });
check('launching an unknown app is refused with no dialog', noApp.isError === true && /no app named 'no-such-app-xyz'/u.test(textOf(noApp)), textOf(noApp).slice(0, 110));

// the clipboard is the person's: a helper keeps every format, as a paste does, and puts it back
const original = textOf(await call(a.client, 'desktop_control', { action: 'clipboard' }));
const clipSaved = join(work, 'clip-saved.txt');
const clipGo = join(work, 'clip-go.txt');
const clipScript = join(work, 'clip.ps1');
writeFileSync(clipScript, `\uFEFFAdd-Type -AssemblyName System.Windows.Forms
$d = [System.Windows.Forms.Clipboard]::GetDataObject(); $s = New-Object System.Windows.Forms.DataObject
if ($d -ne $null) { foreach ($f in $d.GetFormats($false)) { try { $v = $d.GetData($f, $false); if ($v -ne $null) { $s.SetData($f, $false, $v) } } catch { } } }
[System.IO.File]::WriteAllText('${clipSaved}', 'saved')
while (-not (Test-Path '${clipGo}')) { Start-Sleep -Milliseconds 50 }
[System.Windows.Forms.Clipboard]::SetDataObject($s, $true, 5, 40)
`, 'utf8');
const clipHelper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', clipScript], { stdio: 'ignore' });
const clipDone = new Promise((resolvePromise) => clipHelper.on('close', resolvePromise));
for (let waited = 0; !existsSync(clipSaved) && waited < 8000; waited += 50) await sleep(50);
const marker = `desk clipboard ${stamp} café`;
await call(a.client, 'desktop_control', { action: 'clipboard', text: marker });
const readBack = textOf(await call(a.client, 'desktop_control', { action: 'clipboard' }));
const batched = textOf(await call(a.client, 'desktop_sequence', { steps: [{ action: 'clipboard' }] }));
writeFileSync(clipGo, 'go');
await clipDone;
check('clipboard text can be set and read back', readBack === `clipboard: ${marker}`, readBack);
check('and a batch reports what it read', batched.includes(`clipboard: ${marker}`));
const restored = textOf(await call(a.client, 'desktop_control', { action: 'clipboard' }));
check('the test puts the clipboard back as it was', restored === original, restored.slice(0, 60));

const screensOut = textOf(await call(a.client, 'desktop_control', { action: 'screens' }));
check('screens lists the monitors with work area and scale', new RegExp(`^\\d+ \\S+ primary 0,0,${fullFrame[0]},${fullFrame[1]} work 0,0,\\d+,\\d+ \\d+%$`, 'mu').test(screensOut), screensOut.split('\n')[1]);

const numbered = await call(a.client, 'screen_view', { window: title, annotate: true, includeCursor: false, rulers: false });
writeFileSync(join(work, 'numbered.png'), Buffer.from(imageOf(numbered)?.data ?? '', 'base64'));
check('annotate numbers the controls on the frame', /\d+ controls numbered/u.test(textOf(numbered)) && imageOf(numbered) !== undefined, textOf(numbered).split('\n').find((l) => l.includes('numbered')));
const again2 = await call(a.client, 'screen_view', { window: title, annotate: true, includeCursor: false, rulers: false });
check('an annotated frame is sent even if the screen has not changed', imageOf(again2) !== undefined);
before = log().length;
const byNumber = Number(controls.match(/^(\d+) \[Button\] 'Alpha'/mu)?.[1]);
await call(a.client, 'desktop_control', { action: 'click', title, target: byNumber });
await sleep(250);
check('a number from the frame works as a target', log().slice(before).includes('click Alpha'), log().slice(before).join(' | '));

// input an app can notice: Paint lost the press after a move and instant clicks before these
const rawCount = () => (existsSync(rawFile) ? Number(readFileSync(rawFile, 'utf8')) : 0);
await sleep(300);
const rawBefore = rawCount();
await call(a.client, 'desktop_control', { action: 'move', x: padCentre[0] + 30, y: padCentre[1] + 30 });
await sleep(350);
check('a plain move is a real input event, which raw-input apps see', rawCount() > rawBefore, `${rawBefore} -> ${rawCount()}`);
before = log().length;
await call(a.client, 'desktop_control', { action: 'click', title: canvasTitle, x: padCentre[0], y: padCentre[1] });
await sleep(250);
check('a plain click stays down long enough to be sampled', heldMsOf(strokeLines(before)[0] ?? '') >= 15, strokeLines(before)[0]?.split(' pts=')[0]);
const noSuch = await call(a.client, 'desktop_control', { action: 'click', title: canvasTitle, target: 'Nothing here' });
check('a missing control is named in readable words', noSuch.isError === true && /no control named 'Nothing here'/u.test(textOf(noSuch)), textOf(noSuch).slice(0, 110));

// warm latency
const moveTimes = [];
for (let i = 0; i < 10; i += 1) moveTimes.push((await timed(() => call(a.client, 'desktop_control', { action: 'move', x: 300 + i * 4, y: 600 }))).ms);
const moves = await call(a.client, 'desktop_sequence', { steps: Array.from({ length: 10 }, (_, i) => ({ action: 'move', x: 400 + i * 4, y: 620, settleMs: 0 })), capture: 'none' });
const moveStepMs = Number(textOf(moves).match(/ms=(\d+)/u)[1]) / 10;
measurements.warmMove = { roundTripMs: moveTimes, medianRoundTripMs: median(moveTimes), stepMs: moveStepMs };
const clickTimes = [];
for (let i = 0; i < 5; i += 1) clickTimes.push((await timed(() => call(a.client, 'desktop_control', { action: 'click', title, target: 'Beta' }))).ms);
measurements.warmNamedClick = { roundTripMs: clickTimes, medianMs: median(clickTimes) };
check('warm actions take milliseconds', moveStepMs < 60, `${moveStepMs} ms per move step; named click median ${median(clickTimes)} ms`);

// engine crashes: idle, in flight, then past the cap
const pid0 = enginePids(serverPid);
check('one warm engine runs under the server', pid0.length === 1, pid0.join(','));
kill(pid0[0]);
await sleep(400);
const restarted = await timed(() => call(a.client, 'desktop_control', { action: 'move', x: 500, y: 500 }));
const pid1 = enginePids(serverPid);
check('after the engine dies, the next action restarts it', !restarted.value.isError && pid1.length === 1 && pid1[0] !== pid0[0], `${restarted.ms} ms`);
measurements.engineRestartMs = restarted.ms;

const inflight = call(a.client, 'desktop_sequence', { steps: [{ action: 'move', x: 510, y: 510, settleMs: 5000 }, { action: 'move', x: 520, y: 520 }], capture: 'none' });
await sleep(1200);
kill(enginePids(serverPid)[0]);
const inflightText = textOf(await inflight);
check('an action in flight when the engine dies is failed, not replayed, and stops the batch', /#1 move FAILED .*may or may not have happened, so it was not retried/u.test(inflightText) && /stopped: the outcome of that step is unknown/u.test(inflightText), inflightText.split('\n')[1]);
check('and the server recovers', !(await call(a.client, 'desktop_control', { action: 'move', x: 530, y: 530 })).isError);
for (let i = 0; i < 2; i += 1) {
	const pids = enginePids(serverPid);
	if (pids.length > 0) kill(pids[0]);
	await sleep(400);
	await call(a.client, 'desktop_control', { action: 'move', x: 540, y: 540 });
}
const last = enginePids(serverPid);
if (last.length > 0) kill(last[0]);
await sleep(400);
const once = await timed(() => call(a.client, 'desktop_control', { action: 'click', title, target: 'Beta' }));
const onceShot = await timed(() => call(a.client, 'screen_view', { forceImage: true }));
check('past the crash cap, each request runs in a one-shot engine', !once.value.isError && enginePids(serverPid).length === 0, `named click ${once.ms} ms, workers=${enginePids(serverPid).length}`);
check('and frames still work', imageOf(onceShot.value) !== undefined, `${onceShot.ms} ms`);
measurements.oneShot = { namedClickMs: once.ms, captureMs: onceShot.ms };
const onceDown = await call(a.client, 'desktop_control', { action: 'down', x: 500, y: 500 });
check('down is refused in one-shot mode, where nothing could release it', onceDown.isError === true && /one-shot/u.test(textOf(onceDown)), textOf(onceDown));
await a.client.close();

// an engine killed while holding: the next engine lets go
const b = await startServer({ DESK_PILOT_DATA_DIR: join(work, 'data-hold') });
await call(b.client, 'desktop_control', { action: 'focus', title: canvasTitle });
before = log().length;
await call(b.client, 'desktop_control', { action: 'down', title: canvasTitle, x: padCentre[0], y: padCentre[1] });
kill(enginePids(b.transport.pid)[0]);
await sleep(400);
const lostUp = strokeLines(before).length;
await call(b.client, 'desktop_control', { action: 'move', x: 500, y: 500 });
await sleep(300);
check('a hold orphaned by a killed engine is released by the next engine', lostUp === 0 && strokeLines(before).length === 1, `${strokeLines(before).length} up after restart`);

// a plugin update replaced the engine file under a running session
const engineDir = join(work, 'data-hold', 'engine');
const engineFile = () => readdirSync(engineDir).find((name) => /^desk-engine-[0-9a-f]{12}\.exe$/u.test(name));
const current = engineFile();
writeFileSync(join(engineDir, 'desk-engine-aaaaaaaaaaaa.exe'), 'another session');
writeFileSync(join(engineDir, 'desk-engine-bbbbbbbbbbbb.exe'), 'long gone');
const longAgo = new Date(Date.now() - 8 * 86400000);
utimesSync(join(engineDir, 'desk-engine-bbbbbbbbbbbb.exe'), longAgo, longAgo);
kill(enginePids(b.transport.pid)[0]);
await sleep(400);
rmSync(join(engineDir, current));
const rebuilt = await call(b.client, 'desktop_control', { action: 'move', x: 500, y: 520 });
check('when its engine file disappears, the server compiles it again', !rebuilt.isError && existsSync(join(engineDir, current)), textOf(rebuilt).split('\n')[0]);
check('a recent engine from another session is kept, an old one removed', existsSync(join(engineDir, 'desk-engine-aaaaaaaaaaaa.exe')) && !existsSync(join(engineDir, 'desk-engine-bbbbbbbbbbbb.exe')));
await b.client.close();

kill(Number(windowPid));
writeFileSync(join(work, 'measurements.json'), JSON.stringify(measurements, null, 2));
console.log(`\nartifacts: ${work}`);
console.log(JSON.stringify(measurements));
console.log(failures === 0 ? '\ne2e: OK' : `\ne2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
