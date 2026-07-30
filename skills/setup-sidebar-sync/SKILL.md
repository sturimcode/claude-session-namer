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
- They differ: update that task in place.

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
3. For each line in order, call the app's session-rename tool (set_session_title) with that sessionId and newTitle. Stop on the first rename error - no retries, no continuing - and report what failed.
4. Run `claude-session-namer sweep-done`. It is a no-op unless the user turned done markers on.
5. Cleanup: list this app's sessions and archive prior completed runs of this same scheduled task - sessions that are not the current one and whose title exactly matches this task's own name. Never archive the current session, and never archive anything whose title does not match.

Take no actions beyond these: sync-plan, sweep-done, the per-session rename calls, and archiving this task's own previous run sessions. Never run backfill or any other command, and never delete anything.
```

The task's working folder needs claude-session-namer reachable from a Bash call: any folder for an npm install, and a folder where this plugin is enabled otherwise.

## 5. Say what to expect

Keep it to a few lines:

- The task runs only while the desktop app is open and the machine is awake. A missed hour is skipped, and the next run picks up everything outstanding anyway.
- Offer to run it once now. The first run is where permission prompts appear, and approving them as always-allow is what keeps later runs from stalling on them.
- Sessions the user renamed in the app are left out of every sync. The app refuses an agent rename of those, so pushing them is not possible and not attempted.
