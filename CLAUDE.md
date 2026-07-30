# claude-session-namer - agent context

Zero-dependency Node CLI + Claude Code Stop hook that auto-titles Claude Code sessions and re-titles them on drift. `docs/design.md` is the spec of record - read it before changing decision logic.

## Architecture

- `bin/cli.js` - command dispatch, thin
- `src/paths.js` - every filesystem location; `CLAUDE_CONFIG_DIR` and `CLAUDE_SESSION_NAMER_APP_STORE` env overrides make all tests hermetic
- `src/transcript.js` - session JSONL parsing, title records, vague-title detection, excerpt builder, append (single-write, newline-guarded)
- `src/state.js` - `state.json` + `config.json`, atomic pid-scoped tmp+rename writes
- `src/titler.js` - prompt construction (drift + restyle modes), `claude -p` invocation, response parsing, `matchesFormat`
- `src/appstore.js` - READ-ONLY walker of the desktop app's session store
- `src/worker.js` - the decision pipeline; every protection and gate lives here
- `src/hook.js` - Stop-hook entry: guards, then detached worker spawn
- `src/settings.js` - `settings.json` hook surgery + wrapper script
- `src/commands.js` - backfill, sweep-done, rename, protect, list, search, config, sync-plan, sidebar-setup. Also holds the sidebar-sync task prompt, the one copy the paste block and `skills/setup-sidebar-sync/SKILL.md` both have to match
- `.claude-plugin/{plugin,marketplace}.json` + `hooks/hooks.json` - the plugin install path (repo is its own marketplace, `source: "./"`). Registers the same Stop hook `src/settings.js` writes, via `${CLAUDE_PLUGIN_ROOT}/bin/cli.js hook`. `bin/claude-session-namer` puts the CLI on the Bash PATH for plugin installs. `skills/setup-sidebar-sync/` is plugin-only too - it stays out of the npm tarball, and `sidebar-setup` is the npm equivalent

## Domain facts that cost real debugging to learn

- **Titles live in two places.** Transcript `custom-title` JSONL records drive the CLI (resume picker, `list`); the desktop app's sidebar reads its own registry (one JSON file per session under `~/Library/Application Support/Claude/claude-code-sessions/`, macOS). Appending transcript records never updates the sidebar; the only external write path to the sidebar is the app's session-rename API, available to agents inside a session (`sync-plan` computes the diff for such an agent to apply).
- **The app writes its own auto-titles as `custom-title` records** - identical record type to a human rename, re-asserted every ~14 lines on active sessions. Record type says nothing about authorship. The ONLY authorship signal is `titleSource: 'user' | 'auto'` in the app-store files.
- **Active sessions get the app's REGISTRY title re-asserted into the transcript** (observed live 2026-07-29): the app's auto-titler writes its own record after ours and keeps re-asserting it, so our appended title is displaced, both sides end up agreeing on the app's name, and the plain diff goes empty. `sync-plan` detects that case - state `written` non-empty, transcript title not ours, registry `auto` and holding the displacing title - and re-proposes our newest title for the rename API to push. `appstore.isDisplaced` is that test, shared with the worker's mid-generate guard so the two cannot drift: a title arriving mid-call that the registry holds and marks `auto` is the app displacing us, not a rename, and the worker writes over it instead of abandoning the call. An earlier build was observed adopting the newest transcript record instead, so this is version-dependent; keep the mechanism best-effort.
- **Hooks fire in headless (`claude -p`) sessions too.** The worker's own title calls would recurse; `CLAUDE_SESSION_NAMER_WORKER=1` is the guard. Those headless calls also persist transcripts into the tmpdir project dir - the sweep excludes that dir and skips sessions whose first user text matches one of `titler.OUR_PROMPT_SIGNATURES`. That list is the two title-call signatures plus the sidebar routine's task-prompt opening line, and `SIDEBAR_TASK_PROMPT` is built from that constant, so the routine's own scheduled runs are never titled - a rename of those sessions is what broke the routine's cleanup step in the field. `titler.isOurOwnPrompt` is the shared test: worker, backfill, and sweep-done all use it.

## Invariants - do not break

- Zero npm dependencies, dev and prod. CommonJS. Node >= 18. Test runner: `npm test` (`node --test test/*.test.js` - the glob form matters on Node 22+).
- The hook never disturbs a session: silent exit on every guard path, detached unref'd worker, stdin released on timeout, async spawn errors swallowed.
- Crash ordering on the titled path: claim the title in state, save, append to transcript, record, save. A crash between any two steps must never make our own title read as someone else's.
- `--dry-run` writes nothing, anywhere. The app store is never written, only read. `settings.json` surgery must round-trip unrelated keys byte-faithfully and abort (tagged `err.expected`) rather than guess on malformed shapes.
- The desktop app's scheduled-task registry is app-private, like its session store: we supply the instructions that create the sidebar-sync routine and the app writes it. Never write `~/.claude/scheduled-tasks/` - the schedule and the approved tool permissions live with the app, and a task it did not create carries neither.
- Manual protection: `rename`/`protect` state flag and app `titleSource: 'user'` are hard skips; both are re-checked on fresh state after the (up to 90s) model call before any write.
- The prefix config is a format contract both ways - see design.md 'Title format'.
- The done marker (`✓ `) is a prefix on a title, never part of one: strip it before every prompt and every format check, re-apply it after, and put both strings in `written` so displacement, echo recognition, and sync-plan keep matching. Only `sweep-done` applies it; only the worker's resume path removes it, mechanically. See design.md 'Done marker'.
- The version string lives in three files (package.json and both plugin manifests) and the Stop hook timeout in two (`src/settings.js` and `hooks/hooks.json`). `test/plugin.test.js` fails when any of them drift apart.

## Conventions

- TDD; tests assert behavior through the real filesystem (temp dirs), never mock internals. Injectable seams for process boundaries only (`runner`, `spawn`, stream, env-var store paths).
- Comments explain why, not what. Plain engineering register in all user-facing text - no marketing vocabulary.
- This tool depends on two undocumented Anthropic formats (transcript JSONL, app-store files). Every read is best-effort with a benign failure mode (titles stop applying; protection degrades to heuristics - never corruption, never a crash). Keep new code on that posture, and keep the README honest about it.
