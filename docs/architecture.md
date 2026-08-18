# Grok Build Desktop Architecture

Grok Build Desktop is a Tauri 2 desktop shell with a React workbench and a Rust
Core host. It never talks to a model API directly. Version 0.5 keeps one
`grok agent stdio` process alive and uses Grok's first-party ACP protocol; the
old one-shot streaming CLI runner remains only as an explicit compatibility
fallback.

## Runtime Layers

- React (`src/`) renders the workbench: conversations sidebar, composer with
  workflow/effort/action-policy controls, streaming conversation, capability
  inspector, Tools & Skills hub, settings, terminal dock, and static preview.
- Tauri commands in `src-tauri/src/lib.rs` call local capabilities; the run
  engine lives in `src-tauri/src/runs/` (Core host, db, event adapter, process,
  queue).
- A Grok Core run flows:
  1. The frontend builds the argument list (`buildGrokArgs` in `src/App.tsx`)
     and calls `invoke('enqueue_run', { prompt, cwd, args })`.
  2. `RunQueue` (`src-tauri/src/runs/queue.rs`) persists the run to
     `runs.sqlite` (FIFO, survives restart). `runs/core.rs` starts or reuses a
     process-group-isolated `grok agent stdio` Core host, performs ACP
     `initialize`, then uses `session/load` or `session/new` followed by
     `session/prompt`.
  3. ACP `session/update` notifications are translated into the stable desktop
     event shape while their complete payload is retained for tool, task and
     subagent rendering; `lib.rs`
     forwards it as Tauri events (`grok-desktop://run-event`,
     `grok-desktop://run-state-changed`, `grok-desktop://queue-changed`).
  4. `src/lib/streamStore.ts` accumulates a `RunSnapshot` consumed via
     `useSyncExternalStore` hooks; markdown is rendered off-thread by a Web
     Worker (`markdown-it` + `highlight.js`) and sanitized with DOMPurify before
     injection.
- The grok binary is resolved from `GROK_DESKTOP_GROK_CMD`, else the first
  `grok` found on the app's fixed search path (`~/.local/bin`, `~/.grok/bin`,
  `~/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, system dirs).
- Grok auth status is detected without reading secrets: Grok Build Desktop
  checks installation, `XAI_API_KEY` / `GROK_CODE_XAI_API_KEY`, and whether
  `~/.grok/auth.json` (or `~/.grok/auth`) contains cached login data.
- Grok login starts in Terminal through `start_grok_login`, keeping the
  official CLI authorization flow outside the app.
- Grok ecosystem discovery runs through `grok inspect`, while managed
  capability commands use `grok mcp list`, `grok mcp doctor`, `grok plugin
list`, and `grok sessions list`. The right inspector separates Context,
  Skills, MCP, Agents, Plugins, Hooks, Permissions, and Desktop.
- The Skills hub installs curated skills as real `SKILL.md` files under
  `~/.grok/skills` for the CLI to discover.
- The macOS desktop bridge (`src-tauri/src/desktop.rs`) is read-only:
  allowlisted apps, hard-coded AppleScript with no interpolated input, and an
  audit log under `~/.grok-desktop/audit/`.
- Browser automation runs through `scripts/browser_automation.py` and the
  `browser-use` Python package (requires `BROWSER_USE_API_KEY`).
- Repository absorption runs through `scripts/absorb_repo.py` and writes
  manifests under `absorbed/`; the Absorb Repo panel calls the same script
  through the Rust bridge.
- Persistence: conversations/tabs and UI preferences live in `localStorage`;
  `~/Library/Application Support/Grok Desktop/session_state.json` is
  round-tripped by `load_session_state`/`save_session_state` (written
  atomically); the run queue and prompt library live in
  `~/Library/Application Support/com.grok.desktop/runs.sqlite` and
  `prompts.sqlite`.
- Auxiliary external commands are wrapped with a timeout so missing or stuck
  CLIs do not permanently block the app; streaming runs instead use a
  no-output watchdog that only fires when grok is truly silent.
- The current visual direction is captured under `docs/design/` (latest:
  `grok-desktop-10pt-power-clean-ui.png`).

## Environment Overrides

- `GROK_DESKTOP_PYTHON`: Python executable for scripts and package checks.
- `GROK_DESKTOP_GROK_CMD`: Grok CLI executable (overrides path search).
- `GROK_DESKTOP_RUNTIME`: `acp` forces the persistent Core host; `legacy`
  forces the old one-process-per-turn streaming JSON runner. When unset, a
  normal executable named `grok` uses ACP and test/custom binaries retain the
  compatibility runner.
- `GROK_DESKTOP_NO_OUTPUT_TIMEOUT_SECS`: streaming watchdog — how long a run
  may go without printing anything to stdout before it is killed as wedged.
  The timer resets on every line, so an actively thinking grok never trips it.
  Defaults to 420 seconds.
- `GROK_DESKTOP_QUIET_GROK_STDERR`: set to `1` to stop mirroring grok's
  stderr lines (prefixed `[grok stderr]`) to the host process during
  streaming runs. Off by default.
- `GROK_DESKTOP_COMMAND_TIMEOUT_SECS`: timeout for auxiliary commands
  (inspect, mcp, login, scripts) — not streaming runs. Defaults to 240.
- `GROK_DESKTOP_VERBOSE_GROK_STDERR`: set to `1` to show raw grok stderr in
  auxiliary command output instead of filtering tracing noise.
- `GROK_DESKTOP_GROK_ARGS`: whitespace-split argument template with `{prompt}`
  and `{mode}` placeholders. Only affects the legacy non-streaming
  `run_grok_task` path — streaming runs get their arguments from the UI.
- `GROK_DESKTOP_GROK_MAX_TURNS`: headless turn cap on the legacy path.
  Defaults to 12 (the streaming UI always sends `--max-turns 12`).
- `XAI_API_KEY`: optional Grok API key auth visible to the spawned CLI process.

## Next Integration Targets

- Plan Mode view: separate "plan" from "apply" (the raw
  `--permission-mode plan` primitive is already exposed in Settings).
- Sub-agent visualization for fan-out runs.
- Native in-process Core: replace the ACP child transport with a direct
  `xai-grok-shell` Rust adapter once its embedding API is stable. The renderer
  and run-event contract do not change.
- A larger, community-driven Skills catalog.
- Notarized macOS builds and a Linux build target.
