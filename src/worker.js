const fs = require('node:fs');
const t = require('./transcript');
const stateMod = require('./state');
const titler = require('./titler');

// Decides whether this session needs a title, asks for one, and writes it.
// Returns { action, title? } - action is one of:
//   no-turns | manual-skip | no-check-needed | kept | titled | dry-run
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

  // A custom-title we didn't write, that isn't vague, is a human's - hands off from now on.
  // ai-title records are the app's own auto-titles, so they never mark a session manual;
  // a non-vague ai-title is simply the current title, subject to drift re-titling below.
  if (info.source === 'custom' && title && !vague && !sess.written.includes(title)) {
    sess.manual = true;
    stateMod.save(s);
    return { action: 'manual-skip' };
  }

  // First-title urgency only applies before a baseline exists. Once lastCheckTurns is set we
  // have either titled the session or accepted the title it arrived with, and the growth gate
  // owns every later look.
  const needsFirst = vague && sess.lastCheckTurns === 0;
  const needsRecheck = sess.lastCheckTurns > 0 && turns >= sess.lastCheckTurns * 2 && turns >= sess.lastCheckTurns + 4;
  if (!needsFirst && !needsRecheck) {
    // Sessions that arrived already titled (eg by an ai-title) have no baseline yet - set one
    // here so drift tracking measures growth from now, not from turn zero.
    if (sess.lastCheckTurns === 0) { sess.lastCheckTurns = turns; stateMod.save(s); }
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

  if (generated === 'KEEP') {
    // KEEP on a session that still has no usable title is the low-signal guard, not an
    // endorsement - don't move the baseline, or the next Stop event would be gated out and
    // the session would stay untitled.
    if (!dryRun && !vague) { sess.lastCheckTurns = turns; stateMod.save(s); }
    return { action: 'kept' };
  }
  if (dryRun) return { action: 'dry-run', title: generated };

  t.appendTitleRecord(transcriptPath, sessionId, generated);
  stateMod.recordTitle(s, sessionId, generated, turns);
  stateMod.save(s);
  return { action: 'titled', title: generated };
}

function runFromArgs(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const sessionId = get('--session');
    const transcriptPath = get('--transcript');
    if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) return;
    processSession({ sessionId, transcriptPath, model: get('--model') || 'haiku' });
  } catch { /* worker never fails loudly */ }
}

module.exports = { processSession, runFromArgs };
