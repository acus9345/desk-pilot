/**
 * The text the model reads next to each result. Short on purpose: every line here is
 * paid for on every call.
 */

const r4 = (n) => Number(n.toFixed(4));
const quote = (s) => `'${String(s ?? '').replace(/\s+/gu, ' ').slice(0, 120)}'`;

function foregroundText(fg) {
	return fg ? `${quote(fg.title)} (${fg.process ?? '?'}, ${fg.hwnd})` : 'none';
}

/** One frame: how to turn an image reading into a screen coordinate, and what was in front. */
export function frameText(f, label = 'frame') {
	const lines = [];
	if (f.unchanged === true) {
		lines.push(`<${label} ${f.kind} area=${f.area} unchanged hash=${f.hash}> same as the frame you have; forceImage: true re-sends it.`);
	} else {
		const { captured: cap, delivered: del, origin: o } = f;
		lines.push(`<${label} ${f.kind} area=${f.area} hash=${f.hash}${f.changedOnly ? ' changed-only' : ''}>`);
		const ox = o.x === 0 ? '' : `${o.x} + `;
		const oy = o.y === 0 ? '' : `${o.y} + `;
		if (cap.w === del.w && cap.h === del.h) lines.push(`image ${del.w}x${del.h} is 1:1 with the screen: screen x = ${ox}image_x, screen y = ${oy}image_y.`);
		else lines.push(`image ${del.w}x${del.h} shows ${cap.w}x${cap.h} screen pixels: screen x = ${ox}image_x * ${r4(cap.w / del.w)}, screen y = ${oy}image_y * ${r4(cap.h / del.h)}.`);
	}
	if (f.numbered !== undefined) lines.push(`${f.numbered} controls numbered: target takes the number.`);
	lines.push(`foreground ${foregroundText(f.foreground)} · cursor ${f.cursor?.x},${f.cursor?.y}`);
	if (label === 'frame' && Array.isArray(f.screens) && f.screens.length > 1) {
		lines.push(`screens ${f.screens.map((s) => `${s.primary ? 'primary ' : ''}${s.device} ${s.bounds}`).join('; ')}`);
	}
	return lines.join('\n');
}

const windowLine = (w) => `${w.hwnd} ${quote(w.title)} (${w.process ?? '?'}) @ ${w.bounds}`;

/** Where input is now, without repeating the control that was just acted on. */
function stateParts(a) {
	const parts = [];
	if (a.focused && a.focused !== a.control) parts.push(`focus ${a.focused}`);
	if (a.foreground) parts.push(`fg ${quote(a.foreground.title)}`);
	if (a.held) parts.push(`HOLDING ${a.held}`);
	return parts;
}

/** What one action did and where input went afterwards. */
function actionSummary(a) {
	const parts = [];
	if (a.control) parts.push(a.control);
	if (a.drop) parts.push(`onto ${a.drop}`);
	if (a.drew) parts.push(`drew ${a.drew}`);
	if (a.modifiers) parts.push(`with ${a.modifiers}`);
	if (a.opened) parts.push(`opened ${windowLine(a.opened)}`);
	if (a.action === 'window' && a.window) parts.push(`window ${quote(a.window.title)} @ ${a.window.bounds}${a.window.maximized ? ' maximized' : a.window.minimized ? ' minimized' : ''}`);
	parts.push(...stateParts(a));
	const extra = [];
	if (a.typed) extra.push(`typed: ${a.typed}`);
	if (a.expect) extra.push(`expect: ${a.expect}`);
	for (const note of a.notes ?? []) extra.push(note);
	return { head: parts.join(' · '), extra };
}

export function windowsText(a) {
	const lines = ['<windows>'];
	for (const w of a.windows ?? []) {
		const flags = [w.foreground ? 'foreground' : '', w.minimized ? 'minimized' : '', w.maximized ? 'maximized' : ''].filter(Boolean).join(',');
		lines.push(`${w.hwnd} ${quote(w.title)} (${w.process ?? '?'}) @ ${w.bounds}${flags ? ` [${flags}]` : ''}`);
	}
	return lines.join('\n');
}

/** The index is the one screen_view's screen takes. */
export function screensText(a) {
	return ['<screens>', ...(a.screens ?? []).map((s, i) => `${i} ${s.device}${s.primary ? ' primary' : ''} ${s.bounds} work ${s.work}${s.scale ? ` ${s.scale}%` : ''}`)].join('\n');
}

export function controlsText(a) {
	const w = a.window ?? {};
	const lines = [`<controls window=${quote(w.title)} hwnd=${w.hwnd} shown=${a.kept} of=${a.total}${a.truncated ? ' truncated' : ''}>`];
	for (const line of a.controls ?? []) lines.push(line);
	if (a.total === 0) lines.push('(no UI Automation tree here; use screen_view)');
	else if (a.kept === 0) lines.push('(nothing operable on screen; try meaningfulOnly: false or screen_view)');
	return lines.join('\n');
}

export function actionText(a) {
	if (a.action === 'windows') return windowsText(a);
	if (a.action === 'controls') return controlsText(a);
	if (a.action === 'screens') return screensText(a);
	if (a.clipboard !== undefined) return `clipboard: ${a.clipboard}`;
	const { head, extra } = actionSummary(a);
	return [`${a.action} ok${head ? ` · ${head}` : ''}`, ...extra].join('\n');
}

/** A clean step is only a count: what reaches the model is failures, surprises and the final state. */
export function sequenceText(s) {
	const ok = s.results.filter((r) => r.ok).length;
	const risk = s.risk === 'low' ? '' : ` risk=${s.risk}`;
	const lines = [`<batch${risk}${s.confirmed ? ' confirmed' : ''}${s.dryRun ? ' dry-run' : ''} done=${ok}/${s.stepCount}${s.failed > 0 ? ` failed=${s.failed}` : ''}${s.ms === undefined ? '' : ` ms=${s.ms}`}>`];
	let last;
	for (const r of s.results) {
		if (s.dryRun) {
			lines.push(r.text);
			continue;
		}
		if (!r.ok) {
			lines.push(`#${r.n} ${r.action} FAILED ${r.ms}ms: ${r.error}`);
			continue;
		}
		if (r.a === undefined) continue;
		last = r.a;
		const notable = [...(r.a.drew ? [`drew ${r.a.drew}`] : []), ...(r.a.opened ? [`opened ${windowLine(r.a.opened)}`] : []), ...(r.a.clipboard === undefined ? [] : [`clipboard: ${r.a.clipboard}`]), ...(r.a.typed && !r.a.typed.startsWith('verified') ? [`typed: ${r.a.typed}`] : []), ...(r.a.notes ?? [])];
		if (notable.length > 0) lines.push(`#${r.n} ${r.action}: ${notable.join('; ')}`);
	}
	if (s.stopped) lines.push(`stopped: ${s.stopped}`);
	if (s.notRun > 0) lines.push(`${s.notRun} step(s) not run`);
	if (last) lines.push(`now: ${stateParts(last).join(' · ')}`);
	return lines.join('\n');
}
