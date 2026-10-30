import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The desktop engine: engine/*.cs compiled once by the C# compiler that ships with
 * .NET Framework 4.x on every Windows 10/11 machine, cached by a hash of its source,
 * and kept running for the whole session.
 *
 * Failure policy:
 *   - a request the engine received but never answered (crash, timeout) is reported
 *     as an unknown outcome and NEVER retried here - it may already have happened;
 *   - a dead engine is started again on the next request, at most `maxRestarts` times
 *     per window; past that, each request runs in its own short-lived engine
 *     (`--once`, ~100 ms) so the tools keep working without the warm process.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_DIR = join(ROOT, 'engine');
/** An older engine can belong to a session still open on the previous plugin version. */
const KEEP_OLD_ENGINE_MS = 7 * 24 * 60 * 60 * 1000;
const REFERENCES = ['System.Drawing.dll', 'System.Windows.Forms.dll', 'UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll', 'System.Web.Extensions.dll'];

function frameworkDir() {
	const windir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
	for (const bits of ['Framework64', 'Framework']) {
		const dir = join(windir, 'Microsoft.NET', bits, 'v4.0.30319');
		if (existsSync(join(dir, 'csc.exe'))) return dir;
	}
	return undefined;
}

/**
 * Compile the engine if this source has not been compiled yet.
 * @param dataDir - where compiled engines are cached.
 * @returns the engine's path.
 */
export async function ensureEngine(dataDir) {
	if (!existsSync(ENGINE_DIR)) throw new Error('desk-pilot was updated and this session\'s copy is gone; restart Claude Code to load the new version');
	const sources = readdirSync(ENGINE_DIR).filter((name) => name.endsWith('.cs')).sort();
	const hash = createHash('sha256');
	for (const name of sources) hash.update(name).update(readFileSync(join(ENGINE_DIR, name)));
	hash.update(REFERENCES.join(','));
	const stamp = hash.digest('hex').slice(0, 12);
	const dir = join(dataDir, 'engine');
	const exe = join(dir, `desk-engine-${stamp}.exe`);
	if (existsSync(exe)) return exe;
	const framework = frameworkDir();
	if (framework === undefined) throw new Error('desk-pilot needs the .NET Framework 4.x C# compiler (csc.exe), which ships with Windows 10 and 11; it was not found under %WINDIR%\\Microsoft.NET');
	mkdirSync(dir, { recursive: true });
	const temp = join(dir, `desk-engine-${stamp}.${process.pid}.tmp.exe`);
	const args = ['-nologo', '-optimize+', '-target:winexe', `-out:${temp}`, `-lib:${join(framework, 'WPF')}`, ...REFERENCES.map((ref) => `-r:${ref}`), ...sources.map((name) => join(ENGINE_DIR, name))];
	await new Promise((resolvePromise, rejectPromise) => {
		execFile(join(framework, 'csc.exe'), args, { windowsHide: true, timeout: 120000 }, (error, stdout) => {
			if (error) rejectPromise(new Error(`desk-pilot could not compile its engine: ${String(stdout || error.message).trim().slice(0, 1500)}`));
			else resolvePromise();
		});
	});
	// Two sessions may compile at once; whichever renames first wins and the other's copy is dropped.
	try {
		renameSync(temp, exe);
	} catch {
		rmSync(temp, { force: true });
		if (!existsSync(exe)) throw new Error('desk-pilot compiled its engine but could not move it into place');
	}
	for (const old of readdirSync(dir)) {
		if (old.startsWith('desk-engine-') && old.endsWith('.exe') && join(dir, old) !== exe) {
			try {
				if (Date.now() - statSync(join(dir, old)).mtimeMs > KEEP_OLD_ENGINE_MS) rmSync(join(dir, old), { force: true });
			} catch {
				// An older engine still running in another session keeps its file.
			}
		}
	}
	return exe;
}

/** An error whose outcome is unknown: the request reached the engine, the answer never came. */
function unknownOutcome(message) {
	return Object.assign(new Error(message), { unknownOutcome: true });
}

