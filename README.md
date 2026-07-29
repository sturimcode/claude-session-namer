# claude-session-namer

Auto-titles your Claude Code sessions - and re-titles them when the conversation moves on.

## The problem

Claude Code names a session after your first message, truncated. A sidebar of "fix the thing in the parser real quick" and "New session" tells you nothing a week later, and the name stays wrong even after the session turns into something else.

Tools that title a session do it once, from the opening exchange. This one titles on the first exchange too, then re-checks as the session grows - so a session that started as a config tweak and became a three-hour refactor ends up named after the refactor.

## How it works

A Stop hook fires after each of your turns. It spawns a detached background worker, so nothing blocks your session. The worker reads the transcript, calls `claude -p --model haiku` for a title, and appends a native `custom-title` record to the session's JSONL file - the same record type Claude Code writes when you rename a session yourself. Titles show up in the CLI and the desktop app, which share one session store. Re-titling works even on a session you are still using: the app adopts the newest title record and re-asserts it as its own.

Re-titling is growth-gated. The first title lands after your first exchange. After that, a session is re-checked when its user-turn count roughly doubles: a 100-turn session gets about 5 checks, not 100. If the current title still fits, the model answers `KEEP` and nothing is written.

Titles you set through `rename` or `protect` are never overwritten. Those mark the session as yours and the tool stops touching it. A name you type in the desktop app UI is protected too, on macOS: the app records in its own session store whether a title came from you or from its auto-titler, and the tool reads that marker before every decision. The transcript can't show it - Claude Code writes its own auto-titles as the same record type your renames produce - so the app's store is the only place that fact lives. Off macOS, or for a session the desktop app has never opened, the marker isn't there; `protect <session-id>` is the guarantee that works everywhere.

## Install

1. Install the package:

   ```
   npm install -g claude-session-namer
   ```

2. Register the hook:

   ```
   claude-session-namer install
   ```

   From then on, new sessions title themselves. `install` writes a hook wrapper to `~/.claude/claude-session-namer/hook.sh` and registers one Stop hook entry in `~/.claude/settings.json`. Existing hooks are left alone.

3. Optional - preview titling the sessions you already have:

   ```
   claude-session-namer backfill --dry-run
   ```

   The default covers your recent sessions: the 50 newest from the last 30 days. Each previewed session costs one haiku call, so a preview is not free. `--all` covers your full history instead.

To remove it:

```
claude-session-namer uninstall
```

Uninstall removes the hook entry and the wrapper. Titles already written stay.

## Commands

```
install [--no-prefix]                Register the Stop hook
uninstall                            Remove the Stop hook
backfill [--dry-run] [--model <m>]   Title existing untitled or vague sessions
         [--project <path>] [--all]  (recent ones by default)
         [--since <days>] [--limit <n>]
rename <session-id> "title"          Set a title by hand and lock the session
protect <session-id>                 Lock the title a session already has
unprotect <session-id>               Let the tool re-title it again
list [--project <path>]              List recent sessions with titles
search <query>                       Find sessions by title or content
config [prefix on|off]               Show or change settings
sync-plan [--all]                    Print the titles the app sidebar is missing
```

Preview a backfill before running it:

```
claude-session-namer backfill --dry-run
```

`--dry-run` writes nothing, but it still calls the model once per eligible session, so it costs the same as the real run.

A backfill covers your recent sessions by default - the 50 newest from the last 30 days - and prints the scope it scanned. Two-year-old sessions don't need titles, and sweeping the whole store is hundreds of model calls.

```
--since <days>   Widen the window. Still capped at 50 unless --limit is given
--limit <n>      Change the cap on how many sessions are scanned
--all            Full history: no window, no cap. Can't be combined with --since or --limit
```

`--model` defaults to `haiku`. `--project` takes either a path or the encoded directory name that `list` prints. Sessions touched in the last 10 minutes are skipped as probably still open.

`rename`, `protect`, and `unprotect` accept a session-id prefix as long as it matches exactly one session. `protect` writes nothing to the transcript - it locks whatever the session is named right now, whether you set that name or Claude Code did. `list` marks a locked session with a trailing `[protected]` and a session you renamed in the desktop app with `[renamed in app]`; a session can carry both, and neither is visible anywhere else.

## Prefixes

Titles default to `[Prefix] Phrase`, capped at 45 characters:

```
[Emails] SES bounce rate investigation
[Client Controls] Cascade validation rules
```

Prefixes are learned from your own titling history and reused, so related sessions cluster in the sidebar. The model is told to coin a new prefix only for a genuinely different workstream.

