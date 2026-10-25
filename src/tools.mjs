import { ACTION_FIELDS, RISKS, STEP_ACTIONS, describeStep, gate, validateSteps } from './plan.mjs';
import { actionText, frameText, sequenceText } from './format.mjs';

/**
 * The three tools. Descriptions stay short (they load with every schema); the longer
 * how-to lives in the plugin's skill.
 */

const CONTROL_ACTIONS = ['click', 'doubleClick', 'rightClick', 'middleClick', 'move', 'drag', 'scroll', 'type', 'key', 'focus', 'waitFor', 'windows', 'controls'];
const PASSIVE = new Set(['windows', 'controls', 'waitFor']);

const expectSchema = {
	type: 'object',
	description: 'Conditions that must hold after the action (polled until timeoutMs, default 1500; 5000 for waitFor). The step fails if they do not.',
	properties: {
		window: { type: 'string', description: 'A window with this title exists.' },
		foreground: { type: 'string', description: 'The window in front has this title.' },
		focused: { type: 'string', description: 'The focused control has this name.' },
		value: { type: 'string', description: 'The focused control contains this text.' },
		exists: { type: 'string', description: 'A control with this name is on screen (in the step window, else the front one).' },
		gone: { type: 'string', description: 'No control with this name is on screen.' },
		timeoutMs: { type: 'integer' }
	},
	additionalProperties: false
};

const actionProps = {
	x: { type: 'integer', description: 'Screen x in physical pixels.' },
	y: { type: 'integer', description: 'Screen y in physical pixels.' },
	toX: { type: 'integer', description: 'drag end x; nonzero makes scroll horizontal.' },
	toY: { type: 'integer', description: 'drag end y.' },
	target: {
		anyOf: [{ type: 'integer' }, { type: 'string' }],
		description: 'A control instead of x/y: an index from the last controls listing, or a control name (exact beats partial; add role if ambiguous). Disabled controls are refused.'
	},
	role: { type: 'string', description: 'With a name target: Button, Edit, CheckBox, MenuItem, ListItem, TabItem...' },
	text: { type: 'string', description: 'type: the text.' },
	mode: { type: 'string', enum: ['paste', 'keys'], description: "type: 'paste' (default, one insertion, clipboard restored) or 'keys' (Unicode keystrokes)." },
	key: { type: 'string', description: "key: 'enter', 'tab', 'esc', 'f5', 'ctrl+s', 'alt+tab', 'win+r'." },
	amount: { type: 'integer', description: 'scroll notches, positive is up (default 3).' },
	button: { type: 'string', enum: ['left', 'right', 'middle'] },
	title: { type: 'string', description: 'Window title or process substring: input goes to it (brought to front first); focus and controls use it.' },
	hwnd: { type: 'string', description: 'Window handle (0x1094C) instead of title.' },
	tolerant: { type: 'boolean', description: 'focus: note a refused focus instead of failing.' },
	expect: expectSchema
};