export class Engine extends EventEmitter {
	constructor({ dataDir, caption, overlayInFrames, timeoutMs, maxRestarts, restartWindowMs }) {
		super();
		this.dataDir = dataDir;
		this.caption = caption;
		this.overlayInFrames = overlayInFrames === true;
		this.timeoutMs = timeoutMs;
		this.maxRestarts = maxRestarts;
		this.restartWindowMs = restartWindowMs;
		this.child = undefined;
		this.starting = undefined;
		this.exe = undefined;
		this.exePath = undefined;
		this.waiters = new Map();
		this.sequence = 0;
		this.queue = Promise.resolve();
		this.crashes = [];
		this.onceMode = false;
		this.lastEscAt = 0;
		this.stats = { starts: 0, crashes: 0, onceRequests: 0 };
	}

	/** The warm engine's process id, if one is running. */
	pid() {
		return this.child?.pid;
	}

	/** The compiled engine, compiled once per process unless the file goes away (a failed compile is retried on the next call). */
	executable() {
		if (this.exePath !== undefined && !existsSync(this.exePath)) {
			this.exe = undefined;
			this.exePath = undefined;
		}
		if (this.exe === undefined) {
			this.exe = ensureEngine(this.dataDir);
			this.exe.then((path) => {
				this.exePath = path;
			}, () => {
				this.exe = undefined;
			});
		}
		return this.exe;
	}

	noteCrash() {
		const now = Date.now();
		this.stats.crashes += 1;
		this.crashes = this.crashes.filter((at) => now - at < this.restartWindowMs);
		this.crashes.push(now);
		if (this.crashes.length > this.maxRestarts) this.onceMode = true;
	}

