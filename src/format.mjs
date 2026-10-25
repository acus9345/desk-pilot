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
		lines.push(`<${label} ${f.kind} area=${f.area} unchanged hash=${f.hash}>`);
		lines.push('Nothing changed since the frame you already have of this area; its coordinates still apply. If you no longer have it (after compaction, or in a subagent), call again with forceImage: true.');
	} else {
		const { captured: cap, delivered: del, origin: o } = f;
		lines.push(`<${label} ${f.kind} area=${f.area} hash=${f.hash}${f.changedOnly ? ' changed-only' : ''}>`);
		const ox = o.x === 0 ? '' : `${o.x} + `;
		const oy = o.y === 0 ? '' : `${o.y} + `;
		if (cap.w === del.w && cap.h === del.h) {
			lines.push(`image ${del.w}x${del.h} is 1:1 with the screen: screen x = ${ox}image_x, screen y = ${oy}image_y.`);
		} else {
			lines.push(`image ${del.w}x${del.h} shows ${cap.w}x${cap.h} screen pixels: screen x = ${ox}image_x * ${r4(cap.w / del.w)}, screen y = ${oy}image_y * ${r4(cap.h / del.h)}. Ruler labels are already screen coordinates.`);
		}
		if (f.changedOnly) lines.push(`Only the region that changed since your last frame of ${f.area} is shown (screen ${o.x},${o.y} ${cap.w}x${cap.h}); the rest is as before.`);
	}
	lines.push(`foreground ${foregroundText(f.foreground)} · cursor ${f.cursor?.x},${f.cursor?.y}`);
	if (label === 'frame' && Array.isArray(f.screens) && f.screens.length > 1) {
		lines.push(`screens ${f.screens.map((s) => `${s.primary ? 'primary ' : ''}${s.device} ${s.bounds}`).join('; ')}`);
	}
	lines.push(`</${label}>`);
	return lines.join('\n');
}

/** What one action did and where input went afterwards. */
function actionSummary(a) {
	const parts = [];
	if (a.control) parts.push(a.control);
	if (a.focused) parts.push(`focus ${a.focused}`);
	if (a.foreground) parts.push(`fg ${quote(a.foreground.title)}`);
	const extra = [];
	if (a.typed) extra.push(`typed: ${a.typed}`);
	if (a.expect) extra.push(`expect: ${a.expect}`);
	for (const note of a.notes ?? []) extra.push(note);
	return { head: parts.join(' · '), extra };
}

export function windowsText(a) {
	const lines = ['<windows>'];
	for (const w of a.windows ?? []) {
		const flags = [w.foreground ? 'foreground' : '', w.minimized ? 'minimized' : ''].filter(Boolean).join(',');
		lines.push(`${w.hwnd} ${quote(w.title)} (${w.process ?? '?'}) @ ${w.bounds}${flags ? ` [${flags}]` : ''}`);
	}
	lines.push('</windows>');
	return lines.join('\n');
}

export function controlsText(a) {
	const w = a.window ?? {};
	const lines = [`<controls window=${quote(w.title)} hwnd=${w.hwnd} shown=${a.kept} of=${a.total}${a.truncated ? ' truncated' : ''}>`];
	for (const line of a.controls ?? []) lines.push(line);
	if (a.total === 0) lines.push('(this window exposes no UI Automation tree; use screen_view)');
	else if (a.kept === 0) lines.push(`(nothing operable on screen among ${a.total} elements; pass meaningfulOnly: false to see them all, or take a screenshot)`);
	else if (a.kept < a.total) lines.push(`(${a.total - a.kept} hidden: not operable or off-screen; meaningfulOnly: false shows all. target: index or name clicks a control)`);
	lines.push('</controls>');
	return lines.join('\n');
}

export function actionText(a) {
	if (a.action === 'windows') return windowsText(a);
	if (a.action === 'controls') return controlsText(a);
	const { head, extra } = actionSummary(a);
	return [`${a.action} ok${head ? ` · ${head}` : ''} · cursor ${a.cursor?.x},${a.cursor?.y}`, ...extra].join('\n');
}

export function sequenceText(s) {
	const ok = s.results.filter((r) => r.ok).length;
	const lines = [`<batch risk=${s.risk}${s.confirmed ? ' confirmed' : ''}${s.dryRun ? ' dry-run' : ''} done=${ok}/${s.stepCount}${s.failed > 0 ? ` failed=${s.failed}` : ''}>`];
	for (const r of s.results) {
		if (s.dryRun) {
			lines.push(r.text);
			continue;
		}
		if (!r.ok) {
			lines.push(`#${r.n} ${r.action} FAILED ${r.ms}ms: ${r.error}`);
			continue;
		}
		if (r.a === undefined) {
			lines.push(`#${r.n} ${r.action} ok ${r.ms}ms`);
			continue;
		}
		const { head, extra } = actionSummary(r.a);
		lines.push(`#${r.n} ${r.action} ok ${r.ms}ms${head ? ` · ${head}` : ''}`);
		for (const line of extra) lines.push(`   ${line}`);
	}
	if (s.stopped) lines.push(`stopped: ${s.stopped}`);
	if (s.notRun > 0) lines.push(`${s.notRun} step(s) not run`);
	lines.push('</batch>');
	return lines.join('\n');
}