export const TOOLS = [
	{
		name: 'screen_view',
		title: 'View screen',
		description: 'See the live Windows desktop as a real image (per-monitor DPI aware, coordinate rulers in screen pixels). Defaults to the primary monitor; window frames one window (any window, by title or hwnd), region crops, screen "all" spans every monitor. An unchanged frame is not re-sent; diff sends only the changed region.',
		inputSchema: {
			type: 'object',
			properties: {
				screen: { type: 'string', description: "'primary' (default), 'all', or a monitor index." },
				window: { type: 'string', description: 'Window title or process substring.' },
				hwnd: { type: 'string', description: 'Window handle.' },
				region: { type: 'string', description: "'x,y,width,height' in screen pixels - also the way to zoom in." },
				diff: { type: 'boolean', description: 'Send only the region that changed since your last frame of this area.' },
				maxEdge: { type: 'integer', description: 'Longest image side in pixels (default 1568); smaller is cheaper.' },
				includeCursor: { type: 'boolean', description: 'Mark the pointer (default true).' },
				rulers: { type: 'boolean', description: 'Coordinate rulers (default true).' },
				forceImage: { type: 'boolean', description: 'Send the full frame even if unchanged.' }
			},
			additionalProperties: false
		},
		annotations: { title: 'View screen', readOnlyHint: true, openWorldHint: false }
	},
	{
		name: 'desktop_control',
		title: 'Desktop control',
		description: 'Operate the live Windows desktop: click, drag, scroll, type, keys, focus, waitFor, list windows, or read a window\'s UI Automation controls ("index [Role] \'Name\' @ x,y WxH"). Click a control by index or name with target instead of guessing pixels. Every input action reports where input went (foreground window, focused control) and type reads the text back; expect makes the result checked. capture: true adds a frame (only what changed, when possible).',
		inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: CONTROL_ACTIONS },
				...actionProps,
				meaningfulOnly: { type: 'boolean', description: 'controls: only operable, on-screen controls (default true).' },
				includeValues: { type: 'boolean', description: 'controls: include values (passwords masked).' },
				settleMs: { type: 'integer', description: 'Wait after acting (default 0; with capture, the frame waits until the screen stops changing, up to this).' },
				capture: { type: 'boolean', description: 'Return a frame after acting (default false).' },
				forceImage: { type: 'boolean' }
			},
			required: ['action'],
			additionalProperties: false
		},
		annotations: { title: 'Desktop control', readOnlyHint: false, destructiveHint: true, openWorldHint: false }
	},
	{
		name: 'desktop_sequence',
		title: 'Desktop batch',
		description: 'Run several desktop_control actions in ONE call and look once at the end - the fast path. Steps run in order; the first failed step (including an unmet expect or a refused focus) stops the batch. Esc stops it. Declare risk: low runs freely; medium/high (batch or step) is refused without confirm: true, and with it the user is asked to approve. dryRun lists the plan.',
		inputSchema: {
			type: 'object',
			properties: {
				steps: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							action: { type: 'string', enum: STEP_ACTIONS },
							...actionProps,
							ms: { type: 'integer', description: 'wait: milliseconds.' },
							settleMs: { type: 'integer', description: 'Pause after this step (default 100).' },
							risk: { type: 'string', enum: RISKS },
							riskNote: { type: 'string' }
						},
						required: ['action'],
						additionalProperties: false
					}
				},
				risk: { type: 'string', enum: RISKS, description: 'Risk of the whole batch (default low).' },
				confirm: { type: 'boolean', description: 'The user agreed to a medium/high batch.' },
				dryRun: { type: 'boolean' },
				capture: { type: 'string', enum: ['end', 'none'], description: 'end (default): one frame after the last step.' },
				target: { type: 'string', enum: ['window', 'screen', 'all'], description: 'End frame: the window in front (default), primary screen, or all monitors.' },
				window: { type: 'string', description: 'Frame this window instead.' },
				region: { type: 'string', description: "Crop the end frame: 'x,y,width,height'." },
				diff: { type: 'boolean', description: 'End frame shows only what changed (default true).' },
				maxEdge: { type: 'integer' },
				forceImage: { type: 'boolean' },
				stopOnError: { type: 'boolean', description: 'Default true. An unknown outcome or Esc always stops.' },
				settleMs: { type: 'integer', description: 'Max wait for the screen to settle before the end frame (default 1000).' }
			},
			required: ['steps'],
			additionalProperties: false
		},
		annotations: { title: 'Desktop batch', readOnlyHint: false, destructiveHint: true, openWorldHint: false }
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
			...pick(args, [...ACTION_FIELDS, 'meaningfulOnly', 'includeValues']),
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

		let text = sequenceText(summary);
		let frame;
		if (args.capture !== 'none' && !interrupted) {
			let target;
			if (typeof args.region === 'string') target = { region: args.region };
			else if (typeof args.window === 'string') target = { window: args.window };
			else if (args.target === 'screen') target = { screen: 'primary' };
			else if (args.target === 'all') target = { screen: 'all' };
			else {
				const last = [...summary.results].reverse().find((r) => r.a?.foreground?.hwnd);
				target = last ? { hwnd: last.a.foreground.hwnd } : { screen: 'primary' };
			}
			try {
				frame = await capture({ ...target, includeCursor: false }, extra, {
					diff: args.diff !== false,
					settleMaxMs: args.settleMs ?? config.captureSettleMs,
					forceImage: args.forceImage,
					maxEdge: args.maxEdge
				});
				text += `\n${frameText(frame, 'end-frame')}`;
			} catch (error) {
				text += `\nend frame failed: ${error.message}`;
			}
		}
		return withFrame(text, frame);
	}

	return { screen_view: screenView, desktop_control: desktopControl, desktop_sequence: desktopSequence };
}
