# claude-session-namer - Design

2026-07-29

## Problem

Claude Code names sessions on its own, but the names are vague ('New session', 'General coding session' - worse when a session starts with a screenshot) and never update once the work moves on. Sidebars and resume pickers fill with vague names, and sessions get lost. Existing tools each solve half the problem:

- `claude-rename` writes real titles but names a session once, after the first exchange, and never revisits - long sessions outgrow their names.
- `claude-chat-namer` stores names in its own sidecar metadata, so the native sidebar never sees them, and it derives names from the first user message - roughly what the vague defaults already are.

## What this tool does

A zero-dependency Node CLI plus a Claude Code Stop hook that keeps session titles accurate for the life of the session:

- Writes native `custom-title` records the Claude Code UI actually displays - no sidecar
- Titles a session after the first real exchange, then re-titles when the conversation drifts
- Backfills titles across existing untitled/vague sessions - recent ones by default (50 newest from the last 30 days), full history on `--all`
- Manual rename, protect, list, and search commands
- No API key - titles are generated via `claude -p` on the user's existing subscription, on haiku by default and sonnet if the user picks it

MIT license. Two distribution paths, both shipping: npm (`npm install -g claude-session-namer`, then `claude-session-namer install`) and a Claude Code plugin (see Plugin distribution below). A global npm install rather than `npx`: the hook wrapper embeds the absolute path to the CLI, and an npx path points into a cache directory that gets pruned.

## Mechanism

### Hook

`install` registers a Stop hook in `~/.claude/settings.json`. On every Stop event the hook script:

1. Reads the hook payload from stdin (session ID, transcript path)
2. Exits immediately if `CLAUDE_SESSION_NAMER_WORKER=1` is set in the environment - this is the recursion guard; our own headless title calls also fire Stop hooks, and the worker sets this var when spawning `claude -p`
3. Spawns the worker as a detached background process and exits

The hook adds zero perceptible latency and produces no output.

### Plugin distribution

The same hook is also registered by a Claude Code plugin, so a user can install the tool without npm and without running `install`. The repo is its own marketplace: `.claude-plugin/marketplace.json` at the root lists one plugin whose `source` is `"./"`, which makes the plugin root the repo root and puts `bin/` and `src/` inside `${CLAUDE_PLUGIN_ROOT}`. `.claude-plugin/plugin.json` carries the metadata, versioned in lockstep with package.json. `hooks/hooks.json` registers the Stop hook as `command -v node >/dev/null 2>&1 || exit 0; exec node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js" hook`, timeout 15 - the same entry point, the same timeout, and the same silence as the wrapper `install` writes. The node guard replaces the wrapper's fallback to the installer's own node, which a plugin install has no equivalent of: nothing recorded a path at install time.

- `suppressOutput` is a hook *output* field in the current schema, not config. It costs nothing here: the hook writes nothing to stdout on any path, so there is no output to suppress.
- Nothing about the worker changes. `src/hook.js` resolves the CLI as `path.join(__dirname, '..', 'bin', 'cli.js')`, so the spawn follows the package wherever it is unpacked, and state stays at `~/.claude/claude-session-namer` (`CLAUDE_CONFIG_DIR`) regardless of install method. Switching between npm and plugin keeps every title claim, protection flag, and prefix count. The `CLAUDE_SESSION_NAMER_WORKER=1` recursion guard is the first line of the hook and is unaffected by how the hook was registered.
- `skills/setup-sidebar-sync/SKILL.md` is the plugin's one skill, in the directory a plugin scans by default - no `skills` field in the manifest, which for a marketplace entry whose source resolves to the marketplace root would replace that default scan rather than add to it. It walks the user through creating the sidebar sync routine (see Desktop sidebar setup below). Plugin-only: `package.json`'s `files` whitelist keeps `skills/` out of the npm tarball, and `sidebar-setup` is what npm users get instead.
- `bin/claude-session-namer` is a shell wrapper over `bin/cli.js`. Claude Code adds an enabled plugin's `bin/` to the PATH of Bash tool calls, so it makes `backfill`, `rename`, `list` and the rest runnable inside a session on a plugin-only install. It does not reach the user's own shell; npm is still what puts the command there.
- Double-install is documented, not detected. Two registrations mean two workers per Stop event. The claim-before-append ordering is what keeps that benign rather than any lock: each worker re-loads state after its model call and claims its title in `written` before appending, so the second worker to finish sees the first one's title already recorded as ours. It appends its own title after it - a second `custom-title` record, which is a shape the app itself produces constantly - and the last record wins, the way it does for any re-title. Both strings are in `written`, so neither is ever mistaken for a human's later. Appends are a single `appendFileSync` well under `PIPE_BUF`, so they cannot interleave. The cost of a double install is a doubled model bill for the same title, not a broken session, and the README says to install one way, not both.