For bare phrases with no prefix:

```
claude-session-namer config prefix off
```

Or install with `--no-prefix`. `config` with no arguments prints the current setting.

The setting is a format contract, not a preference applied to new titles only: with prefixes on, every title the tool manages carries one, and with prefixes off, none does. A title that describes the session accurately but is in the wrong format gets reformatted rather than regenerated - the phrase keeps its meaning and only the shape changes, so `SES bounce triage` becomes `[Emails] SES bounce triage` and back again if you flip the setting. Flipping it converges the titles you already have the next time each session is checked, or all at once if you run `backfill`. Sessions you renamed by hand, protected, or renamed in the desktop app are exempt, as always.

## Desktop app sidebar

The desktop app's sidebar doesn't read the transcript. It reads the app's own registry - one JSON file per session under `~/Library/Application Support/Claude` - so titles written here show up in the CLI (`list`, the resume picker, `--resume`) but don't reach the app sidebar on their own.

`sync-plan` computes what would close that gap. For each session the app knows about, it compares the title in the app's registry against the current title in the transcript, and prints one JSON line per session that differs:

```
$ claude-session-namer sync-plan
{"sessionId":"local_a1b2c3","currentTitle":"New session","newTitle":"[Emails] SES bounce triage"}
```

`currentTitle` is null when the app has no name for the session yet.

The command writes nothing - not to the app, not to your transcripts. Applying the plan takes something that can call the app's session-rename API: a scheduled Claude session, or any agent with that tool, fed this output. Nothing to push means no output.

Sessions you renamed in the app yourself are left out. `--all` puts them back in, and that is the only thing it does: it lets a push overwrite a name you typed in the app. It does not help with the opposite case, where the app is showing a good name and the transcript is still on a vague one - there is no diff to push there, and `rename <session-id> "title"` is the fix.

## Cost

A few haiku calls per session, run through your existing Claude subscription via the `claude` CLI. No API key, no separate billing.

A default backfill is a few dozen model calls and a few minutes. A `--all` backfill over a ~400-session store is roughly 350 model calls and 45 minutes or more - it runs sequentially with a throttle between calls.

## Caveats

Read these before installing.

**It writes to Claude Code's transcript files.** Anthropic documents the `~/.claude/projects` JSONL format as internal and subject to change between versions. This tool appends one record type that Claude Code itself writes, and it only appends - it never rewrites or deletes anything in a transcript. So the failure mode is that titles stop appearing, not that a session breaks. But it is a real dependency on an undocumented format, and a Claude Code update can break it. Pin your expectations accordingly.

**Requirements:** the `claude` CLI on your PATH, and Node 18 or newer.

**macOS and Linux.** Windows is untested - the hook installs as a `/bin/sh` wrapper.

**A title you type in the app is detected on macOS, and only there.** Nothing in the transcript distinguishes a name you typed from one Claude Code generated - both are the same record type, and the app re-writes its own as a session grows. The desktop app does record the difference, in its own session store under `~/Library/Application Support/Claude`: each session is tagged as titled by you or by the app. The tool reads that tag and never re-titles a session tagged as yours. Where the tag isn't there - Linux, no desktop app installed, a session the app has never opened, or a session file written by an older app build that predates the tag (6 of 234 files on the author's machine) - a name you typed is protected only by heuristics: the model is told to answer `KEEP` when the current title reads like a deliberate label (a person's name, a date, "Revisit Monday") and when it already describes the conversation. That is not a guarantee. `rename` and `protect` are - both mark the session yours in the tool's own state, and the tool stops touching it until you run `unprotect`. The tool only reads the app's store, never writes to it.

The trade-off of that protection: a session tagged as renamed by you keeps whatever title its transcript already carries on the CLI side, because the tool stops writing to it. The app stores your name in its own registry and doesn't always push it back into the transcript, so if it never reached the transcript, `list` and the resume picker keep showing the old or vague name while the app sidebar shows yours. `rename <session-id> "title"` is the way out - it writes the name into the transcript and keeps the session locked.

**Don't export `CLAUDE_SESSION_NAMER_WORKER` in the shell that launches Claude Code.** That variable is the recursion guard - the worker sets it on its own `claude -p` call so the resulting Stop hook doesn't spawn another worker. If it is already set in your environment, titling silently does nothing.

**Reinstall after moving the package.** The hook wrapper embeds the absolute path to the CLI. If you move or reinstall the package elsewhere, run `claude-session-namer install` again.

## License

MIT
