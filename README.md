# claude-session-namer

Auto-titles your Claude Code sessions - and re-titles them when the conversation moves on.

## The problem

Claude Code names a session after your first message, truncated. A sidebar of "fix the thing in the parser real quick" and "New session" tells you nothing a week later, and the name stays wrong even after the session turns into something else.

Tools that title a session do it once, from the opening exchange. This one titles on the first exchange too, then re-checks as the session grows - so a session that started as a config tweak and became a three-hour refactor ends up named after the refactor.

## How it works

A Stop hook fires after each of your turns. It spawns a detached background worker, so nothing blocks your session. The worker reads the transcript, calls `claude -p --model haiku` for a title, and appends a native `custom-title` record to the session's JSONL file - the same record type Claude Code writes when you rename a session yourself. Titles show up in the CLI and the desktop app, which share one session store.

Re-titling is growth-gated. The first title lands after your first exchange. After that, a session is re-checked when its user-turn count roughly doubles: a 100-turn session gets about 5 checks, not 100. If the current title still fits, the model answers `KEEP` and nothing is written.

Titles you set by hand are never overwritten - not the ones you type in the app, not the ones you set with `rename`. The tool marks that session as yours and stops touching it. The app's own auto-titles (`ai-title` records) are treated as replaceable.

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
list [--project <path>]              List recent sessions with titles
search <query>                       Find sessions by title or content
config [prefix on|off]               Show or change settings
```

Preview a backfill before running it:

```
claude-session-namer backfill --dry-run
```

`--dry-run` writes nothing, but it still calls the model once per eligible session, so it costs the same as the real run. `--model` defaults to `haiku`. `--project` takes either a path or the encoded directory name that `list` prints. Sessions touched in the last 10 minutes are skipped as probably still open.

`rename` accepts a session-id prefix as long as it matches exactly one session.

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

**Don't export `CLAUDE_SESSION_NAMER_WORKER` in the shell that launches Claude Code.** That variable is the recursion guard - the worker sets it on its own `claude -p` call so the resulting Stop hook doesn't spawn another worker. If it is already set in your environment, titling silently does nothing.

**Reinstall after moving the package.** The hook wrapper embeds the absolute path to the CLI. If you move or reinstall the package elsewhere, run `claude-session-namer install` again.

## License

MIT
