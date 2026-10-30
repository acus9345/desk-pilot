import { ACTION_FIELDS, RISKS, STEP_ACTIONS, describeStep, gate, validateSteps } from './plan.mjs';
import { actionText, frameText, sequenceText } from './format.mjs';

/**
 * The three tools. Every word here is paid for in every session that loads them, so
 * obvious fields carry no description and steps do not repeat desktop_control's fields;
 * the how-to lives in the plugin's skill.
 */

const CONTROL_ACTIONS = ['click', 'doubleClick', 'tripleClick', 'rightClick', 'middleClick', 'move', 'drag', 'draw', 'down', 'up', 'scroll', 'type', 'key', 'focus', 'waitFor', 'window', 'windows', 'controls'];
const PASSIVE = new Set(['windows', 'controls', 'waitFor']);

const expectSchema = {
	type: 'object',
	description: 'Must hold after the action or the step fails; polled up to timeoutMs (1500, waitFor 5000). exists/gone name a control.',
	properties: {
		window: { type: 'string' },
		foreground: { type: 'string' },
		focused: { type: 'string' },
		value: { type: 'string' },
		exists: { type: 'string' },
		gone: { type: 'string' },
		timeoutMs: { type: 'integer' }
	},
	additionalProperties: false
};

export const TOOLS = [
	{
		name: 'screen_view',
		description: 'See the real Windows screen as an image. Default: primary monitor. Unchanged frames are not re-sent. Prefer desktop_control controls when you only need what is on screen.',
		inputSchema: {
			type: 'object',
			properties: {
				screen: { type: 'string', description: "'primary', 'all' or a monitor index." },
				window: { type: 'string', description: 'Title or process substring.' },
				hwnd: { type: 'string' },
				region: { type: 'string', description: "'x,y,w,h' in screen pixels; use it to zoom in." },
				diff: { type: 'boolean', description: 'Only what changed since your last frame of this area.' },
				maxEdge: { type: 'integer' },
				includeCursor: { type: 'boolean' },
				rulers: { type: 'boolean' },
				forceImage: { type: 'boolean', description: 'Re-send an unchanged frame.' }
			},
			additionalProperties: false
		},
		annotations: { readOnlyHint: true, openWorldHint: false }
	},
	{
		name: 'desktop_control',
		description: 'Act on the real Windows desktop, or read it (windows, controls). x/y are physical screen pixels. Use target instead of pixels whenever a control exists. Results say where input went; type is read back.',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: CONTROL_ACTIONS },
				x: { type: 'integer' },
				y: { type: 'integer' },
				toX: { type: 'integer', description: 'drag end; nonzero makes scroll horizontal.' },
				toY: { type: 'integer' },
				target: { type: ['integer', 'string'], description: 'Control index from controls, or its name.' },
				toTarget: { type: ['integer', 'string'], description: 'drag: drop on this control.' },
				role: { type: 'string', description: 'Disambiguates a name target: Button, Edit...' },
				strokes: {
					type: 'array',
					items: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
					description: 'draw: strokes of [x,y] points; the button lifts between strokes.'
				},
				smooth: { type: 'boolean', description: 'draw: curves, not straight lines.' },
				durationMs: { type: 'integer', description: 'drag, draw, move: speed, max 15000.' },
				holdMs: { type: 'integer', description: 'click, key: stay down this long. drag: pause first. down: auto-release after this (default 30000, max 120000).' },
				text: { type: 'string' },
				mode: { type: 'string', enum: ['paste', 'keys'] },
				key: { type: 'string', description: "'enter', 'ctrl+s', 'win+r'. down/up: keys to hold or release; up alone releases everything." },
				amount: { type: 'integer', description: 'scroll notches, + is up.' },
				button: { type: 'string', enum: ['left', 'right', 'middle', 'back', 'forward'] },
				modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'win'] } },
				width: { type: 'integer' },
				height: { type: 'integer' },
				show: { type: 'string', enum: ['minimize', 'maximize', 'restore'] },
				label: { type: 'string', description: 'Few words shown beside the pointer.' },
				title: { type: 'string', description: 'Window title or process substring; brought to front first.' },
				hwnd: { type: 'string' },
				tolerant: { type: 'boolean', description: 'focus: note a refusal instead of failing.' },
				expect: expectSchema,
				bounds: { type: 'boolean', description: 'controls: add positions.' },
				meaningfulOnly: { type: 'boolean', description: 'controls: default true.' },
				includeValues: { type: 'boolean' },
				settleMs: { type: 'integer' },
				capture: { type: 'boolean', description: 'Add a frame of what changed.' },
				forceImage: { type: 'boolean' }
			},
			required: ['action'],
			additionalProperties: false
		},
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
	},
	{
		name: 'desktop_sequence',
		description: 'Run many desktop_control actions in one call, the cheap way to work: one round trip, and it stops at the first failure. Esc stops it. Declare risk for anything that sends, deletes, pays or publishes; medium/high needs confirm: true after the user agrees.',
		inputSchema: {
			type: 'object',
			properties: {
				steps: {
					type: 'array',
					description: "Each step takes desktop_control's fields (not windows/controls), plus action 'wait' with ms, settleMs (default 100), risk, riskNote.",
					items: { type: 'object', properties: { action: { type: 'string', enum: STEP_ACTIONS } }, required: ['action'] }
				},
				risk: { type: 'string', enum: RISKS },
				confirm: { type: 'boolean' },
				dryRun: { type: 'boolean' },
				capture: { type: 'string', enum: ['none', 'window', 'screen', 'all'], description: "Frame after the last step, changes only. Default none. 'window' is the one in front." },
				window: { type: 'string', description: 'Frame this window instead.' },
				region: { type: 'string', description: "Frame 'x,y,w,h' instead." }
			},
			required: ['steps'],
			additionalProperties: false
		},
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
	}
];

