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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const logFile = join(work, 'log.txt');
const readyFile = join(work, 'ready.txt');
writeFileSync(logFile, '', 'utf8');
const formScript = `
Add-Type -AssemblyName System.Windows.Forms
$log = '${logFile}'
function W([string] $m) { [System.IO.File]::AppendAllText($log, $m + [char]10, (New-Object System.Text.UTF8Encoding($false))) }
function B([string] $text, [int] $x, [int] $y) { $b = New-Object System.Windows.Forms.Button; $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Width = 96; $b.Add_Click({ W ('click ' + $this.Text) }.GetNewClosure()); $form.Controls.Add($b); return $b }
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
$form.Add_Shown({ $thief.Show(); $form.Activate(); [System.IO.File]::WriteAllText('${readyFile}', ('{0}|0x{1:X}|0x{2:X}' -f $PID, $form.Handle.ToInt64(), $thief.Handle.ToInt64())) })
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
	]
}));
await sleep(300);
const batchText = textOf(batch.value);
check('a six-step batch with waitFor runs every step', /done=6\/6/u.test(batchText), batchText.split('\n').filter((l) => l.startsWith('#')).join(' | '));
check('in order, as the window saw it', ['click Show later', 'delayed shown', 'click Delayed'].every((line) => log().slice(before).includes(line)) && log().slice(before).some((line) => line.startsWith('enter:') && line.endsWith('+ more')), log().slice(before).join(' | '));
check('the batch ends with one frame', imageOf(batch.value) !== undefined, textOf(batch.value).split('\n').find((l) => l.startsWith('<end-frame')));
measurements.batch6 = { roundTripMs: batch.ms, stepMs: [...batchText.matchAll(/^#\d+ \w+ ok (\d+)ms/gmu)].map((m) => Number(m[1])) };

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

// warm latency
const moveTimes = [];
for (let i = 0; i < 10; i += 1) moveTimes.push((await timed(() => call(a.client, 'desktop_control', { action: 'move', x: 300 + i * 4, y: 600 }))).ms);
const moves = await call(a.client, 'desktop_sequence', { steps: Array.from({ length: 10 }, (_, i) => ({ action: 'move', x: 400 + i * 4, y: 620, settleMs: 0 })), capture: 'none' });
const moveSteps = [...textOf(moves).matchAll(/^#\d+ move ok (\d+)ms/gmu)].map((m) => Number(m[1]));
measurements.warmMove = { roundTripMs: moveTimes, medianRoundTripMs: median(moveTimes), stepMs: moveSteps, medianStepMs: median(moveSteps) };
const clickTimes = [];
for (let i = 0; i < 5; i += 1) clickTimes.push((await timed(() => call(a.client, 'desktop_control', { action: 'click', title, target: 'Beta' }))).ms);
measurements.warmNamedClick = { roundTripMs: clickTimes, medianMs: median(clickTimes) };
check('warm actions take milliseconds', median(moveSteps) < 60, `move step median ${median(moveSteps)} ms; named click median ${median(clickTimes)} ms`);

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
await a.client.close();

kill(Number(windowPid));
writeFileSync(join(work, 'measurements.json'), JSON.stringify(measurements, null, 2));
console.log(`\nartifacts: ${work}`);
console.log(JSON.stringify(measurements));
console.log(failures === 0 ? '\ne2e: OK' : `\ne2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