	/** Start the warm engine and wait for its ready line. */
	start() {
		if (this.child !== undefined) return Promise.resolve();
		if (this.starting !== undefined) return this.starting;
		this.starting = (async () => {
			const exe = await this.executable();
			await new Promise((resolvePromise, rejectPromise) => {
				const child = spawn(exe, ['--caption', Buffer.from(this.caption, 'utf8').toString('base64'), ...(this.overlayInFrames ? ['--overlay-in-frames'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
				let buffer = '';
				let ready = false;
				const timer = setTimeout(() => {
					child.kill();
					rejectPromise(new Error('the desktop engine did not start within 15 s'));
				}, 15000);
				child.stdout.setEncoding('utf8');
				child.stdout.on('data', (chunk) => {
					buffer += chunk;
					let index = buffer.indexOf('\n');
					while (index >= 0) {
						const line = buffer.slice(0, index).trim();
						buffer = buffer.slice(index + 1);
						index = buffer.indexOf('\n');
						if (line.length === 0) continue;
						let message;
						try {
							message = JSON.parse(line);
						} catch {
							continue;
						}
						if (message.event === 'ready') {
							ready = true;
							clearTimeout(timer);
							this.child = child;
							this.stats.starts += 1;
							resolvePromise();
						} else if (message.event === 'esc') {
							this.lastEscAt = Date.now();
							this.emit('esc');
						} else if (typeof message.id === 'string') {
							const waiter = this.waiters.get(message.id);
							if (waiter !== undefined) waiter.settle(message);
						}
					}
				});
				child.stderr.on('data', () => {
					// The protocol lives on stdout.
				});
				child.stdin.on('error', () => {
					// Surfaces through 'close'.
				});
				child.on('error', (error) => {
					clearTimeout(timer);
					if (!ready) rejectPromise(new Error(`the desktop engine could not start: ${error.message}`));
				});
				child.on('close', () => {
					clearTimeout(timer);
					if (this.child === child) this.child = undefined;
					const pending = [...this.waiters.values()];
					this.waiters.clear();
					for (const waiter of pending) {
						waiter.fail(unknownOutcome('the desktop engine exited before answering; the action may or may not have happened, so it was not retried - look before repeating it'));
					}
					if (ready) this.noteCrash();
					else rejectPromise(new Error('the desktop engine exited while starting'));
				});
			});
		})().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	/**
	 * Run one request. Requests are serialized so each timeout measures only its own work.
	 * @param payload - { op, ... }.
	 * @param options - { signal, timeoutMs }.
	 */
	request(payload, options = {}) {
		const run = () => (this.onceMode ? this.runOnce(payload, options) : this.runWarm(payload, options));
		const result = this.queue.then(run, run);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	async runWarm(payload, options) {
		await this.start();
		const child = this.child;
		if (child === undefined) throw new Error('the desktop engine is not running');
		const id = `r${(this.sequence += 1)}`;
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		return new Promise((resolvePromise, rejectPromise) => {
			let timer;
			const onAbort = () => {
				try {
					child.stdin.write(`${JSON.stringify({ op: 'cancel', id })}\n`);
				} catch {
					// The timeout below still bounds the wait.
				}
			};
			const cleanup = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener('abort', onAbort);
				this.waiters.delete(id);
			};
			this.waiters.set(id, {
				settle: (message) => {
					cleanup();
					if (message.ok === true) resolvePromise(message);
					else rejectPromise(Object.assign(new Error(message.error ?? 'the action failed'), { cancelled: message.cancelled === true, esc: message.esc === true }));
				},
				fail: (error) => {
					cleanup();
					rejectPromise(error);
				}
			});
			timer = setTimeout(() => {
				// Unknown fate: stop the engine so nothing keeps acting; the next request gets a fresh one.
				cleanup();
				child.kill();
				rejectPromise(unknownOutcome(`the action did not finish within ${timeoutMs} ms; the engine was restarted and the action was not retried - look before repeating it`));
			}, timeoutMs);
			if (options.signal?.aborted) onAbort();
			else options.signal?.addEventListener('abort', onAbort, { once: true });
			child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
		});
	}

	/** One request in its own engine process: the path once the warm engine keeps dying. */
	async runOnce(payload, options) {
		const exe = await this.executable();
		this.stats.onceRequests += 1;
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		return new Promise((resolvePromise, rejectPromise) => {
			const child = spawn(exe, ['--once'], { stdio: ['pipe', 'pipe', 'ignore'] });
			let out = '';
			let done = false;
			const finish = (fn, value) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				options.signal?.removeEventListener('abort', onAbort);
				fn(value);
			};
			const onAbort = () => {
				child.kill();
				finish(rejectPromise, Object.assign(new Error('cancelled before it finished'), { cancelled: true }));
			};
			const timer = setTimeout(() => {
				child.kill();
				finish(rejectPromise, unknownOutcome(`the action did not finish within ${timeoutMs} ms and was not retried`));
			}, timeoutMs);
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			options.signal?.addEventListener('abort', onAbort, { once: true });
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				out += chunk;
			});
			child.on('error', (error) => finish(rejectPromise, new Error(`the desktop engine could not start: ${error.message}`)));
			child.on('close', () => {
				let message;
				try {
					message = JSON.parse(out.trim().split('\n').pop());
				} catch {
					finish(rejectPromise, unknownOutcome('the one-shot engine exited without an answer; the action was not retried'));
					return;
				}
				if (message.ok === true) finish(resolvePromise, message);
				else finish(rejectPromise, Object.assign(new Error(message.error ?? 'the action failed'), { cancelled: message.cancelled === true }));
			});
			child.stdin.end(`${JSON.stringify({ ...payload, id: 'once' })}\n`);
		});
	}

	/** Raise or lower (with a 2 s linger) the "Claude is operating" banner. Fire and forget. */
	overlay(show) {
		const child = this.child;
		if (child === undefined) return;
		try {
			child.stdin.write(`${JSON.stringify({ op: 'overlay', show })}\n`);
		} catch {
			// The banner is decoration; never fail an action over it.
		}
	}

	async stop() {
		const child = this.child;
		if (child === undefined) return;
		this.child = undefined;
		try {
			child.stdin.end(`${JSON.stringify({ op: 'quit' })}\n`);
		} catch {
			// Fall through to the kill.
		}
		await new Promise((resolvePromise) => {
			const timer = setTimeout(() => {
				child.kill();
				resolvePromise();
			}, 1500);
			child.once('close', () => {
				clearTimeout(timer);
				resolvePromise();
			});
		});
	}
}
