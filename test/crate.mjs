// Runs the Rust launcher as an MCP client would, against nothing but the desktop's window list.
//
// Usage: cargo build && node test/crate.mjs   (Windows)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.argv[2] ?? join(root, 'target', 'debug', 'desk-pilot.exe');
const home = mkdtempSync(join(tmpdir(), 'desk-crate-'));
const version = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(/^version = "(.+)"/mu)[1];
const env = { ...process.env, LOCALAPPDATA: home };
delete env.DESK_PILOT_DATA_DIR;
let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` - ${detail}`}`);
	if (!ok) failures += 1;
}

const shown = spawnSync(binary, ['--version'], { encoding: 'utf8' });
check('--version names the crate version', shown.stdout.trim() === `desk-pilot ${version}`, shown.stdout.trim());
const wrong = spawnSync(binary, ['--nonsense'], { encoding: 'utf8' });
check('an unknown argument is refused', wrong.status === 2 && /no arguments/u.test(wrong.stderr));
const noNode = spawnSync(binary, [], { encoding: 'utf8', env: { ...env, PATH: home, Path: home } });
check('without Node it says what is missing', noNode.status === 1 && /needs Node 22\.19 or later on PATH/u.test(noNode.stderr), noNode.stderr.trim().slice(0, 100));

const transport = new StdioClientTransport({ command: binary, args: [], env, stderr: 'pipe' });
const client = new Client({ name: 'crate-test', version: '0' });
await client.connect(transport);
check('the MCP handshake goes through to the Node server', client.getServerVersion()?.version === version, client.getServerVersion()?.version);
const tools = (await client.listTools()).tools.map((t) => t.name).sort().join(',');
check('exactly the three tools', tools === 'desktop_control,desktop_sequence,screen_view', tools);
const call = await client.callTool({ name: 'desktop_control', arguments: { action: 'windows', title: 'no-such-window-xyz' } });
check('a real call compiles the engine and answers', call.isError !== true && call.content[0].text.startsWith('<windows>'), call.content[0].text);
check('everything is unpacked into its version folder', existsSync(join(home, 'desk-pilot', version, 'dist', 'server.mjs')) && existsSync(join(home, 'desk-pilot', version, 'engine', 'Overlay.cs')));
check('the engine is cached under the data folder', existsSync(join(home, 'desk-pilot', 'data', 'engine')));
const launcherPid = transport.pid;
await client.close();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
const left = spawnSync('tasklist', ['/FI', `PID eq ${launcherPid}`], { encoding: 'utf8' }).stdout.includes('desk-pilot');
check('closing the client ends the launcher', !left);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures === 0 ? '\ncrate: OK' : `\ncrate: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
