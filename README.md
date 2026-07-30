# claude-session-namer

Keeps your Claude Code session names right - from first reply to last.

Claude Code names each session once, early, with barely any context. The guesses are wrong as often as not, and they never change - a session that starts as a config question and becomes a three-hour refactor keeps its config-question name forever. A sidebar like that makes you open sessions just to find out what they are.

This tool names a session once there's something real to name, re-reads it as the work grows, and renames it when the name has stopped being true. It can also group sessions by project (`[API] Rate limiter fix`) and put a checkmark on sessions whose work is finished - both optional. The sidebar ends up readable at a glance: what each session is, which project it belongs to, whether anything in it is still open.

Names you set with `rename` or `protect`, and names you type in the desktop app, are never touched.

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

New sessions name themselves from here on. To name the sessions you already have - in a terminal if you installed with npm, or inside a Claude Code session if you installed the plugin, which puts the command on that session's Bash PATH:

```
claude-session-namer backfill --dry-run   # preview first
claude-session-namer backfill             # then run it
```

A dry run writes nothing, but it costs the same model calls as a real run.

Desktop app user? Run `claude-session-namer sidebar-setup` once and follow what it prints. The app's sidebar keeps its own copy of titles and writes that copy back over the name in a live session, so this sets up an hourly sync that puts your title back. Plugin installs can also just ask Claude to "set up sidebar sync".

`claude-session-namer uninstall` removes the hook. Titles already written stay.

## How it works

1. A small background hook wakes up every time Claude finishes a reply.
2. Haiku skims the conversation and writes a short title, through `claude -p` on your subscription. No API key, no separate billing.
3. As the session grows it re-checks and renames if the topic has moved on. Names you set with `rename` or `protect` are left alone.

Wakeups are almost always free: the hook checks one number and exits. A model call only happens when a session is new or has grown a lot since the last check - whether the growth is your messages or agent activity - so even a very long session costs about 5 haiku calls total.

Titles look like `[API] Rate limiter fix`. Prefixes are reused across sessions, so related work clusters in the sidebar. Prefer bare phrases? `claude-session-namer config prefix off`.

Haiku writes the titles by default, and for an eight-word phrase it is plenty. `claude-session-namer config model sonnet` switches if you want a sharper read of a messy conversation; a sonnet call costs about 3x a haiku one.

Sessions that reached a stopping point can carry a checkmark, so one look at the sidebar tells you which work is still open. It is off by default. Turn it on with `claude-session-namer config done-marker on`, then run `claude-session-namer sweep-done` to check the sessions that have been quiet for a couple of hours. The checkmark comes off by itself the moment you pick a session back up.

## Commands

```
install [--no-prefix]      Register the hook
uninstall                  Remove the hook
backfill [--dry-run]       Name existing sessions (50 newest by default, --all for everything)
sweep-done [--dry-run]     Put a checkmark on sessions that reached a stopping point
rename <session-id> "..."  Set a name yourself and lock it
protect <session-id>       Lock whatever name a session has now
unprotect <session-id>     Drop the lock, let renaming resume
list                       Recent sessions and their names
search <query>             Find sessions by name or content
config [prefix on|off] [model haiku|sonnet] [done-marker on|off]
                           Show or change settings
sync-plan                  Print what the app sidebar is missing
sidebar-setup              Set up the hourly sidebar sync
```

## Good to know

**It writes to Claude Code's own session files.** Anthropic documents that format as internal, so a Claude Code update can change it. The tool only ever appends the same record type Claude Code itself writes. Worst case, titles stop appearing until this tool is patched. Sessions are never touched beyond that.

**Your titles are safe.** `rename` and `protect` lock a session permanently, and a name you typed in the desktop app is detected and skipped too (macOS). A name set by hand outside those keeps its meaning, but it can be reshaped into the title format you configured - `protect` is how you hold one exactly as typed. The drift check is also told to keep anything that reads like a deliberate label.

**Cost:** a few haiku calls per session, on your existing subscription. A default backfill covers your 50 newest sessions and takes 10-15 minutes.

**Requirements:** Node 18+, the `claude` CLI signed in, macOS or Linux. On Windows, `claude-session-namer install` refuses and installs nothing rather than registering a hook that could never fire. If titling silently does nothing: run `claude -p ping --model haiku` to check the CLI, and make sure `CLAUDE_SESSION_NAMER_WORKER` isn't exported in your shell.

Full design, every protection rule, and the sidebar mechanics: [docs/design.md](docs/design.md).

MIT
