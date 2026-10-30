# desk-pilot

**Windows only.** A Claude Code plugin(or any other agentic tool i guess)  that gives Claude eyes and hands on the real Windows desktop: it sees the actual screen, reads each window's controls, and drives the real mouse and keyboard.
<img width="1280" height="800" alt="screenshot 2026-10-30 171726" src="https://github.com/user-attachments/assets/b4921f41-82a6-4d66-8e73-a38f8d073ca4" />
<img width="347" height="400" alt="image" src="https://github.com/user-attachments/assets/8d387e20-6047-4192-b2d0-71cb43d70cd4" />(trust me dude its enough to do anything that has to be done on ui)



Three tools (deliberately three: every schema costs tokens):

| tool | what it does |
| --- | --- |
| `screen_view` | the live screen, a window (any window, by title or handle) or a region, as a real image with coordinate rulers |
| `desktop_control` | click (also Ctrl/Shift/Alt-click, triple-click, long press), drag (also onto a control), draw freehand, hold a button or key across steps, scroll, type, keys, focus, waitFor, launch apps, read and set the clipboard, move/resize/minimize/maximize/restore a window, list windows and monitors, read a window's UI Automation controls |
| `desktop_sequence` | many actions in one call, checked step by step, with one frame at the end |

## Token cost compared with Windows-MCP

Measured on 2026-10-25 for version 0.1.0 in headless Claude Code runs (Opus 5.5, Claude Code 2.1.304) on one 2560×1600 Windows 11 machine, against Windows-MCP 0.8.5. Numbers are input tokens added to the conversation. Later versions are cheaper still; see below.

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

Measured on 2026-10-30, 0.2.0 against the current code, on the same machine:

| | 0.2.0 | now |
| --- | --- | --- |
| All three tool schemas | 10,371 characters | 5,686 characters, with more actions |
| Frame after a batch | always | only when asked for |
| `controls` on the test window | 671 characters | 337 characters |

Real token counts for this table are not given: repeated headless runs jumped by about 100,000 tokens between identical calls, too much noise to read a difference of a few thousand.

Frame size was chosen by a blind reading test on 2026-10-30: random letters and digits in dark Segoe UI on white, on a 2560×1600 screen, read back by Claude from a full-screen frame. Tokens are Anthropic's published estimate (width × height ÷ 750), not a measurement.

| Longest side | Tokens per full-screen frame | 8 px letters | 10 px letters |
| --- | --- | --- | --- |
| 1024 | 874 | 9/14 | 41/42 |
| 1152 | 1,106 | 33/42 | 38/42 |
| 1280 | 1,365 | 79/84 | 83/84 |
| **1356 (default)** | 1,531 | 56/56 | 84/84 |

It is a small sample, and low-contrast text, coloured backgrounds or other fonts may read worse. For smaller text, frame one window or zoom with `region`.

Caveats: the two UI reads differ in scope (one window vs. the whole desktop). Windows-MCP covers more ground (launching apps, virtual desktops, files, registry, processes, browser DOM), which is part of why its schemas are larger.

## Install

From a terminal:

```bash
claude plugin marketplace add acus9345/desk-pilot
claude plugin install desk-pilot@desk-pilot
```

or inside an interactive `claude` session: `/plugin marketplace add acus9345/desk-pilot`, then `/plugin install desk-pilot@desk-pilot`. Start a new session afterwards to load it.

From a checkout, without installing: `claude --plugin-dir path\to\desk-pilot`.

As a standalone MCP server, for any MCP client:

```bash
cargo install desk-pilot
claude mcp add desk-pilot -- desk-pilot
```

This is a small Rust launcher that carries the same server and engine, and it still needs Node 22.19+ on `PATH`. You get the three tools only: no skill, and no `PreToolUse` hook, so `confirm: true` runs a risky batch without the approval prompt the plugin shows.

Requirements: Windows 10 2004 or later / Windows 11, Node 22.19+ on `PATH`. Nothing else to install: on first use the plugin compiles its engine with the C# compiler that ships with .NET Framework 4.x in every Windows 10/11 install (~0.2 s), caches it by source hash, and reuses it.

## How it works

`dist/server.mjs` is a stdio MCP server. It drives one long-lived engine process (`engine/*.cs`), which talks JSON lines and keeps everything warm: per-monitor DPI awareness, the UI Automation client, the Esc hotkey. If the engine dies it is restarted on the next call (at most 3 times in 10 minutes); past that, each request runs in its own short-lived engine, so the tools keep working, only slower.

## What it does well

**Controls instead of pixels.** `controls` lists a window's operable, on-screen controls as `index [Role] 'Name' @ x,y WxH`, with `disabled`, `focused`, `on/off` and `selected`. Click by name (`target: "Save", role: "Button"`) or by index. Before clicking, the control is looked up again: if it is disabled it is refused, if it is scrolled away it is scrolled into view, if the name is ambiguous you get the candidates, and if the listing is stale the call fails loudly instead of clicking whatever moved into that slot.

**Checked actions.** Every input action reports where input actually went (the window in front and the control with keyboard focus). `type` reads the text back (`verified` / `NOT verified` / `unknown`). Any step can carry `expect`, for example `{foreground: "Save As"}`, `{exists: "OK"}`, `{gone: "Loading"}` or `{value: "hello"}`: the step waits for it and fails if it never happens. `waitFor` is a step that only waits.

**Modifier clicks and window layout.** `modifiers: ["ctrl"]` (or `shift`, `alt`, `win`) holds keys for exactly one click, drag or scroll, and always releases them, so a stuck Ctrl can never turn later input into shortcuts. `action: "window"` moves and resizes a window's *visible* frame (the rectangle `windows` reports, without Windows' invisible resize border), or minimizes, maximizes and restores it; it checks the result and says so when an app snaps itself to a different size.