### Desktop sidebar setup

`sync-plan` computes the diff the sidebar is missing and pushes nothing, because the only writer the app trusts is its own session-rename tool, held by an agent inside a desktop session. The routine that closes the loop is an hourly scheduled task in the desktop app - id `session-title-sidebar-sync`, cron `2 * * * *` - whose prompt runs `sync-plan` and applies each JSON line through `set_session_title`, stopping on the first error and touching nothing else.

Setting that up is offered at onboarding rather than left in the README. On a TTY, `install` asks one question after the auth probe ("Do you use the Claude Code desktop app?") and on a yes prints the pointer; anything else, and a non-TTY install, print nothing extra and leave the existing output byte-identical. The prompt reader is an injectable seam alongside the probe's spawn, and it returns "no answer" rather than throwing on any failure - this is a pointer to an optional extra, never worth a crash on an install that already succeeded.

- **We never write the app's task registry.** It lives under `~/.claude/scheduled-tasks/<id>/`, and the app pairs it with state we cannot supply: the schedule, the working folder, and the tool permissions the user approves for the run. So both paths hand over instructions and let the app create its own routine, with the user's consent - the plugin skill for a plugin install, and a paste block from `install` or `sidebar-setup` for an npm one. Both come from one constant in `src/commands.js`, and a test asserts the skill file carries it verbatim.
- **The task prompt invokes the CLI by bare name.** `${CLAUDE_PLUGIN_ROOT}` resolves only in plugin components - hook and monitor commands, MCP and LSP config, and the plugin's own skill and agent content. A scheduled task's prompt is none of those: it lives in the app's task store, so the placeholder would reach the Bash tool as an unset shell variable and run `node "/bin/cli.js"`. The bare name covers both installs instead. npm puts it on the shell PATH; an enabled plugin's `bin/` is on the Bash tool's PATH in any session, and a scheduled run is an ordinary local session, so the plugin wrapper answers there. The prompt says to stop and report rather than guess at a path when the command is missing, which is what a task whose folder has the plugin disabled looks like.
- The routine never passes `--all`. Sessions the user renamed in the app stay excluded, and pushing them is a dead end anyway - the app's rename API keeps the user's title and answers success-shaped.

### Worker

The worker owns all logic:

1. Loads per-session state from `~/.claude/claude-session-namer/state.json`
2. Decides whether to act (see Titling decisions below); most invocations exit without an LLM call
3. Builds a compact excerpt from the transcript JSONL - recent user and assistant text turns, truncated per turn and overall
4. Calls `claude -p --model <model>` (with `CLAUDE_SESSION_NAMER_WORKER=1` in env) using a strict prompt that returns either `KEEP` or a title
5. Appends a `{"type":"custom-title","customTitle":"...","sessionId":"..."}` record to the session transcript file - a single atomic append
6. Records what it wrote in state

#### Model

