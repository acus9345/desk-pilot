# desk-pilot

**Windows only.** A Claude Code plugin that gives Claude eyes and hands on the real Windows desktop: it sees the actual screen, reads each window's controls, and drives the real mouse and keyboard.

Three tools (deliberately three: every schema costs tokens):

| tool | what it does |
| --- | --- |
| `screen_view` | the live screen, a window (any window, by title or handle) or a region, as a real image with coordinate rulers |
| `desktop_control` | click (also Ctrl/Shift/Alt-click), drag, scroll, type, keys, focus, waitFor, move/resize/minimize/maximize/restore a window, list windows, read a window's UI Automation controls |
| `desktop_sequence` | many actions in one call, checked step by step, with one frame at the end |

## Token cost compared with Windows-MCP

Measured on 2026-10-25 in headless Claude Code runs (Opus 5.5, Claude Code 2.1.304) on one 2560×1600 Windows 11 machine, against Windows-MCP 0.8.5. Numbers are input tokens added to the conversation.

| | desk-pilot | Windows-MCP |
| --- | --- | --- |
| Fixed cost per session, tool search on (default) | +191 | +327 |
| Fixed cost per session, tool search off | +3,655 | +7,857 |
| One full-screen screenshot | +1,948 (1356×847) | +3,006 (1728×1080) |
| Reading the UI | +4,455 (`controls`, one busy window) | +7,356 (`Snapshot`, whole desktop) |
| Loading one tool's schema on first use | +679 (`screen_view`), +1,532 (`desktop_control`) | +564 (`Screenshot`), +931 (`Snapshot`) |
| Tools | 3 | 20 |

Where the difference comes from:

- Screenshots are shrunk to the size Claude actually uses, an unchanged screen is not sent again, and `diff` sends only the region that changed.
- `desktop_sequence` runs a multi-step task (click, type, Enter, ...) in one call; each extra call is another model round trip over the whole conversation. This saving was not measured against Windows-MCP.

Caveats: the two UI reads differ in scope (one window vs. the whole desktop). Windows-MCP covers more ground (launching apps, virtual desktops, files, registry, processes, browser DOM), which is part of why its schemas are larger.

## Install

From a terminal:

```bash
claude plugin marketplace add acus9345/desk-pilot
claude plugin install desk-pilot@desk-pilot
```

or inside an interactive `claude` session: `/plugin marketplace add acus9345/desk-pilot`, then `/plugin install desk-pilot@desk-pilot`. Start a new session afterwards to load it.

From a checkout, without installing: `claude --plugin-dir path\to\desk-pilot`.

Requirements: Windows 10 2004 or later / Windows 11, Node 22.19+ on `PATH`. Nothing else to install: on first use the plugin compiles its engine with the C# compiler that ships with .NET Framework 4.x in every Windows 10/11 install (~0.2 s), caches it by source hash, and reuses it.

## How it works

`dist/server.mjs` is a stdio MCP server. It drives one long-lived engine process (`engine/*.cs`), which talks JSON lines and keeps everything warm: per-monitor DPI awareness, the UI Automation client, the Esc hotkey. If the engine dies it is restarted on the next call (at most 3 times in 10 minutes); past that, each request runs in its own short-lived engine, so the tools keep working, only slower.

## What it does well

**Controls instead of pixels.** `controls` lists a window's operable, on-screen controls as `index [Role] 'Name' @ x,y WxH`, with `disabled`, `focused`, `on/off` and `selected`. Click by name (`target: "Save", role: "Button"`) or by index. Before clicking, the control is looked up again: if it is disabled it is refused, if it is scrolled away it is scrolled into view, if the name is ambiguous you get the candidates, and if the listing is stale the call fails loudly instead of clicking whatever moved into that slot.

**Checked actions.** Every input action reports where input actually went (the window in front and the control with keyboard focus). `type` reads the text back (`verified` / `NOT verified` / `unknown`). Any step can carry `expect`, for example `{foreground: "Save As"}`, `{exists: "OK"}`, `{gone: "Loading"}` or `{value: "hello"}`: the step waits for it and fails if it never happens. `waitFor` is a step that only waits.

**Modifier clicks and window layout.** `modifiers: ["ctrl"]` (or `shift`, `alt`, `win`) holds keys for exactly one click, drag or scroll, and always releases them, so a stuck Ctrl can never turn later input into shortcuts. `action: "window"` moves and resizes a window's *visible* frame (the rectangle `windows` reports, without Windows' invisible resize border), or minimizes, maximizes and restores it; it checks the result and says so when an app snaps itself to a different size.

**Cheap frames.** Frames are shrunk to Claude's image budget by the engine, so the coordinate line under each image is exact, not a guess. An identical frame is not sent again. `diff: true` (the default for the end frame of a batch) sends only the region that changed. `maxEdge` asks for a smaller glance and `region` zooms in. Rulers are drawn after scaling, so their labels stay readable. End frames wait until the screen stops changing instead of sleeping a fixed time.

**Safety.**
- A `desktop_sequence` declared `medium`/`high` (on the batch or on any step) is refused before anything runs unless it carries `confirm: true`. A `PreToolUse` hook then turns that confirm into a Claude Code permission prompt listing every step, even when the tool is on your allow list. `dryRun` lists the plan.
- A batch stops at the first failure: a refused focus, a missing control, or an unmet `expect`. Input is never sent to a window other than the one the step names.
- An action whose outcome is unknown (the engine died or timed out after receiving it) is reported as such and never retried. A capture, which has no side effects, is retried.
- While Claude is acting, a small banner at the top of the screen says so, and **Esc** stops the batch between steps, even during a wait. The banner is excluded from screen capture, so it never covers what Claude is looking at. Interrupting the turn in Claude Code stops it the same way.


## Settings

Environment variables, for example in the `env` block of Claude Code's `settings.json`:

| variable | default | |
| --- | --- | --- |
| `DESK_PILOT_IMAGE_MAX_EDGE` | 1568 | longest side of a delivered frame |
| `DESK_PILOT_IMAGE_MAX_PIXELS` | 1150000 | pixel budget of a delivered frame |
| `DESK_PILOT_MAX_SEQUENCE_STEPS` | 24 | steps per batch |
| `DESK_PILOT_STEP_SETTLE_MS` | 100 | pause after each batch step |
| `DESK_PILOT_CAPTURE_SETTLE_MS` | 1000 | longest wait for the screen to settle before a frame |
| `DESK_PILOT_TIMEOUT_MS` | 20000 | per action; past it the engine is restarted and the action reported as unknown |
| `DESK_PILOT_DEDUP_TTL_MS` | 300000 | how long an unchanged frame is not re-sent |
| `DESK_PILOT_TAKEOVER` | on | the banner and Esc hotkey (`0` turns them off) |
| `DESK_PILOT_CAPTION` | English | banner text |

## Limits

- Windows blocks injected input into elevated (administrator) windows unless Claude Code itself runs elevated.
- Canvas-drawn and some Electron windows expose little or no control tree; use frames there.
- Esc and the banner are unavailable once the engine has fallen back to one-shot mode.

## Developing

```bash
npm install
npm run build
node test/e2e.mjs
```

`dist/server.mjs` is committed so the plugin installs without `npm install`; rebuild after editing `src/`. The engine recompiles itself whenever `engine/*.cs` changes. `test/e2e.mjs` needs an interactive desktop and only ever touches windows it creates itself.

## License

MIT
