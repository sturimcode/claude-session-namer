const fs = require('node:fs');
const t = require('./transcript');
const stateMod = require('./state');
const titler = require('./titler');

// Decides whether this session needs a title, asks for one, and writes it.
// Returns { action, title? } - action is one of:
//   no-turns | manual-skip | no-check-needed | kept | titled | dry-run | title-changed
function processSession({ sessionId, transcriptPath, model = 'haiku', dryRun = false, runner }) {
  const entries = t.readEntries(transcriptPath);
  const turns = t.countUserTurns(entries);
  if (turns < 1) return { action: 'no-turns' };

  const s = stateMod.load();
  const sess = stateMod.session(s, sessionId);
  if (sess.manual) return { action: 'manual-skip' };

  const info = t.titleInfo(entries);
  const title = info.title;
  const vague = t.isVagueTitle(title, t.firstUserText(entries));

  // A title we didn't write gets no special standing, whatever record type carries it. The desktop
  // app files its own auto-titles as custom-title records - the same type a rename produces - and
  // re-asserts them every few turns, so record source cannot tell a human's name from the app's.
  // Every non-vague title is simply the current title, subject to the drift flow below; permanent
  // protection comes only from `rename` or `protect` setting the manual flag above.

  // A transcript that shrank is not the one we measured against (rewrite, compaction,
  // truncation) - drop the stale baseline so an untitled session is treated as fresh.
  // Both markers measured a transcript that no longer exists, so both are stale.
  if (turns < sess.lastCheckTurns) sess.lastCheckTurns = 0;
  if (turns < (sess.lastTryTurns || 0)) sess.lastTryTurns = 0;

  // First-title urgency only applies before a baseline exists. Once lastCheckTurns is set we
  // have either titled the session or accepted the title it arrived with, and the growth gate
  // owns every later look. lastTryTurns bounds the retry on a session that stayed untitled -
  // a KEEP means there wasn't enough to go on, so wait for the conversation to move first.
  // That retry bound gates the recheck path too: a session whose title record vanished reads
  // vague with a baseline set, and without the growth check it would re-ask on every event.
  const grew = turns > (sess.lastTryTurns || 0);
  const needsFirst = vague && sess.lastCheckTurns === 0 && grew;
  const needsRecheck = sess.lastCheckTurns > 0 && turns >= sess.lastCheckTurns * 2 && turns >= sess.lastCheckTurns + 4 && grew;
  if (!needsFirst && !needsRecheck) {
    // Sessions that arrived already titled (by the app's own title record, usually) have no
    // baseline yet - set one here so drift tracking measures growth from now, not from turn
    // zero. A still-vague session gets no baseline: lastTryTurns is its tracker, and a baseline
    // here would gate out every later attempt and strand the session untitled.
    if (!vague && sess.lastCheckTurns === 0) { sess.lastCheckTurns = turns; if (!dryRun) stateMod.save(s); }
    return { action: 'no-check-needed' };
  }

  const generated = titler.generateTitle({
    currentTitle: vague ? null : title,
    prefixes: stateMod.topPrefixes(s),
    excerpt: t.buildExcerpt(entries),
    usePrefix: stateMod.loadConfig().prefix,
    model,
    runner,
  });

  // A dry run writes nothing - no transcript record, no state - so it never reaches the reload.
  if (dryRun) {
    return generated === 'KEEP'
      ? { action: 'kept', title: vague ? null : title }
      : { action: 'dry-run', title: generated };
  }

  // generateTitle just blocked for up to 90 seconds on `claude -p`. Anything the copy loaded before
  // that call knows about state is stale: a worker for another session that finished inside the
  // window has saved its own copy since, and writing ours over it would erase that session's drift
  // baseline, its `written` claim, and - worst of all - a manual flag a `rename` or `protect` set
  // inside the window, unprotecting a session the user had just locked.
  // Re-load and re-apply every mutation against fresh state, so the window is milliseconds wide.
  const fresh = stateMod.load();
  const freshSess = stateMod.session(fresh, sessionId);
  if (turns < freshSess.lastCheckTurns) freshSess.lastCheckTurns = 0;
  if (turns < (freshSess.lastTryTurns || 0)) freshSess.lastTryTurns = 0;

  if (generated === 'KEEP') {
    // KEEP on a session that still has no usable title is the low-signal guard, not an
    // endorsement - don't move the baseline, or the next Stop event would be gated out and
    // the session would stay untitled. Record the attempt instead, so we wait for new turns
    // rather than re-asking the same question of the same transcript.
    if (vague) freshSess.lastTryTurns = turns; else freshSess.lastCheckTurns = turns;
    stateMod.save(fresh);
    return { action: 'kept', title: vague ? null : title };
  }

  // A rename that lands inside the same 90-second window is the other thing the reload has to catch.
  // Our title would be appended after the user's and win as the last record, and the manual flag
  // their rename set would then gate out every later run - so the title we wrote over theirs would
  // stick for good. Both signals get re-read here, because a rename shows up in one or the other:
  // our own CLI writes state and transcript, the app writes only the transcript.
  if (freshSess.manual) return { action: 'manual-skip' };
  const freshEntries = t.readEntries(transcriptPath);
  const freshInfo = t.titleInfo(freshEntries);
  // The string is what identifies a title, not the record carrying it: the app re-asserts a title
  // it already has by writing it again as a custom-title, so the same name can change record type
  // between the two reads. An identical string is never a new arrival.
  const startedWith = info.title;
  // A different, non-vague custom-title appeared while we were blocked - either the app minting a
  // new auto-title or a human renaming the session. Drop the title we asked for rather than append
  // after it, because if a user typed that name seconds ago ours would take it straight back off
  // them. Nothing is marked or recorded: the app's own new auto-title is just as likely, so the
  // next Stop event judges it afresh through the normal flow. Titles that are ours, or vague, or
  // the same string the session already had are not new arrivals and don't trigger this.
  if (
    freshInfo.source === 'custom'
    && freshInfo.title !== startedWith
    && !freshSess.written.includes(freshInfo.title)
    && !t.isVagueTitle(freshInfo.title, t.firstUserText(freshEntries))
  ) {
    return { action: 'title-changed' };
  }

  // Claim the title in state BEFORE it can appear in the transcript: a crash between the two
  // writes would otherwise leave our own title looking like a human's on the next run.
  if (!freshSess.written.includes(generated)) freshSess.written.push(generated);
  stateMod.save(fresh);
  t.appendTitleRecord(transcriptPath, sessionId, generated);
  stateMod.recordTitle(fresh, sessionId, generated, turns);
  stateMod.save(fresh);
  return { action: 'titled', title: generated };
}

// Flags may appear in any order; a missing flag, or a trailing flag with no value, reads as
// undefined so the caller decides what to do about it.
function parseArgs(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  return { sessionId: get('--session'), transcriptPath: get('--transcript'), model: get('--model') };
}

function runFromArgs(argv) {
  try {
    const { sessionId, transcriptPath, model } = parseArgs(argv);
    if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) return;
    processSession({ sessionId, transcriptPath, model: model || 'haiku' });
  } catch { /* worker never fails loudly */ }
}

module.exports = { processSession, parseArgs, runFromArgs };
