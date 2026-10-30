---
name: desk-pilot
description: Operate native Windows apps with desk-pilot (controls over screenshots, name targets, batches, risk). Use for looking at, clicking, typing into or drawing in a real Windows app.
---

# Operating the Windows desktop with desk-pilot

Everything happens on the person's real screen, mouse and keyboard. Windows only.

## Orient cheaply
1. `desktop_control {action: "windows"}` - every visible window with its hwnd, bounds, and which one is in front.
2. `desktop_control {action: "controls", title: "<window>"}` - the window's operable, on-screen controls as `index [Role] 'Name'` plus `disabled`, `focused`, `on/off`, `selected`. No image, so it is far cheaper than a screenshot. Add `bounds: true` only when you need positions.
3. `screen_view` only when the tree is empty or useless (canvas, game, custom-drawn UI, some Electron apps), or when you need to see what is drawn rather than what is declared.

## Act on controls, not pixels
- `target: "Save"` (add `role: "Button"` if several match) clicks a control by name; `target: 4` uses an index from the last listing. Both re-find the control right before clicking, refuse a disabled one, scroll it into view if needed, and fail loudly if the listing went stale.
- `type` with a `target` focuses that control first. Text goes in as one paste (clipboard restored); `mode: "keys"` types keystrokes instead.
- `modifiers: ["ctrl"]` or `["shift"]` on a click adds to or extends a selection (files, list rows); they are released after the click.
- `{action: "launch", app: "Notepad"}` starts an app by Start Menu name, program, path or URL, and reports the window it opened. Add `args` and `cwd` for programs.
- `{action: "clipboard"}` reads the clipboard, and `text` sets it.
- `{action: "screens"}` lists monitors; the index is what `screen_view` takes as `screen`.
- `screen_view` with `annotate: true` boxes and numbers a window's controls on the image, and `target` takes the number. Use it when names alone do not tell controls apart.
- `{action: "window", title, x, y, width, height}` places a window's visible frame; `show: "minimize" | "maximize" | "restore"` changes its state. Arrange windows before a task so controls are on screen.
- `{action: "draw", strokes: [[[x,y],[x,y],...], ...], smooth: true}` draws in the app in front; the button lifts between strokes, and `button: "right"` draws with the right button. Compute the points yourself, and keep them few: each one costs tokens, and `smooth` curves through them.
- `drag` takes `target` and `toTarget` to move one control onto another, and `durationMs` for apps that need a slower drag.
- `down` and `up` hold a button or key across steps (`{action: "down", key: "shift"}`, then clicks, then `{action: "up"}`). Results say `HOLDING` until released, so always finish with `up`. `holdMs` on `click` is a long press; on `key` it holds and repeats.
- A short `label` on a pointer action shows the person what you are doing, beside the pointer.
- Pass `title` (or `hwnd`) on input actions: that window is brought to the front first, and the action fails instead of typing into whatever else is in front.

## Every action reports what happened
- Input actions return the focused control and the window in front afterwards; `type` reads the text back (`verified` / `NOT verified` / `unknown`).
- Add `expect` to make it a check, e.g. `{foreground: "Save As"}`, `{exists: "OK"}`, `{gone: "Loading"}`, `{value: "hello"}`, `{focused: "Search"}`. The step waits up to `timeoutMs` (1500) and fails if the effect never shows. `waitFor` is a step that only waits (default 5000 ms).

## Batch with desktop_sequence
- Put a task's low-risk steps in one call: focus, click, type, key, waitFor, ... and look once at the end. That, not click speed, is what makes desktop work fast.
- It stops at the first failure (a refused focus, a missing control, an unmet `expect`), so nothing runs against the wrong window. An action whose outcome is unknown is never retried for you - look before repeating it.
- A batch sends no frame by default; its result gives the final focus and foreground. Pass `capture: "window"` when you need to see the result. That frame waits until the screen stops changing and shows only what changed since your last frame of that window.
- Steps take `desktop_control`'s fields. A misspelled field is refused before anything runs.

## Frames
- Follow the coordinate line under each frame. A shrunk image gives the multiplier; ruler labels are already screen coordinates.
- Text with letters about 8 px tall or larger is readable in a default frame. For anything smaller, or exact codes, frame one window or zoom with `region: "x,y,w,h"`. `maxEdge: 800` makes a cheaper glance; `diff: true` sends only what changed.
- `unchanged` means you already have this exact frame. If you no longer have it (after compaction, or in a subagent), pass `forceImage: true`.

## Risk
- Declare `medium`/`high` (on the batch or a step, with `riskNote`) for anything that sends, deletes, pays, publishes, overwrites, or closes unsaved work. Such a batch is refused without `confirm: true`; pass it only after the person agreed in chat, and Claude Code will then ask them to approve the exact steps.
- If a result says the person pressed Esc (the Stop and Take over buttons report the same), stop and ask before doing anything else on the desktop.
- Windows blocks input into elevated (administrator) windows; say so instead of retrying.
