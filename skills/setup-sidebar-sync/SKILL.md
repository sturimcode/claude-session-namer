---
name: setup-sidebar-sync
description: Set up hourly syncing of claude-session-namer titles into the Claude Code desktop sidebar. Use when the user asks to set up sidebar sync, sync session titles to the sidebar, get their session titles showing in the sidebar, or says the sidebar titles are stale while the CLI has the right ones.
---

# Set up sidebar sync

claude-session-namer writes titles into the session transcript, which is what the CLI reads. The desktop app's sidebar reads the app's own registry instead, so those titles never reach it on their own. Closing the gap takes a scheduled task inside the app: once an hour it runs `claude-session-namer sync-plan` and applies each line through the app's session-rename tool.

Work through the steps in order. Create nothing before step 4.

## 1. Check that it applies

This needs the Claude Code desktop app, on macOS - the session registry it reads and renames only exists there, and the scheduled task has to be created by the app itself. If you are not in a desktop session, or not on macOS, say so in one line and stop. Do not create anything, and do not offer a workaround.

## 2. Confirm with the user

Say what the routine does in one sentence: every hour it renames sessions in the app to the titles claude-session-namer has already written, and does nothing else. Then ask whether to create it, and wait for a yes. A no ends this.

## 3. Check the existing scheduled tasks

List the existing scheduled tasks before creating anything. If one already carries the id `session-title-sidebar-sync`, do not create a second:

- Its prompt and schedule already match what is below: say it is already set up, and stop.
- They differ: update that task in place. Never pass `fireAt` on an update - a one-time fire time replaces the cron schedule, and the task disables itself after it runs.

## 4. Create the task

Create it with the app's own scheduled-task tool, which is what records the schedule and the tool permissions the run needs. Never write the app's task files yourself - a task the app did not create carries neither.

- id: `session-title-sidebar-sync`
- schedule: hourly, cron `2 * * * *`
- description: one line, along the lines of "Push claude-session-namer titles into the desktop sidebar"
- prompt: exactly the text below, with nothing added or dropped

```
Sync claude-session-namer titles into the Claude Code desktop sidebar, then tidy up.

1. Run `claude-session-namer sync-plan` (do NOT pass `--all` - user-renamed sessions must stay excluded). If the command is not found, stop and say so: it is on this session's Bash PATH only while the plugin is enabled for this folder, or when the npm package is installed globally. Do not guess at a path.
2. The output is JSON lines, each {"sessionId", "currentTitle", "newTitle"}. Empty output means nothing to sync - continue with step 4.
3. For each line in order, call the app's session-rename tool (set_session_title) with that sessionId and newTitle. Stop immediately on the first error - no retries, no continuing - and report what failed.
4. Run `claude-session-namer sweep-done`. It is a no-op unless the user turned done markers on.

Take no actions beyond these: sync-plan, sweep-done, and the per-session rename calls. Never run backfill or any other command, and never archive or delete anything. Tidying up the sessions these runs leave behind is deliberately not part of this routine: the app requires manual approval for archive_session in a scheduled run whatever permission rules are set, so a run that tried would sit waiting for a person who is not there. That cleanup belongs to an interactive session.
```

The task's working folder needs claude-session-namer reachable from a Bash call: any folder for an npm install, and a folder where this plugin is enabled otherwise.

## 5. Pre-approve the permissions

Run-time prompt approvals do not reliably persist for the app's own tools, so offer - and with the user's consent, make - the durable version: add these rules to the `permissions.allow` array in `~/.claude/settings.json` (read the file first, merge, never replace other entries):

```
"Bash(claude-session-namer sync-plan:*)"
"Bash(claude-session-namer sweep-done:*)"
"mcp__ccd_session_mgmt__set_session_title"
"mcp__ccd_session_mgmt__list_sessions"
"mcp__ccd_session_mgmt__get_session"
"mcp__ccd_session_mgmt__archive_session"
```

Say what each one is for in a line: the two commands the routine runs, the app's rename tool that pushes titles, and the three the user's own cleanup uses to find prior runs and archive them (section 7). If the user declines, that is fine - the routine still works, it just pauses on a prompt whenever an approval has not stuck.

## 6. Say what to expect

Keep it to a few lines:

- The task runs only while the desktop app is open and the machine is awake. A missed hour is skipped, and the next run picks up everything outstanding anyway.
- Offer to prove the path once now, whether or not the rules were added, by running the task's steps yourself in this session: `claude-session-namer sync-plan`, then the `set_session_title` call for each line it prints, then `claude-session-namer sweep-done`.
- Never test it by scheduling the task to fire. A one-time `fireAt` run clears the cron schedule and the task disables itself once it has fired, so the hourly sync would be dead from that moment with nothing said.
- Sessions the user renamed in the app are left out of every sync. The app refuses an agent rename of those, so pushing them is not possible and not attempted.
- Each run leaves a session behind, and the routine cannot clear them itself. Point at section 7 in one line.

## 7. Clearing old run sessions

The routine archives nothing, by design. An `archive_session` call from a scheduled run always raises a manual approval - "This tool requires explicit approval regardless of permission mode" - and no permission rule bypasses it (observed live 2026-07-30, twice: for the run's own session and for ordinary sessions alike, while `set_session_title` auto-approved in those same runs). A cleanup step inside the task would stall waiting for a person who is not watching.

So it is something the user asks for, in any interactive desktop session, where the rules from section 5 make it promptless. Tell them that, and tell them what the session doing it has to do:

- Find prior runs by their **scheduled-task linkage**: list the app's sessions, call `get_session` on each candidate, and act only on the ones whose linkage names `session-title-sidebar-sync`.
- **Never match on title.** claude-session-namer renames these run sessions itself, usually within a couple of replies, so a run's title says nothing about which task produced it.
- Never archive the current session, and never archive a session whose linkage could not be read.
