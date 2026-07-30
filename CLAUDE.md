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
- `src/commands.js` - backfill, rename, protect, list, search, config, sync-plan
- `.claude-plugin/{plugin,marketplace}.json` + `hooks/hooks.json` - the plugin install path (repo is its own marketplace, `source: "./"`). Registers the same Stop hook `src/settings.js` writes, via `${CLAUDE_PLUGIN_ROOT}/bin/cli.js hook`. `bin/claude-session-namer` puts the CLI on the Bash PATH for plugin installs

## Domain facts that cost real debugging to learn

- **Titles live in two places.** Transcript `custom-title` JSONL records drive the CLI (resume picker, `list`); the desktop app's sidebar reads its own registry (one JSON file per session under `~/Library/Application Support/Claude/claude-code-sessions/`, macOS). Appending transcript records never updates the sidebar; the only external write path to the sidebar is the app's session-rename API, available to agents inside a session (`sync-plan` computes the diff for such an agent to apply).
- **The app writes its own auto-titles as `custom-title` records** - identical record type to a human rename, re-asserted every ~14 lines on active sessions. Record type says nothing about authorship. The ONLY authorship signal is `titleSource: 'user' | 'auto'` in the app-store files.
- **Active sessions adopt the newest transcript title record** (the app re-writes whatever the last record says - it never fights an appended title at the transcript layer).
- **Hooks fire in headless (`claude -p`) sessions too.** The worker's own title calls would recurse; `CLAUDE_SESSION_NAMER_WORKER=1` is the guard. Those headless calls also persist transcripts into the tmpdir project dir - the sweep excludes that dir and skips sessions whose first user text matches `PROMPT_SIGNATURE`.

## Invariants - do not break

- Zero npm dependencies, dev and prod. CommonJS. Node >= 18. Test runner: `npm test` (`node --test test/*.test.js` - the glob form matters on Node 22+).
- The hook never disturbs a session: silent exit on every guard path, detached unref'd worker, stdin released on timeout, async spawn errors swallowed.
- Crash ordering on the titled path: claim the title in state, save, append to transcript, record, save. A crash between any two steps must never make our own title read as someone else's.
- `--dry-run` writes nothing, anywhere. The app store is never written, only read. `settings.json` surgery must round-trip unrelated keys byte-faithfully and abort (tagged `err.expected`) rather than guess on malformed shapes.
- Manual protection: `rename`/`protect` state flag and app `titleSource: 'user'` are hard skips; both are re-checked on fresh state after the (up to 90s) model call before any write.
- The prefix config is a format contract both ways - see design.md 'Title format'.
- The version string lives in three files (package.json and both plugin manifests) and the Stop hook timeout in two (`src/settings.js` and `hooks/hooks.json`). `test/plugin.test.js` fails when any of them drift apart.

## Conventions

- TDD; tests assert behavior through the real filesystem (temp dirs), never mock internals. Injectable seams for process boundaries only (`runner`, `spawn`, stream, env-var store paths).
- Comments explain why, not what. Plain engineering register in all user-facing text - no marketing vocabulary.
- This tool depends on two undocumented Anthropic formats (transcript JSONL, app-store files). Every read is best-effort with a benign failure mode (titles stop applying; protection degrades to heuristics - never corruption, never a crash). Keep new code on that posture, and keep the README honest about it.
