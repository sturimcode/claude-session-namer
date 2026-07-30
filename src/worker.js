const fs = require('node:fs');
const t = require('./transcript');
const stateMod = require('./state');
const titler = require('./titler');
const appstore = require('./appstore');

// The second growth trigger, for sessions the user-turn count cannot see: a heavily agentic session
// spends hundreds of records on two or three prompts, so its turn count barely moves while the work
// changes completely. Quadrupling keeps calls log-scaled in records the way doubling keeps them
// log-scaled in turns - a 400-record session gets a couple of re-checks rather than none. The floor
// is the other half of the condition: on a short session a quadrupling is a few dozen records of
// ordinary back-and-forth, which is noise, not a topic change.
const RECORD_GROWTH_FACTOR = 4;
const RECORD_GROWTH_FLOOR = 80;

// Decides whether this session needs a title, asks for one, and writes it.
// Returns { action, title? } - action is one of:
//   no-turns | own-prompt-skip | manual-skip | app-renamed-skip | no-check-needed | kept | titled |
//   restyled | dry-run | title-changed
// `force` opens the format-reformat gate and nothing else - see the restyle block below.
// `model` has no default here: the hook path passes none, and the configured one is read below
// alongside the prefix setting. An explicit value wins - that is `backfill --model`, and it stays
// unrestricted on purpose, so a user can point a sweep at a model the config file would not accept.
function processSession({ sessionId, transcriptPath, model, dryRun = false, force = false, runner }) {
  const entries = t.readEntries(transcriptPath);
  const turns = t.countUserTurns(entries);
  const records = entries.length;
  if (turns < 1) return { action: 'no-turns' };

  // A session that opens with one of our own prompts is this tool talking to itself: a headless
  // title or done call, or - the expensive one - a run of the hourly sidebar routine, whose first
  // user message is the task prompt we ship. Titling those spent a haiku call per run naming our own
  // automation, and the rename broke the routine's cleanup step in the field: it recognized its
  // prior runs by title, and this hook renamed them out from under it within a couple of replies.
  // Ahead of every gate below, so such a session gets no title, no drift check, and - because the
  // sweeps share this test - no done marker either.
  if (titler.isOurOwnPrompt(t.firstUserText(entries))) return { action: 'own-prompt-skip' };

  const s = stateMod.load();
  const sess = stateMod.session(s, sessionId);
  if (sess.manual) return { action: 'manual-skip' };

  // A name typed in the desktop app UI is the user's, exactly like one set through `rename`. The
  // transcript can't show that - the app files its own auto-titles as the same record type - but the
  // app's session store marks it, and that marker is the only reliable signal on disk.
  // Nothing is written here on purpose: the store is consulted live on every run, so if the marker
  // ever changes - the user renames the session again, or the app rewrites its own record - behavior
  // follows it rather than a copy of it we froze into state.
  if (appstore.titleSourceFor(sessionId) === 'user') return { action: 'app-renamed-skip' };

  const info = t.titleInfo(entries);
  let title = info.title;

  // The done marker comes off the moment the session picks up again, and it comes off mechanically -
  // no model call, because nothing about the title's meaning is in question here, only whether the
  // work is still over, and new records answer that on their own. The core is a title we already
  // wrote and already claimed, so re-appending it makes no claim we don't hold; both strings sit in
  // `written`, so neither reads as a stranger's on the next pass.
  // The test is the transcript's own title rather than the state flag: a marked title with the flag
  // lost to a corrupt state file still has to be strippable, and a flag with no marker in the
  // transcript has nothing to strip. `doneCheckedRecords` is the size the session was judged at,
  // counting the marked record itself - anything past it is the session moving again.
  const wasMarked = titler.isMarked(title);
  const core = wasMarked ? titler.stripMarker(title) : title;
  // Only `sweep-done` mints a marker, and only onto a title of ours - so a marker sitting on a core
  // we never wrote came from somewhere else, and this tool knows nothing about what it claims. That
  // distinction owns both halves of the marker's life below: whether it can be stripped mechanically
  // on resume, and whether it can be carried onto a title we are about to write.
  const markerIsOurs = wasMarked && sess.written.includes(core);
  const resuming = markerIsOurs && records > (sess.doneCheckedRecords || 0);
  if (resuming) {
    title = core;
    if (!dryRun) {
      sess.done = false;
      delete sess.doneCheckedRecords;
      stateMod.save(s);
      t.appendTitleRecord(transcriptPath, sessionId, core);
    }
  }

  const vague = t.isVagueTitle(title, t.firstUserText(entries));

  // A title we didn't write gets no special standing, whatever record type carries it. The desktop
  // app files its own auto-titles as custom-title records - the same type a rename produces - and
  // re-asserts them every few turns, so record source cannot tell a human's name from the app's.
  // Every non-vague title is simply the current title, subject to the drift flow below; protection
  // comes from the two checks above - the manual flag `rename` and `protect` set, and the app's own
  // 'user' marker - never from the title record itself.

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
  //
  // The record baseline arms rather than fires on first sight. State written before the field
  // existed carries none, and a transcript that shrank below its marker measured something that no
  // longer exists - reading either as zero would treat the session's whole history as growth and
  // re-check every long session at once. Both cases take the current size as the baseline instead,
  // so the trigger measures growth from now.
  const armRecords = !(Number.isInteger(sess.lastCheckRecords) && sess.lastCheckRecords > 0 && records >= sess.lastCheckRecords);
  const recordsGrew = !armRecords
    && records >= sess.lastCheckRecords * RECORD_GROWTH_FACTOR
    && records - sess.lastCheckRecords >= RECORD_GROWTH_FLOOR;

  const grew = turns > (sess.lastTryTurns || 0);
  const needsFirst = vague && sess.lastCheckTurns === 0 && grew;
  // Either trigger opens the drift check: the turn count doubling, or the transcript quadrupling in
  // records. The turn conditions stay exactly as they were - the record trigger is an alternative to
  // them, not an addition, because an agentic session satisfies neither however far it runs.
  const turnsGrew = turns >= sess.lastCheckTurns * 2 && turns >= sess.lastCheckTurns + 4;
  const needsRecheck = sess.lastCheckTurns > 0 && (turnsGrew || recordsGrew) && grew;

  // The prefix setting is a format contract, not a preference the model weighs per session: ask for
  // prefixes and every title the tool manages carries one, ask for bare phrases and none does. A
  // title that describes the work accurately but in the wrong shape is reformatted with its meaning
  // intact rather than re-derived - so a session titled before the setting changed, or one the app
  // named in its own format, converges the next time we look at it.
  // The look is on the growth gate - either trigger, same as the drift check - and it takes
  // precedence over a drift check: a non-conforming title can't be the answer to "has this
  // drifted", because a KEEP there would leave the format wrong for good, and on a record-triggered
  // look that is exactly the session the trigger exists for. A vague title has nothing worth
  // preserving, so the first-title path keeps it.
  // `force` bypasses the gate, and a sweep passes it. Without that bypass the feature only ever
  // reaches live sessions: a session that has been looked at before carries a baseline, and one
  // nobody is adding turns to any more never grows past it, so the gate on a finished session never
  // opens again and no sweep could converge it. The bypass is scoped to this gate alone - forcing the
  // drift recheck would re-derive meaning on every session in a sweep, at a model call each.
  const config = stateMod.loadConfig();
  const needsRestyle = !vague
    && Boolean(title)
    && !titler.matchesFormat(title, config.prefix)
    && (force || sess.lastCheckTurns === 0 || turns >= sess.lastCheckTurns * 2 || recordsGrew);

  if (!needsFirst && !needsRecheck && !needsRestyle) {
    // Sessions that arrived already titled (by the app's own title record, usually) have no
    // baseline yet - set one here so drift tracking measures growth from now, not from turn
    // zero. A still-vague session gets no baseline: lastTryTurns is its tracker, and a baseline
    // here would gate out every later attempt and strand the session untitled.
    let dirty = false;
    if (!vague && sess.lastCheckTurns === 0) { sess.lastCheckTurns = turns; dirty = true; }
    // Arming is a write of its own - the whole point is that the next run measures against the size
    // this run saw, and a baseline only held in memory would re-arm forever.
    if (armRecords) { sess.lastCheckRecords = records; dirty = true; }
    if (dirty && !dryRun) stateMod.save(s);
    return { action: 'no-check-needed' };
  }

  // The model is handed the core, never the marked string: a prompt that carried the marker could
  // have it edited, echoed, or dropped, and the marker is not the model's to decide.
  const generated = titler.generateTitle({
    currentTitle: vague ? null : core,
    prefixes: stateMod.topPrefixes(s),
    excerpt: t.buildExcerpt(entries),
    usePrefix: config.prefix,
    restyle: needsRestyle,
    model: model || config.model,
    runner,
  });

  // A session still carrying a marker of ours keeps it through a reformat. The model never saw it,
  // so re-applying it here is the only way it survives - and a restyle is a change of shape, which is
  // no reason to decide the work started up again. A session that just resumed has had the marker
  // stripped above and takes the bare title.
  // A marker on a title we did not write goes no further than that title. Re-applying it would put a
  // checkmark on a string this tool just derived and nothing ever judged finished - the same minting
  // `parseResponse` refuses when a model decorates its answer with one. It also flapped: the marked
  // core would then be ours, with no checkpoint behind it, so the resume path above stripped the
  // marker on the very next Stop event - two records and a checkmark that appeared and vanished.
  const finalTitle = markerIsOurs && !resuming ? titler.markTitle(generated) : generated;

  // A dry run writes nothing - no transcript record, no state - so it never reaches the reload.
  if (dryRun) {
    return generated === 'KEEP'
      ? { action: 'kept', title: vague ? null : title }
      : { action: 'dry-run', title: finalTitle };
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
    // A restyle is never supposed to draw a KEEP - the prompt forbids it - but the parser returns one
    // defensively whatever mode asked, so a model that disobeys lands here. The baseline moves, which
    // hands the next look back to the growth cadence rather than re-asking on every Stop event.
    if (vague) freshSess.lastTryTurns = turns; else freshSess.lastCheckTurns = turns;
    // The record baseline moves on every look, vague or not: it measures the size of the transcript
    // we last read, and a KEEP has read it in full. Leaving it behind would re-fire the record
    // trigger on the next Stop event of an agentic session, once per event, for nothing.
    freshSess.lastCheckRecords = records;
    stateMod.save(fresh);
    return { action: 'kept', title: vague ? null : title };
  }

  // A rename that lands inside the same 90-second window is the other thing the reload has to catch.
  // Our title would be appended after the user's and win as the last record, and the manual flag
  // their rename set would then gate out every later run - so the title we wrote over theirs would
  // stick for good. Both signals get re-read here, because a rename shows up in one or the other:
  // our own CLI writes state and transcript, the app writes only the transcript.
  if (freshSess.manual) return { action: 'manual-skip' };
  // A rename typed in the app UI leaves nothing in our state and nothing in the transcript that
  // says who wrote it, so neither the fresh-state check above nor the title comparison below can
  // catch it - only the store marker can. Re-read it: our title would otherwise be appended over
  // the name the user just typed, and the skip at the top would then freeze it there for good.
  // The same row answers the displacement question below, so it is read once for both.
  const registry = appstore.entryFor(sessionId);
  if (registry && registry.titleSource === 'user') return { action: 'app-renamed-skip' };
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
  const arrived = freshInfo.source === 'custom'
    && freshInfo.title !== startedWith
    && !freshSess.written.includes(freshInfo.title)
    && !t.isVagueTitle(freshInfo.title, t.firstUserText(freshEntries));
  // Except when the arrival is the app displacing us, which on an active session is what usually
  // happened: the app's auto-titler re-asserts its own registry title into the transcript, and that
  // read as a foreign rename here. Aborting on it burned a model call per Stop event and wrote
  // nothing, so a displaced session sat on the app's name for the rest of its life while its state
  // stayed frozen at the first check. The registry tells the two apart - same string, marked auto,
  // is the app writing what it already held - and the two hard protections above are unaffected:
  // both are re-checked on fresh data before this point and abort regardless.
  if (arrived && !appstore.isDisplaced(registry, freshInfo.title)) return { action: 'title-changed' };

  // Claim the title in state BEFORE it can appear in the transcript: a crash between the two
  // writes would otherwise leave our own title looking like a human's on the next run.
  // Both strings are claimed when the two differ, for the same reason the sweep records both: every
  // later comparison - displacement, echo recognition, sync-plan - matches exact strings, and a
  // marked title is two of them.
  if (!freshSess.written.includes(finalTitle)) freshSess.written.push(finalTitle);
  if (!freshSess.written.includes(generated)) freshSess.written.push(generated);
  stateMod.save(fresh);
  t.appendTitleRecord(transcriptPath, sessionId, finalTitle);
  // The append is exactly one record, and the done checkpoint has to move with it. Left where the
  // sweep set it, it reads one short of the transcript and the next run takes our own write for the
  // user picking the session back up: the marker comes off mechanically, and the next sweep pays for
  // a fresh judgment - so the one-call-per-finished-session bound is gone and the marker flaps.
  // Moving it by exactly one is what keeps a record somebody else added just as visible as before;
  // resetting it to the size we happen to see here would swallow that too.
  // recordTitle can't own this: `rename` calls it without appending anything, and the count it takes
  // is the pre-append one either way.
  if (Number.isInteger(freshSess.doneCheckedRecords)) freshSess.doneCheckedRecords += 1;
  // Recorded against the core: it is the string the prefix accounting is about, and a marked title
  // would read as having no prefix at all.
  stateMod.recordTitle(fresh, sessionId, generated, turns, records);
  stateMod.save(fresh);
  return { action: needsRestyle ? 'restyled' : 'titled', title: finalTitle };
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
    // No --model on the hook path, so this is undefined and processSession falls back to config.
    processSession({ sessionId, transcriptPath, model });
  } catch { /* worker never fails loudly */ }
}

module.exports = { processSession, parseArgs, runFromArgs };
