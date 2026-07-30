# claude-session-namer

Automatically names your Claude Code sessions, and renames them when the conversation becomes something else.

Claude Code names sessions on its own, but the names are vague ("New session", "General coding session") and stay wrong once the work moves on. This fixes that: clear names, kept current, bucketed by project.

## Install

As a plugin (recommended):

```
/plugin marketplace add sturimcode/claude-session-namer
/plugin install claude-session-namer@claude-session-namer
```

Or with npm:

```
npm install -g claude-session-namer
claude-session-namer install
```

New sessions name themselves from here on. To name the sessions you already have:

```
claude-session-namer backfill --dry-run   # preview first
claude-session-namer backfill             # then run it
```

Desktop app user? Run `claude-session-namer sidebar-setup` once and follow what it prints. The app's sidebar keeps its own copy of titles and writes that copy back over the name in a live session, so this sets up an hourly sync that puts your title back. Plugin installs can also just ask Claude to "set up sidebar sync".

`claude-session-namer uninstall` removes the hook. Titles already written stay.

## How it works

1. A small background hook wakes up every time Claude finishes a reply.
2. Haiku skims the conversation and writes a short title, through `claude -p` on your subscription. No API key, no separate billing.
3. As the session grows it re-checks and renames if the topic has moved on. Your own renames are left alone.

Wakeups are almost always free: the hook checks one number and exits. A model call only happens when a session is new or has grown a lot since the last check - whether the growth is your messages or agent activity - so even a very long session costs about 5 haiku calls total.

Titles look like `[Emails] SES bounce triage`. Prefixes are reused across sessions, so related work clusters in the sidebar. Prefer bare phrases? `claude-session-namer config prefix off`.

Haiku writes the titles by default, and for an eight-word phrase it is plenty. `claude-session-namer config model sonnet` switches if you want a sharper read of a messy conversation; a sonnet call costs about 3x a haiku one.

## Commands

```
install [--no-prefix]      Register the hook
uninstall                  Remove the hook
backfill [--dry-run]       Name existing sessions (50 newest by default, --all for everything)
rename <session-id> "..."  Set a name yourself and lock it
protect <session-id>       Lock whatever name a session has now
unprotect <session-id>     Drop the lock, let renaming resume
list                       Recent sessions and their names
search <query>             Find sessions by name or content
config [prefix on|off] [model haiku|sonnet]
                           Show or change settings
sync-plan                  Print what the app sidebar is missing
sidebar-setup              Set up the hourly sidebar sync
```

## Good to know

**It writes to Claude Code's own session files.** Anthropic documents that format as internal, so a Claude Code update can change it. The tool only ever appends the same record type Claude Code itself writes. Worst case, titles stop appearing until this tool is patched. Sessions are never touched beyond that.

**Your titles are safe.** `rename` and `protect` lock a session permanently. A name you typed in the desktop app is detected and skipped too (macOS), and the model is told to keep anything that reads like a deliberate label.

**Cost:** a few haiku calls per session, on your existing subscription. A default backfill covers your 50 newest sessions and takes 10-15 minutes.

**Requirements:** Node 18+, the `claude` CLI signed in, macOS or Linux. If titling silently does nothing: run `claude -p ping --model haiku` to check the CLI, and make sure `CLAUDE_SESSION_NAMER_WORKER` isn't exported in your shell.

Full design, every protection rule, and the sidebar mechanics: [docs/design.md](docs/design.md).

MIT
