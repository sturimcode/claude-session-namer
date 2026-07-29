# claude-session-namer

Auto-titles your Claude Code sessions - and re-titles them when the conversation moves on.

## The problem

Claude Code names a session after your first message, truncated. A sidebar of "fix the thing in the parser real quick" and "New session" tells you nothing a week later, and the name stays wrong even after the session turns into something else.

Tools that title a session do it once, from the opening exchange. This one titles on the first exchange too, then re-checks as the session grows - so a session that started as a config tweak and became a three-hour refactor ends up named after the refactor.

## How it works

A Stop hook fires after each of your turns. It spawns a detached background worker, so nothing blocks your session. The worker reads the transcript, calls `claude -p --model haiku` for a title, and appends a native `custom-title` record to the session's JSONL file - the same record type Claude Code writes when you rename a session yourself. Titles show up in the CLI and the desktop app, which share one session store.

Re-titling is growth-gated. The first title lands after your first exchange. After that, a session is re-checked when its user-turn count roughly doubles: a 100-turn session gets about 5 checks, not 100. If the current title still fits, the model answers `KEEP` and nothing is written.

Titles you set through `rename` or `protect` are never overwritten. Those mark the session as yours and the tool stops touching it. A title you type in the app UI is a different story: Claude Code writes its own auto-titles into the transcript the same way it writes your renames, so there is no way to tell them apart after the fact. Those are protected heuristically - the model is told to keep a title that reads like a deliberate label rather than a description of the work. Run `protect <session-id>` when you want a guarantee.

## Install

```
npm install -g claude-session-namer
claude-session-namer install
```

`install` writes a hook wrapper to `~/.claude/claude-session-namer/hook.sh` and registers one Stop hook entry in `~/.claude/settings.json`. Existing hooks are left alone.

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
         [--project <path>]
rename <session-id> "title"          Set a title by hand and lock the session
protect <session-id>                 Lock the title a session already has
unprotect <session-id>               Let the tool re-title it again
list [--project <path>]              List recent sessions with titles
search <query>                       Find sessions by title or content
config [prefix on|off]               Show or change settings
```

Preview a backfill before running it:

```
claude-session-namer backfill --dry-run
```

`--dry-run` writes nothing, but it still calls the model once per eligible session, so it costs the same as the real run. `--model` defaults to `haiku`. `--project` takes either a path or the encoded directory name that `list` prints. Sessions touched in the last 10 minutes are skipped as probably still open.

`rename`, `protect`, and `unprotect` accept a session-id prefix as long as it matches exactly one session. `protect` writes nothing to the transcript - it locks whatever the session is named right now, whether you set that name or Claude Code did.

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

## Cost

A few haiku calls per session, run through your existing Claude subscription via the `claude` CLI. No API key, no separate billing. A backfill over ~400 sessions is roughly 350 model calls and about 30 minutes - it runs sequentially with a throttle between calls.

## Caveats

Read these before installing.

**It writes to Claude Code's transcript files.** Anthropic documents the `~/.claude/projects` JSONL format as internal and subject to change between versions. This tool appends one record type that Claude Code itself writes, and it only appends - it never rewrites or deletes anything in a transcript. So the failure mode is that titles stop appearing, not that a session breaks. But it is a real dependency on an undocumented format, and a Claude Code update can break it. Pin your expectations accordingly.

**Requirements:** the `claude` CLI on your PATH, and Node 18 or newer.

**macOS and Linux.** Windows is untested - the hook installs as a `/bin/sh` wrapper.

**A title you type in the app can be overwritten.** Claude Code writes its own auto-generated titles into the transcript as the same record type your renames produce, and re-writes them as a session grows, so nothing in the file distinguishes the two. Re-titling those auto-titles is the point of this tool, so it cannot skip them - which means a name you typed in the app UI is protected only by heuristics: the model is told to answer `KEEP` when the current title reads like a deliberate label (a person's name, a date, "Revisit Monday") and when it already describes the conversation. That is not a guarantee. `rename` and `protect` are - both mark the session yours in the tool's own state, and the tool stops touching it until you run `unprotect`.

**A re-title on a session you are still using may not stick.** While a session is open, the app periodically re-asserts its own cached title, which lands after ours and wins. The title settles once the session goes idle, and `backfill` only sweeps sessions untouched for 10 minutes for this reason.

**Don't export `CLAUDE_SESSION_NAMER_WORKER` in the shell that launches Claude Code.** That variable is the recursion guard - the worker sets it on its own `claude -p` call so the resulting Stop hook doesn't spawn another worker. If it is already set in your environment, titling silently does nothing.

**Reinstall after moving the package.** The hook wrapper embeds the absolute path to the CLI. If you move or reinstall the package elsewhere, run `claude-session-namer install` again.

## License

MIT