**Starting apps, the clipboard, numbered controls.** `launch` starts an app by Start Menu name, program, path or URL, with `args` and `cwd` for programs, and reports the window it opened. `clipboard` reads or sets the clipboard; a read is cut at 8,000 characters. `screens` lists monitors with work area and scale. `annotate: true` on `screen_view` boxes a window's controls on the image and numbers them, and `target` takes the number.

**Input apps can notice.** The pointer moves with real input events, and a click stays down for 40 ms, because canvases such as Paint's ignore instant clicks and pointer jumps.

**Drawing, dragging and holding.** `draw` takes strokes of `[x, y]` points, follows them at about 1000 px/s, and lifts the button between strokes; `smooth: true` curves through the points. `drag` can drop onto a control (`toTarget`), and `durationMs` sets its speed. `down` and `up` hold a mouse button or key across steps, so one stroke or a Shift-held selection can span several calls. Anything held is released by `up`, Esc, an interrupted turn, the `holdMs` deadline (30 s by default) or the engine closing, and the next engine releases what a killed one left down. Every result says `HOLDING` until it is released. `holdMs` on a click is a long press; on a key it repeats like a held key.

**Cheap by default.** Tool results list only what needs attention: a clean batch is a count and the final state, not a line per step. A batch sends no frame unless you pass `capture`. `controls` leaves out positions unless you pass `bounds: true`. Batch steps have no schema of their own, because they would repeat `desktop_control`'s fields; a misspelled field is refused before anything runs.

**Cheap frames.** Frames are shrunk to 1356 px by the engine, so the coordinate line under each image is exact, not a guess. An identical frame is not sent again. `diff: true` (always on for the frame after a batch) sends only the region that changed. `maxEdge` asks for a smaller glance and `region` zooms in. Rulers are drawn after scaling, so their labels stay readable. End frames wait until the screen stops changing instead of sleeping a fixed time.

**Safety.**
- A `desktop_sequence` declared `medium`/`high` (on the batch or on any step) is refused before anything runs unless it carries `confirm: true`. A `PreToolUse` hook then turns that confirm into a Claude Code permission prompt listing every step, even when the tool is on your allow list. `dryRun` lists the plan.
- A batch stops at the first failure: a refused focus, a missing control, or an unmet `expect`. Input is never sent to a window other than the one the step names.
- An action whose outcome is unknown (the engine died or timed out after receiving it) is reported as such and never retried. A capture, which has no side effects, is retried.
- While Claude is acting, the screen shows it, in the style of ego lite's agent mode: a blue glow around the primary screen, a dark arrow in a soft light at the pointer with an optional `label` beside it, and a control bar at the bottom. **Esc**, **Stop** or **Take over** stops the batch between steps, even during a wait; both buttons do the same thing as Esc. None of this takes focus or appears in a frame, and the bar ignores clicks during Claude's own pointer actions, so Claude cannot hit Stop by accident. Interrupting the turn in Claude Code stops it the same way.


## Settings

Environment variables, for example in the `env` block of Claude Code's `settings.json`:

| variable | default | |
| --- | --- | --- |
| `DESK_PILOT_IMAGE_MAX_EDGE` | 1356 | longest side of a delivered frame |
| `DESK_PILOT_IMAGE_MAX_PIXELS` | 1150000 | pixel budget of a delivered frame |
| `DESK_PILOT_MAX_SEQUENCE_STEPS` | 24 | steps per batch |
| `DESK_PILOT_STEP_SETTLE_MS` | 100 | pause after each batch step |
| `DESK_PILOT_CAPTURE_SETTLE_MS` | 1000 | longest wait for the screen to settle before a frame |
| `DESK_PILOT_TIMEOUT_MS` | 20000 | per action; past it the engine is restarted and the action reported as unknown |
| `DESK_PILOT_DEDUP_TTL_MS` | 300000 | how long an unchanged frame is not re-sent |
| `DESK_PILOT_TAKEOVER` | on | the overlay and Esc hotkey (`0` turns them off) |
| `DESK_PILOT_CAPTION` | English | second line of the control bar |
| `DESK_PILOT_OVERLAY_IN_FRAMES` | off | `1` lets the overlay into frames, for checking how it looks |

## Limits

- Windows blocks injected input into elevated (administrator) windows unless Claude Code itself runs elevated.
- Canvas-drawn and some Electron windows expose little or no control tree; use frames there.
- Esc and the overlay are unavailable once the engine has fallen back to one-shot mode, and `down` is refused there because nothing would stay running to release it.
- The overlay covers the primary monitor only. It was not tested on a second monitor.
- Input is a mouse and a keyboard: no pen pressure and no multi-touch gestures.
- `button: "back"` and `"forward"` were not confirmed end to end: on the test machine XMouseButtonControl took them before they reached the window. A low-level hook saw them being sent, and `key: "alt+left"` does the same job in most apps.
- `down` on a key does not auto-repeat; `key` with `holdMs` does.

## Developing

```bash
npm install
npm run build
node test/e2e.mjs
```

`dist/server.mjs` is committed so the plugin installs without `npm install`; rebuild after editing `src/`. The crate in `rust/` bundles `dist/` and `engine/`, so `cargo build && node test/crate.mjs` checks it end to end. The engine recompiles itself whenever `engine/*.cs` changes. `test/e2e.mjs` needs an interactive desktop and only ever touches windows it creates itself.

## License

MIT
