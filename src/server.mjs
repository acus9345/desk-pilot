import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { Engine } from './engine.mjs';
import { TOOLS, createHandlers } from './tools.mjs';

/**
 * desk-pilot: a stdio MCP server, one per Claude Code session, that keeps one warm
 * desktop engine for its whole life. Windows only.
 */

function settings(env = process.env) {
	const positive = (key, fallback) => {
		const value = Number(env[key]);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	};
	const off = (key) => /^(0|false|no|off)$/iu.test(String(env[key] ?? '').trim());
	return {
		timeoutMs: positive('DESK_PILOT_TIMEOUT_MS', 20000),
		stepSettleMs: positive('DESK_PILOT_STEP_SETTLE_MS', 100),
		captureSettleMs: positive('DESK_PILOT_CAPTURE_SETTLE_MS', 1000),
		maxSequenceSteps: positive('DESK_PILOT_MAX_SEQUENCE_STEPS', 24),
		imageMaxEdge: positive('DESK_PILOT_IMAGE_MAX_EDGE', 1356),
		imageMaxPixels: positive('DESK_PILOT_IMAGE_MAX_PIXELS', 1150000),
		dedupTtlMs: positive('DESK_PILOT_DEDUP_TTL_MS', 300000),
		maxRestarts: positive('DESK_PILOT_ENGINE_MAX_RESTARTS', 3),
		restartWindowMs: positive('DESK_PILOT_ENGINE_RESTART_WINDOW_MS', 600000),
		takeover: !off('DESK_PILOT_TAKEOVER'),
		caption: env.DESK_PILOT_CAPTION || 'Claude is in control · Esc to stop',
		overlayInFrames: env.DESK_PILOT_OVERLAY_IN_FRAMES === '1',
		dataDir: env.DESK_PILOT_DATA_DIR || env.CLAUDE_PLUGIN_DATA || join(env.LOCALAPPDATA ?? env.TEMP ?? '.', 'desk-pilot')
	};
}

const INSTRUCTIONS = 'Windows desktop control. Read controls, act by name or index, batch with desktop_sequence.';

const config = settings();
const engine = new Engine(config);
const handlers = createHandlers(engine, config);
const server = new Server({ name: 'desk-pilot', version: '0.4.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
	const handler = handlers[request.params.name];
	if (handler === undefined) return { isError: true, content: [{ type: 'text', text: `unknown tool ${request.params.name}` }] };
	if (process.platform !== 'win32') return { isError: true, content: [{ type: 'text', text: 'desk-pilot only works on Windows.' }] };
	try {
		return await handler(request.params.arguments ?? {}, extra);
	} catch (error) {
		// Never let a tool failure take the server down: a stdio server that exits stays
		// failed until the user reconnects it.
		return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
	}
});

let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	try {
		await engine.stop();
	} finally {
		process.exit(0);
	}
}
process.stdin.on('close', close);
process.on('SIGINT', close);
process.on('SIGTERM', close);
process.on('uncaughtException', (error) => process.stderr.write(`desk-pilot: ${error?.stack ?? error}\n`));
process.on('unhandledRejection', (error) => process.stderr.write(`desk-pilot: ${error?.stack ?? error}\n`));

await server.connect(new StdioServerTransport());
// Compile the engine in the background (first run of a new version only, ~2 s) so the
// first tool call does not pay for it. The engine itself starts on first use (~0.1 s),
// so a session that never touches the desktop runs no extra process.
if (process.platform === 'win32') engine.executable().catch(() => undefined);
