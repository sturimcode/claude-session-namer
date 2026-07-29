# claude-session-namer - Design

2026-07-29

## Problem

Claude Code names sessions from a truncated first message ('i need to write some sort of...') or leaves them as 'New session'. Sidebars and resume pickers fill with vague names, and sessions get lost. Existing tools each solve half the problem:

- `claude-rename` writes real titles but names a session once, after the first exchange, and never revisits - long sessions outgrow their names.
- `claude-chat-namer` stores names in its own sidecar metadata, so the native sidebar never sees them, and it derives names from the first user message - roughly what the vague defaults already are.

## What this tool does

A zero-dependency Node CLI plus a Claude Code Stop hook that keeps session titles accurate for the life of the session:

- Writes native `custom-title` records the Claude Code UI actually displays - no sidecar
- Titles a session after the first real exchange, then re-titles when the conversation drifts
- Backfills titles across all existing untitled/vague sessions
- Manual rename, protect, list, and search commands
- No API key - titles are generated via `claude -p --model haiku` on the user's existing subscription

MIT license. npm distribution now (`npm install -g claude-session-namer`, then `claude-session-namer install`), Claude Code plugin wrapper as a later phase. A global install rather than `npx`: the hook wrapper embeds the absolute path to the CLI, and an npx path points into a cache directory that gets pruned.

## Mechanism

### Hook

`install` registers a Stop hook in `~/.claude/settings.json`. On every Stop event the hook script:

1. Reads the hook payload from stdin (session ID, transcript path)
2. Exits immediately if `CLAUDE_SESSION_NAMER_WORKER=1` is set in the environment - this is the recursion guard; our own headless title calls also fire Stop hooks, and the worker sets this var when spawning `claude -p`
3. Spawns the worker as a detached background process and exits

The hook adds zero perceptible latency and produces no output (`suppressOutput`).

### Worker

The worker owns all logic:

1. Loads per-session state from `~/.claude/claude-session-namer/state.json`
2. Decides whether to act (see Titling decisions below); most invocations exit without an LLM call
3. Builds a compact excerpt from the transcript JSONL - recent user and assistant text turns, truncated per turn and overall
4. Calls `claude -p --model haiku` (with `CLAUDE_SESSION_NAMER_WORKER=1` in env) using a strict prompt that returns either `KEEP` or a title
5. Appends a `{"type":"custom-title","customTitle":"...","sessionId":"..."}` record to the session transcript file - a single atomic append
6. Records what it wrote in state

### Titling decisions

