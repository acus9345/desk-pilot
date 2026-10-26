/**
 * Batch validation and the risk rule. Pure functions with no imports, shared by the
 * server and the PreToolUse hook so the two can never disagree about what is risky.
 */

export const STEP_ACTIONS = ['click', 'doubleClick', 'rightClick', 'middleClick', 'move', 'drag', 'scroll', 'type', 'key', 'focus', 'wait', 'waitFor', 'window'];
export const RISKS = ['low', 'medium', 'high'];
const ORDER = { low: 0, medium: 1, high: 2 };
const POINTER = new Set(['click', 'doubleClick', 'rightClick', 'middleClick', 'move']);
/** Fields a step forwards to the engine. */
export const ACTION_FIELDS = ['x', 'y', 'toX', 'toY', 'amount', 'text', 'key', 'title', 'hwnd', 'button', 'tolerant', 'target', 'role', 'mode', 'expect', 'modifiers', 'width', 'height', 'show'];

/**
 * Validate a batch before anything touches the desktop.
 * @returns the steps, each checked.
 */
export function validateSteps(steps, maxSteps) {
	if (!Array.isArray(steps) || steps.length === 0) throw new Error('desktop_sequence needs at least one step');
	if (steps.length > maxSteps) throw new Error(`desktop_sequence accepts at most ${maxSteps} steps (got ${steps.length}); split the batch`);
	return steps.map((step, offset) => {
		const n = offset + 1;
		if (step === null || typeof step !== 'object' || Array.isArray(step)) throw new Error(`step ${n} must be an object`);
		const { action } = step;
		if (!STEP_ACTIONS.includes(action)) throw new Error(`step ${n} has unknown action ${JSON.stringify(action)}; use ${STEP_ACTIONS.join('/')}`);
		const hasTarget = typeof step.target === 'string' || Number.isInteger(step.target);
		if (POINTER.has(action) && !hasTarget && !(Number.isInteger(step.x) && Number.isInteger(step.y))) throw new Error(`step ${n} (${action}) needs x and y, or a target`);
		if (action === 'drag' && !(Number.isInteger(step.toX) && Number.isInteger(step.toY))) throw new Error(`step ${n} (drag) needs toX and toY`);
		if (action === 'type' && typeof step.text !== 'string') throw new Error(`step ${n} (type) needs text`);
		if (action === 'key' && typeof step.key !== 'string') throw new Error(`step ${n} (key) needs key`);
		if (action === 'focus' && typeof step.title !== 'string' && typeof step.hwnd !== 'string') throw new Error(`step ${n} (focus) needs title or hwnd`);
		if (action === 'wait' && !Number.isInteger(step.ms)) throw new Error(`step ${n} (wait) needs integer ms`);
		if (action === 'waitFor' && (step.expect === null || typeof step.expect !== 'object')) throw new Error(`step ${n} (waitFor) needs expect, e.g. {exists: 'OK'}`);
		if (action === 'window' && typeof step.title !== 'string' && typeof step.hwnd !== 'string') throw new Error(`step ${n} (window) needs title or hwnd`);
		if (action === 'window' && step.show === undefined && step.x === undefined && step.y === undefined && step.width === undefined && step.height === undefined) throw new Error(`step ${n} (window) needs show or x/y/width/height`);
		if (step.modifiers !== undefined && action === 'move') throw new Error(`step ${n}: modifiers apply to clicks, drags and scroll`);
		if (step.risk !== undefined && !RISKS.includes(step.risk)) throw new Error(`step ${n} risk must be low, medium or high`);
		return step;
	});
}

/** The effective risk of a batch and the steps that raised it. */
export function assessRisk(steps, declared) {
	let effective = RISKS.includes(declared) ? declared : 'low';
	const flagged = [];
	steps.forEach((step, offset) => {
		const risk = RISKS.includes(step?.risk) ? step.risk : 'low';
		if (ORDER[risk] > 0) flagged.push(`#${offset + 1} ${step.action}${typeof step.riskNote === 'string' && step.riskNote.length > 0 ? ` (${step.riskNote})` : ''}`);
		if (ORDER[risk] > ORDER[effective]) effective = risk;
	});
	return { effective, flagged };
}

/** Refuse a medium/high batch without confirm, before anything runs. */
export function gate(steps, declared, confirm) {
	const { effective, flagged } = assessRisk(steps, declared);
	if (ORDER[effective] > 0 && confirm !== true) {
		throw new Error(`desktop_sequence refused before touching the desktop: this batch is ${effective} risk (${flagged.length > 0 ? flagged.join(', ') : 'declared for the whole batch'}). ` +
			'Tell the user what it will do; once they agree, send the same steps with confirm: true (Claude Code will then ask them to approve it).');
	}
	return effective;
}

/** One line per step, for dry runs and the approval prompt. */
export function describeStep(step, index) {
	const parts = [`${index + 1}. ${step.action}`];
	if (typeof step.target === 'string') parts.push(`'${step.target}'${step.role ? ` (${step.role})` : ''}`);
	else if (Number.isInteger(step.target)) parts.push(`control #${step.target}`);
	else if (Number.isInteger(step.x) && Number.isInteger(step.y)) parts.push(`at ${step.x},${step.y}`);
	if (Number.isInteger(step.toX) && Number.isInteger(step.toY)) parts.push(`to ${step.toX},${step.toY}`);
	if (step.modifiers !== undefined) parts.push(`with ${Array.isArray(step.modifiers) ? step.modifiers.join('+') : step.modifiers}`);
	if (Number.isInteger(step.width) || Number.isInteger(step.height)) parts.push(`size ${step.width ?? '?'}x${step.height ?? '?'}`);
	if (typeof step.show === 'string') parts.push(step.show);
	if (typeof step.title === 'string') parts.push(`in '${step.title}'`);
	if (typeof step.key === 'string') parts.push(step.key);
	if (typeof step.text === 'string') parts.push(JSON.stringify(step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text));
	if (Number.isInteger(step.ms)) parts.push(`${step.ms} ms`);
	if (step.expect && typeof step.expect === 'object') parts.push(`expect ${JSON.stringify(step.expect)}`);
	if (step.risk === 'medium' || step.risk === 'high') parts.push(`[${step.risk}${typeof step.riskNote === 'string' ? `: ${step.riskNote}` : ''}]`);
	return parts.join(' ');
}