const failure = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const withFrame = (text, frame) => {
	const content = [{ type: 'text', text }];
	if (frame?.png) content.push({ type: 'image', data: frame.png, mimeType: 'image/png' });
	return { content };
};
const pick = (source, fields) => {
	const out = {};
	for (const field of fields) if (source[field] !== undefined && source[field] !== null) out[field] = source[field];
	return out;
};

/** Wait that ends early on Esc or an interrupted turn. */
function wait(ms, signal, escaped) {
	return new Promise((resolvePromise, rejectPromise) => {
		const until = Date.now() + Math.max(0, ms);
		const tick = () => {
			if (signal?.aborted) return rejectPromise(Object.assign(new Error('the turn was interrupted'), { cancelled: true }));
			if (escaped()) return rejectPromise(Object.assign(new Error('the person pressed Esc'), { esc: true }));
			const left = until - Date.now();
			if (left <= 0) return resolvePromise();
			setTimeout(tick, Math.min(50, left));
		};
		tick();
	});
}

export function createHandlers(engine, config) {
	const lastSent = new Map();
	const options = (extra) => ({ signal: extra?.signal, timeoutMs: config.timeoutMs });

	/** One frame, deduplicated against the frame the model already has of the same area. */
	async function capture(target, extra, { diff = false, settleMaxMs = 0, forceImage = false, maxEdge } = {}) {
		const key = JSON.stringify([target.screen ?? null, target.window ?? null, target.hwnd ?? null, target.region ?? null]);
		const sent = lastSent.get(key);
		const payload = {
			op: 'capture',
			key,
			...pick(target, ['screen', 'window', 'hwnd', 'region', 'includeCursor', 'rulers']),
			maxEdge: Number.isInteger(maxEdge) ? Math.max(200, maxEdge) : config.imageMaxEdge,
			maxPixels: config.imageMaxPixels,
			diff,
			force: forceImage === true,
			settleMaxMs
		};
		if (sent !== undefined && Date.now() - sent.at < config.dedupTtlMs) payload.baseHash = sent.hash;
		let frame;
		try {
			frame = await engine.request(payload, options(extra));
		} catch (error) {
			// A capture has no side effects, so an unknown outcome is safe to retry once.
			if (error?.unknownOutcome !== true || extra?.signal?.aborted) throw error;
			frame = await engine.request(payload, options(extra));
		}
		if (frame.png) lastSent.set(key, { hash: frame.hash, at: Date.now() });
		return frame;
	}

	async function banner(show) {
		if (!config.takeover) return;
		if (show) {
			try {
				if (!engine.onceMode) await engine.start();
			} catch {
				return; // The request itself will report why the engine is unavailable.
			}
		}
		engine.overlay(show);
	}

	async function screenView(args, extra) {
		const frame = await capture(args, extra, { diff: args.diff === true, forceImage: args.forceImage, maxEdge: args.maxEdge });
		return withFrame(frameText(frame), frame);
	}

	async function desktopControl(args, extra) {
		if (!CONTROL_ACTIONS.includes(args.action)) return failure(`desktop_control needs action: ${CONTROL_ACTIONS.join(' | ')}`);
		const active = !PASSIVE.has(args.action);
		const wantsFrame = args.capture === true;
		const payload = {
			op: 'action',
			action: args.action,
			...pick(args, [...ACTION_FIELDS, 'meaningfulOnly', 'includeValues', 'bounds']),
			settleMs: wantsFrame ? 0 : (args.settleMs ?? 0)
		};
		let result;
		if (active) await banner(true);
		try {
			result = await engine.request(payload, options(extra));
		} catch (error) {
			const why = error?.esc ? ' The person pressed Esc: stop and ask before continuing.' : '';
			return failure(`${args.action} failed: ${String(error.message).replace(/\.$/u, '')}.${why}`);
		} finally {
			if (active) await banner(false);
		}
		let text = actionText(result);
		let frame;
		if (wantsFrame) {
			try {
				const target = typeof args.hwnd === 'string' ? { hwnd: args.hwnd } : typeof args.title === 'string' ? { window: args.title } : { screen: 'primary' };
				frame = await capture(target, extra, { diff: true, settleMaxMs: args.settleMs ?? config.captureSettleMs, forceImage: args.forceImage });
				text += `\n${frameText(frame)}`;
			} catch (error) {
				text += `\ncapture failed: ${error.message}`;
			}
		}
		return withFrame(text, frame);
	}

	async function desktopSequence(args, extra) {
		let steps;
		let risk;
		try {
			steps = validateSteps(args.steps, config.maxSequenceSteps);
			risk = gate(steps, args.risk, args.confirm);
		} catch (error) {
			return failure(error.message);
		}
		const summary = { risk, confirmed: args.confirm === true, stepCount: steps.length, results: [], failed: 0, notRun: 0 };
		if (args.dryRun === true) {
			summary.dryRun = true;
			summary.results = steps.map((step, index) => ({ ok: false, text: describeStep(step, index) }));
			return { content: [{ type: 'text', text: sequenceText(summary) }] };
		}

		const started = Date.now();
		const escaped = () => engine.lastEscAt >= started;
		let interrupted = false;
		await banner(true);
		try {
			for (const [index, step] of steps.entries()) {
				const n = index + 1;
				if (extra?.signal?.aborted) {
					summary.stopped = 'the turn was interrupted';
					interrupted = true;
					break;
				}
				if (escaped()) {
					summary.stopped = 'the person pressed Esc - stop and ask before doing more';
					break;
				}
				const t0 = Date.now();
				try {
					if (step.action === 'wait') {
						await wait(step.ms, extra?.signal, escaped);
						summary.results.push({ n, action: 'wait', ok: true, ms: Date.now() - t0 });
					} else {
						const a = await engine.request({ op: 'action', action: step.action, ...pick(step, ACTION_FIELDS), settleMs: step.settleMs ?? config.stepSettleMs }, options(extra));
						summary.results.push({ n, action: step.action, ok: true, ms: Date.now() - t0, a });
					}
				} catch (error) {
					summary.failed += 1;
					summary.results.push({ n, action: step.action, ok: false, ms: Date.now() - t0, error: error.message });
					if (error?.esc || escaped()) {
						summary.stopped = 'the person pressed Esc - stop and ask before doing more';
						break;
					}
					if (error?.cancelled || extra?.signal?.aborted) {
						summary.stopped = 'the turn was interrupted';
						interrupted = true;
						break;
					}
					if (error?.unknownOutcome) {
						summary.stopped = 'the outcome of that step is unknown, so nothing after it ran';
						break;
					}
					if (args.stopOnError !== false) {
						summary.stopped = `step ${n} failed`;
						break;
					}
				}
			}
		} finally {
			await banner(false);
		}
		summary.notRun = steps.length - summary.results.length;
		summary.ms = Date.now() - started;

		let text = sequenceText(summary);
		let frame;
		const wanted = args.capture ?? (typeof args.window === 'string' || typeof args.region === 'string' ? 'window' : 'none');
		if (wanted !== 'none' && !interrupted) {
			let target;
			if (typeof args.region === 'string') target = { region: args.region };
			else if (typeof args.window === 'string') target = { window: args.window };
			else if (wanted === 'screen') target = { screen: 'primary' };
			else if (wanted === 'all') target = { screen: 'all' };
			else {
				const last = [...summary.results].reverse().find((r) => r.a?.foreground?.hwnd);
				target = last ? { hwnd: last.a.foreground.hwnd } : { screen: 'primary' };
			}
			try {
				frame = await capture({ ...target, includeCursor: false }, extra, { diff: true, settleMaxMs: config.captureSettleMs });
				text += `\n${frameText(frame, 'end-frame')}`;
			} catch (error) {
				text += `\nend frame failed: ${error.message}`;
			}
		}
		return withFrame(text, frame);
	}

	return { screen_view: screenView, desktop_control: desktopControl, desktop_sequence: desktopSequence };
}