The titling model is a config field (`model`, default `"haiku"`), set with `claude-session-namer config model haiku|sonnet`. Haiku is the default because the job is an eight-word phrase, and it is the cheap end of a call that fires several times per session; sonnet is there for users who would rather pay about 3x a call for a better read of a messy conversation. `config model` accepts those two names and nothing else. A free-form model string would reach `claude -p` on every Stop event, and a name that doesn't resolve fails the call into a hook that is silent on failure by design - titling would simply stop, with nothing said and nowhere to see it. `backfill --model <m>` stays unrestricted and overrides the setting for that run: it is one sweep the user is watching, so a bad name reports itself immediately. Everything the worker asks for uses the configured model - first title, drift check, and restyle alike, because a setting that covered only one of the three would leave most calls on the old model. The install-time auth probe stays fixed on haiku: it is a connectivity check, not a title.

An unsupported value hand-written into `config.json` reads as `haiku` rather than being passed through, the same way a missing `prefix` reads as `true`.

### Titling decisions

- **First title:** when a session has at least one real user/assistant exchange and no non-vague title.
- **Drift re-title (growth-gated):** re-check only when the session's user-turn count has grown ~2x since the last check. Calls scale with the log of session length - a 100-turn session gets roughly 5 checks lifetime. The check sends the current title plus a recent excerpt; the model answers `KEEP` or supplies a replacement.
- **Format restyle (growth-gated):** the prefix setting applies to every title the tool manages, not just the next one it writes. A title that is accurate but in the wrong format - a bare phrase with prefixes on, a bracketed prefix with them off - is sent back to the model in restyle mode: rewrite it into the required format, preserve its meaning, never answer `KEEP`. With prefixes on the excerpt goes along, used only to pick the prefix; with prefixes off the transform is mechanical - strip the bracket, keep the phrase - so the prompt carries no excerpt at all. The check runs on the doubling gate (the session's user-turn count has at least doubled since the last check) and takes precedence over a drift check, because a drift check can answer `KEEP` and that would leave the format wrong for good; the next drift check, one growth step later, is where meaning gets re-derived. Vague titles have nothing worth preserving and stay on the first-title path.
  - Only the two hard protections sit upstream of this check: the manual flag `rename` and `protect` set, and the app store's `'user'` marker. The third protection below - the KEEP-biased personal-label instruction - lives in the drift prompt, and restyle mode strips every KEEP rule with it. So a title somebody typed by hand that carries neither marker gets reshaped into the format rather than spared: `Revisit Monday` with prefixes on comes back as something like `[Emails] Revisit Monday`. The meaning survives, the shape changes. `protect` is the way to hold a title exactly as typed.
  - `backfill` passes a force flag that bypasses this gate, and only this gate. Sweeping history after flipping the setting is the whole point of the setting being a contract, and most swept sessions are finished: they carry a drift baseline from an earlier check and their turn count will never grow past it, so the gate on its own would never open again and the sweep would converge nothing. Drift rechecks are not forced - those still wait for the session to double, or a sweep would re-derive meaning on every session at a model call each. The gate closes as soon as a title conforms, so a second sweep over the same history costs nothing.
- **Protection is never inferred from the title record.** Live-data testing killed the original assumption here. The desktop app files its own auto-titles as `custom-title` records - the same record type a hand rename produces - and re-asserts the current title every ~14 transcript lines. On the author's machine, 68 of 69 titled sessions carried a `custom-title` and only one carried an `ai-title`. So the record type says nothing about who wrote the title, and treating a foreign `custom-title` as a human's manual-locked nearly every session on first sight, which is the one thing that defeats the whole tool. What protects a title instead:
  - `rename` and `protect` set the manual flag in state. That is permanent until `unprotect`, and it is the guarantee that holds on every platform.
  - The app's own session store marks a title the user typed (see below). Those are skipped outright.
  - Where neither applies, the drift check is KEEP-biased: the prompt tells the model to output `KEEP` when the current title reads like a deliberate personal label (a person's name, a date, a note like 'Revisit Monday') rather than a description of the work. That bias is in the drift prompt only. A format restyle strips every KEEP rule with it, so an unmarked personal label in the wrong shape gets reformatted rather than spared - its meaning intact, the format applied.
- **App-side renames are detected, via the app's own store.** The Claude desktop app keeps one JSON file per session under `~/Library/Application Support/Claude/claude-code-sessions/<uuid>/<uuid>/local_*.json`, carrying `cliSessionId` (the transcript session id), `title`, and `titleSource` - `'user'` when someone typed the name in the app UI, `'auto'` when the app generated it. That marker is the only place on disk the distinction survives; the transcript record types don't carry it. Verified against 233 live session files: 200 auto, 27 user, 6 with the field absent (older app builds - absent reads as `auto`, since a rename has always been recorded explicitly). `src/appstore.js` walks the store read-only and returns `'user' | 'auto' | null`, and the worker skips any session marked `'user'` before it looks at titles or growth at all. `list` shows those sessions with a trailing `[renamed in app]`.
  - The trade-off is a stale title CLI-side: a session marked `'user'` is never written to again, so it keeps whatever title its transcript already carries, and if the name typed in the app never reached the transcript the CLI keeps showing the old or vague one (confirmed live - an app-renamed session still reads as 'New session' in `list`). `rename` is the way out, since it writes the name into the transcript and locks the session.
  - Nothing about the lookup is cached into our state. The store is consulted live on every run, so a marker that changes - the user renames again, or the app rewrites its own record - takes effect immediately rather than leaving a frozen copy behind.
  - Every read is best-effort: a missing store, an unreadable directory, or a half-written JSON file reads as "no signal" and the session goes through the normal flow. A missing store is the normal state on Linux and Windows, and on any machine that has only ever run the CLI - which is why `protect` remains the cross-platform guarantee.
  - The store is the app's private data. The tool only reads it, and only for this one field.
  - The protection holds at the app's API layer too: the session-rename tool refuses to change a `'user'`-titled session, answering with success-shaped text while keeping the user's title (verified live 2026-07-29). That closes the door on any tag-only restyle of app-renamed sessions through the API - the only writer the app trusts for those sessions is the user in the UI.
- **App auto-titles are replaceable, by design.** Replacing them is the product. Known-vague titles ('New session', truncated first-message titles) are fair game for the same reason.
- **Live sessions adopt the newest title record.** The app does re-write the title into the transcript every few turns while a session is in use, but what it re-writes is whatever the last `custom-title` record says - it adopts, it doesn't displace (verified on live desktop data). So a re-title on a session still in use applies immediately and then gets echoed back by the app's own writes, which duplicate our string rather than compete with it; the `written` list in state already recognizes those echoes as ours. Backfill skips sessions touched in the last 10 minutes for an unrelated reason: those sessions have a Stop-hook worker of their own, and a sweep would race it.

### Title format

`[Prefix] Short phrase`, hard-capped at 45 characters. The prefix is optional per user: a config file (`~/.claude/claude-session-namer/config.json`, default `{"prefix": true, "model": "haiku"}`) controls it, toggleable via `claude-session-namer config prefix on|off` or `install --no-prefix`. With prefixes off, titles are the bare phrase. Prefixes are free-form but normalized: the prompt includes the user's previously-used prefixes with an instruction to reuse one when it fits and coin a new one only for a genuinely new workstream. Seen prefixes and counts live in state.

The setting is a format contract rather than a default for new titles. `titler.matchesFormat(title, usePrefix)` is the test - a bracketed prefix of 1-25 characters followed by a phrase in prefix mode, a title that doesn't open with a bracket in bare mode - and any title the tool manages that fails it gets reformatted with its meaning preserved (see Format restyle above). Reformatting rather than regenerating is the point: the old title was usually right about the work, so re-deriving it would risk the meaning to fix the shape. Renamed, protected, and app-renamed sessions are exempt.

## CLI commands

- `install` / `uninstall` - register/remove the Stop hook in `~/.claude/settings.json` (surgical JSON edit, preserves everything else in the file). After a successful registration, `install` probes the titling path with one `claude -p ping --model haiku` call (30s timeout, `CLAUDE_SESSION_NAMER_WORKER=1` so the hook it just registered ignores the probe's own session). A failing probe prints a warning naming the case - CLI not on PATH, or a failed call with the CLI's own stderr line - and the fix. The install still succeeds and still exits 0: the probe only makes a titling path that would fail silently forever visible at the one moment the user is watching. After the probe, an interactive install asks the desktop-app question (see Desktop sidebar setup). `uninstall` does not probe.
- `backfill [--dry-run] [--model <m>] [--project <path>] [--since <days>] [--limit <n>] [--all]` - sweep the project dirs under `~/.claude/projects/` and title vague/untitled sessions. Scoped by default to what a user still recognizes in their sidebar - the 50 newest sessions from the last 30 days - with the scanned scope printed above the summary. `--since` widens the window, `--limit` changes the cap, and `--all` drops both for full history (mutually exclusive with `--since`/`--limit`). A sweep also reformats any title that doesn't match the current prefix setting, whatever the session's drift baseline says (see Format restyle). Dry-run prints planned titles without writing; throttled to stay clear of rate limits
- `rename <session-id> "title"` - set a title by hand, marked manual
- `protect <session-id>` - mark a session manual without touching its title, so whatever it is named now stays
- `unprotect <session-id>` - drop the manual mark and let drift re-titling resume
- `list [--project <path>]` - sessions with titles, newest first; protected sessions carry a trailing `[protected]`, sessions renamed in the desktop app a trailing `[renamed in app]`, and a session can carry both
- `search <query>` - match against titles and transcript content
- `sidebar-setup` - print the prompt that sets the sidebar sync routine up, for pasting into a desktop session. Unconditional: no terminal check, no platform check. Same text the bundled skill uses, from one constant, so the two cannot drift
- `sync-plan [--all]` - print, as JSON lines, the sessions whose transcript title differs from the title in the app's own registry (`{sessionId, currentTitle, newTitle}`, keyed by the app's session id). The sidebar reads that registry rather than the transcript, so a title written here never reaches it; this command computes the diff and writes nothing, leaving the push to a scheduled Claude session or any agent holding the app's session-rename tool. User-renamed sessions are excluded unless `--all` is passed - and `--all` is visibility only: the app's rename API refuses an agent rename of a `titleSource: user` session, returning success-shaped text while keeping the user's title (verified live 2026-07-29 against the then-current desktop app, whose rename tool now states the behavior in its own response). Printing those lines shows the diff; no external writer can apply it.

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
4. Plugin: the manifests ship in the same repo, so making the repo public makes it installable as a plugin with no separate release step. `claude plugin validate .` is the pre-publish check. Submitting to `claude-community` is optional and independent of the npm release

## Ongoing maintenance

Recurring research sweep (monthly, set up as a scheduled task once the tool ships):

- **Claude Code changes:** scan release notes and docs for transcript-format changes, a public session-title API, or new hook capabilities. A format change means patching the record writer; a public title API means replacing the JSONL append entirely.
- **Competing tools:** re-check claude-rename, claude-chat-namer, and search for new entrants. Fold in genuinely better ideas; note in the README how this tool differs.
- Each sweep produces a short note in `docs/research/` with date, findings, and any resulting issues.

## Later (V2+)

- More plugin skills (`/claude-session-namer:backfill` and friends). `setup-sidebar-sync` is the first one and covers the step a user cannot do from the CLI at all; wrapping commands that already work on the Bash PATH is a smaller win and can wait for a reason
- Optional API-key mode for users who prefer metered billing over subscription usage
- `--concurrency <n>` for backfill: a few parallel CLI calls would cut a sweep several-fold (the per-call cost is CLI startup, not the model). Held out of v1 on purpose - the sequential throttle is rate-limit politeness, and how the subscription layer treats parallel headless calls is untested
- Swap the JSONL append for a public title API if Anthropic ships one