- **First title:** when a session has at least one real user/assistant exchange and no non-vague title.
- **Drift re-title (growth-gated):** re-check only when the session's user-turn count has grown ~2x since the last check. Calls scale with the log of session length - a 100-turn session gets roughly 5 checks lifetime. The check sends the current title plus a recent excerpt; the model answers `KEEP` or supplies a replacement.
- **Protection is explicit, never inferred from the record.** Live-data testing killed the original assumption here. The desktop app files its own auto-titles as `custom-title` records - the same record type a hand rename produces - and re-asserts the cached value every ~14 transcript lines. On the author's machine, 68 of 69 titled sessions carried a `custom-title` and only one carried an `ai-title`. So the record type says nothing about who wrote the title, and treating a foreign `custom-title` as a human's manual-locked nearly every session on first sight, which is the one thing that defeats the whole tool. What protects a title instead:
  - The drift check is KEEP-biased, and the prompt tells the model to output `KEEP` when the current title reads like a deliberate personal label (a person's name, a date, a note like 'Revisit Monday') rather than a description of the work.
  - `rename` and `protect` set the manual flag in state. That is permanent until `unprotect`, and it is the only guarantee on offer.
- **App auto-titles are replaceable, by design.** Replacing them is the product. Known-vague titles ('New session', truncated first-message titles) are fair game for the same reason.
- **Live sessions adopt the newest title record.** The app does re-write the title into the transcript every few turns while a session is in use, but what it re-writes is whatever the last `custom-title` record says - it adopts, it doesn't displace (verified on live desktop data). So a re-title on a session still in use applies immediately and then gets echoed back by the app's own writes, which duplicate our string rather than compete with it; the `written` list in state already recognizes those echoes as ours. Backfill skips sessions touched in the last 10 minutes for an unrelated reason: those sessions have a Stop-hook worker of their own, and a sweep would race it.

### Title format

`[Prefix] Short phrase`, hard-capped at 45 characters. The prefix is optional per user: a config file (`~/.claude/claude-session-namer/config.json`, default `{"prefix": true}`) controls it, toggleable via `claude-session-namer config prefix on|off` or `install --no-prefix`. With prefixes off, titles are the bare phrase. Prefixes are free-form but normalized: the prompt includes the user's previously-used prefixes with an instruction to reuse one when it fits and coin a new one only for a genuinely new workstream. Seen prefixes and counts live in state.

## CLI commands

- `install` / `uninstall` - register/remove the Stop hook in `~/.claude/settings.json` (surgical JSON edit, preserves everything else in the file)
- `backfill [--dry-run] [--model <m>] [--project <path>]` - sweep every project dir under `~/.claude/projects/`, title all vague/untitled sessions; dry-run prints planned titles without writing; throttled to stay clear of rate limits
- `rename <session-id> "title"` - set a title by hand, marked manual
- `protect <session-id>` - mark a session manual without touching its title, so whatever it is named now stays
- `unprotect <session-id>` - drop the manual mark and let drift re-titling resume
- `list [--project <path>]` - sessions with titles, newest first; protected sessions carry a trailing `[protected]`
- `search <query>` - match against titles and transcript content

## State

`~/.claude/claude-session-namer/state.json`:

- Per session: last-check user-turn count, titles written by the tool, manual flag (set only by `rename` and `protect`)
- Global: seen prefixes with usage counts
- Corrupt or missing state degrades gracefully - worst case a session is re-checked earlier than needed

## Policy and fragility posture

Verified against current Anthropic docs (2026-07-29):

- Headless `claude -p` is a documented, sanctioned interface for programmatic use; usage counts against the user's subscription normally. No policy restriction on local automated invocation. This is distinct from the prohibited pattern of extracting subscription OAuth tokens for third-party apps - this tool only invokes the official CLI locally as the user.
- The transcript JSONL format is explicitly internal and can change between releases. Writing the `custom-title` record mimics a record type the app itself writes, but it is unsupported territory. Failure mode is benign: an append-only record the app either recognizes or ignores; a format change means titles stop applying until patched, never session corruption.
- Mitigation as built: the record shape is hardcoded - the same `custom-title` type the app itself writes - rather than feature-detected from records already in the transcript. Feature detection was considered and dropped: a session with no title record yet has nothing to detect from, which is exactly the case that matters. If the format changes, titles stop applying until the writer is patched. The README states plainly that the tool touches unsupported internals and may break on a Claude Code update.

## Testing plan

- Unit: excerpt builder, vague-title detection, state transitions, settings.json hook surgery (round-trip preserves unrelated keys)
- Integration on the author's machine: live session gets titled after first exchange; drift re-title fires on a genuinely drifting session; manual rename survives drift; recursion guard holds (no hook storm from worker calls)
- Desktop app check: confirm sidebar reflects titles live or on reload (unknown until tested)
- Concurrency: append to an actively-written session file under load, verify no interleaving
- Backfill dry-run over the author's full history before any real backfill

## Rollout

1. Private repo at `github.com/sturimcode/claude-session-namer`
2. Build, test locally against real sessions, run and verify backfill
3. Public: README (install, what it does, unsupported-internals caveat, cost note), npm publish, repo public

## Ongoing maintenance

Recurring research sweep (monthly, set up as a scheduled task once the tool ships):

- **Claude Code changes:** scan release notes and docs for transcript-format changes, a public session-title API, or new hook capabilities. A format change means patching the record writer; a public title API means replacing the JSONL append entirely.
- **Competing tools:** re-check claude-rename, claude-chat-namer, and search for new entrants. Fold in genuinely better ideas; note in the README how this tool differs.
- Each sweep produces a short note in `docs/research/` with date, findings, and any resulting issues.

## Later (V2+)

- Claude Code plugin wrapper (hooks + slash commands via plugin distribution)
- Optional API-key mode for users who prefer metered billing over subscription usage
- Swap the JSONL append for a public title API if Anthropic ships one
