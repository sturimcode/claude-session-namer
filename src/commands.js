const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('./paths');
const t = require('./transcript');
const stateMod = require('./state');
const appstore = require('./appstore');
const titler = require('./titler');
const { PROMPT_SIGNATURE, DONE_PROMPT_SIGNATURE } = require('./titler');
const { processSession } = require('./worker');

const flag = (argv, name) => argv.includes(name);
const opt = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A usage error sets the exit code and returns - process.exit() can truncate a message still
// buffered on a piped stderr.
function usage(message) {
  process.stderr.write(message);
  process.exitCode = 1;
}

// --project takes a path, but the encoded dir name on its own ("-Users-me-repo") is what a user
// reads off `list`, so accept either.
const resolveProject = (p) => (fs.existsSync(p) ? p : path.join(paths.projectsDir(), p));

// The titler spawns `claude -p` with cwd set to the OS temp dir, so Claude Code files a transcript
// of every worker call under the project dir that encodes that path. Those are echoes of our own
// prompts: titling one would spawn another worker, which files another echo, and so on. The sweep
// never looks in there. realpathSync matters on macOS, where /var is a symlink to /private/var and
// Claude Code encodes the resolved path.
function echoProjectDir() {
  try {
    return path.join(paths.projectsDir(), fs.realpathSync(os.tmpdir()).replace(/[^a-zA-Z0-9]/g, '-'));
  } catch { return null; }
}

function sessions(projectFilter) {
  const out = [];
  const root = paths.projectsDir();
  if (!fs.existsSync(root)) return out;
  const echo = echoProjectDir();
  const dirs = projectFilter
    ? [resolveProject(projectFilter)]
    : fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => d !== echo);
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; } // a stray file in the projects root
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      try { out.push({ sessionId: f.slice(0, -6), file, mtime: fs.statSync(file).mtimeMs }); } catch { /* vanished */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const titleOf = (file) => t.currentTitle(t.readEntries(file));

// A title goes into a one-line JSONL record and a one-row list, so newlines, tabs, and terminal
// escapes get flattened to single spaces and the length is capped. Applied on the way in (rename)
// and on the way out (list, search) - a title the app or the model wrote never passed through here,
// and an escape sequence read off a transcript would otherwise reach the user's terminal raw. Only
// characters that would break the row are touched; punctuation, hyphens included, survives as typed.
const sanitizeTitle = (s) => String(s == null ? '' : s)
  .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/[\s\u0000-\u001f\u007f]+/g, ' ')
  .trim()
  .slice(0, 120);

// The date is the user's, not UTC - a session from last night shouldn't read as tomorrow.
// en-CA gives the ISO-shaped YYYY-MM-DD everyone can sort by eye.
// Both marks are facts about the session, not part of the title, so they arrive as their own
// arguments and are appended after the title has been sanitized - a marker built into the title
// string would be flattened along with it. A session can carry both: `[protected]` is a lock set
// here, `[renamed in app]` is a name the user typed in the desktop app.
const line = (mtime, sessionId, title, isProtected = false, isAppRenamed = false) =>
  `${new Date(mtime).toLocaleDateString('en-CA')}  ${sessionId.slice(0, 8).padEnd(8)}  ${sanitizeTitle(title) || '(untitled)'}${isProtected ? ' [protected]' : ''}${isAppRenamed ? ' [renamed in app]' : ''}\n`;

// Sessions touched in the last 10 minutes are probably still open, which means a Stop-hook worker
// of their own is already handling them - a sweep would only race that worker for the same job.
const ACTIVE_WINDOW_MS = 10 * 60_000;

// The bar the done sweep holds a session to instead, and it is deliberately far higher. Ten minutes
// of silence only says nobody is mid-reply; two hours says the session was left. The question this
// sweep asks a model is whether the work is over, and a checkmark on a session somebody is about to
// come back to is the one visible way it can be wrong.
const DONE_INACTIVITY_MS = 2 * 3600_000;

// Both prompts this tool sends land in transcripts of their own, and titling or judging one would
// mint another. sessions() already skips the project dir those land in; this is the belt-and-braces
// check for a call whose transcript lands somewhere else.
const isOurOwnPrompt = (firstUserText) =>
  Boolean(firstUserText) && (firstUserText.startsWith(PROMPT_SIGNATURE) || firstUserText.startsWith(DONE_PROMPT_SIGNATURE));

// Five dead invocations in a row is a broken `claude` binary, an expired login, or a rate limit -
// not five unlucky transcripts. Stop rather than burn the rest of the sweep on the same error.
const MAX_CONSECUTIVE_FAILURES = 5;

// An empty result from a --project that doesn't exist reads like "nothing to do" when it really
// means "you typed the path wrong". Say which. An explicit but empty value ('--project
// "$SOME_UNSET_VAR"') is the dangerous one: it resolves to the projects root, so it passes the
// existence check, then reads as falsy downstream and sweeps every session in the store.
function badProject(argv) {
  const p = opt(argv, '--project');
  // A flag typed with nothing after it reads as undefined, which is also what a missing flag
  // reads as - so the same silent whole-store sweep. The flag being present is what separates
  // "the user named a project and lost the value" from "the user asked for everything".
  if (p === undefined) {
    if (!flag(argv, '--project')) return false;
    usage('--project needs a project path or directory name - got no value\n');
    return true;
  }
  if (p.trim() === '') {
    usage('--project needs a project path or directory name - got an empty value\n');
    return true;
  }
  if (fs.existsSync(resolveProject(p))) return false;
  usage(`No project directory: ${p}\n`);
  return true;
}

// The window a default sweep covers: 30 days is roughly what a user still recognizes in their
// sidebar, and a two-year-old session isn't worth a model call.
const DEFAULT_BACKFILL_DAYS = 30;
// The cap on a default sweep: 50 sessions is a few dozen model calls and a few minutes, where the
// whole store is hundreds of calls and most of an hour.
const DEFAULT_BACKFILL_LIMIT = 50;

const DAY_MS = 24 * 3600_000;

const BACKFILL_USAGE = 'Usage: claude-session-namer backfill [--dry-run] [--model <model>] [--project <path>] [--since <days>] [--limit <n>] [--all]\n';
const BACKFILL_SWITCHES = ['--dry-run', '--all'];
const BACKFILL_VALUE_FLAGS = ['--model', '--project', '--since', '--limit'];

// A mistyped flag used to be ignored, and `--dryrun` or `--dry` then ran a real, writing sweep on
// a user who thought they were previewing one. Anything we don't recognize is a usage error.
// A value flag consumes the token after it whatever that token looks like, matching what opt()
// reads as its value - so the two can never disagree about which tokens are values.
function unknownArgs(argv, switches, valueFlags) {
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (switches.includes(a)) continue;
    if (valueFlags.includes(a)) { i++; continue; }
    unknown.push(a);
  }
  return unknown;
}

// --since and --limit are counts, so anything that isn't a positive whole number is a typo. Coercing
// it would silently pick a scope the user never asked for - '--since 1.5' as 1 day, '--since abc' as
// the whole store. Reports the problem and returns null so the caller bails.
function positiveInt(argv, name, unit) {
  const raw = opt(argv, name);
  if (raw === undefined) { usage(`${name} needs a positive whole number of ${unit} - got no value\n`); return null; }
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    usage(`${name} needs a positive whole number of ${unit} - got ${JSON.stringify(raw)}\n`);
    return null;
  }
  return Number(raw);
}

// Resolves how much history a sweep covers. Returns { days, limit }, either of which is null for
// "no bound", or null on a usage error the caller should bail on. `usageText` is the caller's own
// usage line - `sweep-done` takes no --all, so its unknown-flag check rejects one before this runs.
function sweepScope(argv, usageText) {
  const hasSince = flag(argv, '--since');
  const hasLimit = flag(argv, '--limit');
  // --all means every session, so a window or a cap alongside it is a contradiction rather than a
  // refinement - guessing which one the user meant is how a sweep ends up narrower or wider than
  // they think.
  if (flag(argv, '--all')) {
    if (hasSince || hasLimit) {
      const combined = [hasSince && '--since', hasLimit && '--limit'].filter(Boolean).join(' or ');
      usage(`--all covers your whole history, so it can't be combined with ${combined}\n${usageText}`);
      return null;
    }
    return { days: null, limit: null };
  }
  let days = DEFAULT_BACKFILL_DAYS;
  let limit = DEFAULT_BACKFILL_LIMIT;
  // --since widens the window but leaves the cap in place: asking for a year of history shouldn't
  // also opt you into a sweep of every session in it.
  if (hasSince && (days = positiveInt(argv, '--since', 'days')) === null) return null;
  if (hasLimit && (limit = positiveInt(argv, '--limit', 'sessions')) === null) return null;
  return { days, limit };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function backfill(argv, testOpts = {}) {
  const unknown = unknownArgs(argv, BACKFILL_SWITCHES, BACKFILL_VALUE_FLAGS);
  if (unknown.length) {
    return usage(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n${BACKFILL_USAGE}`);
  }
  const scope = sweepScope(argv, BACKFILL_USAGE);
  if (!scope) return;
  if (badProject(argv)) return;
  const dryRun = flag(argv, '--dry-run');
  // Undefined without the flag, which hands the choice to the configured model - a sweep with no
  // --model is the same titling job the hook does and should cost the same. The flag itself takes
  // any string: it is the escape hatch for trying a model `config model` doesn't offer.
  const model = opt(argv, '--model');
  // sessions() is newest-first, so the window filters and the cap takes the newest of what's left.
  let candidates = sessions(opt(argv, '--project'));
  if (scope.days !== null) {
    const windowStart = Date.now() - scope.days * DAY_MS;
    candidates = candidates.filter((s) => s.mtime >= windowStart);
  }
  if (scope.limit !== null) candidates = candidates.slice(0, scope.limit);
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let titled = 0, skipped = 0, failed = 0, consecutiveFailures = 0;
  for (const sess of candidates) {
    if (sess.mtime > cutoff) { skipped++; continue; }
    // Belt and braces over the echo-dir exclusion in sessions(): wherever a worker transcript
    // lands, its first user message is our own prompt, and titling it would mint another.
    if (isOurOwnPrompt(t.firstUserText(t.readEntries(sess.file)))) { skipped++; continue; }
    let res;
    // One unreadable transcript, one claude invocation that dies, one unwritable state file must
    // not end the sweep - count it, say which session, and keep going.
    try {
      // force reformats a title that is out of format now, whatever the session's drift baseline
      // says. A sweep is the user asking for their existing titles to converge on the current
      // setting, and most of those sessions are finished - their turn count will never grow, so the
      // growth gate the reformat normally waits on would never open and the sweep would do nothing.
      // It buys no extra drift checks: those still wait for the session to double.
      res = processSession({ sessionId: sess.sessionId, transcriptPath: sess.file, model, dryRun, force: true, runner: testOpts.runner });
    } catch (err) {
      failed++;
      consecutiveFailures++;
      const detail = (err && err.message) || String(err);
      process.stderr.write(`  ! ${sess.sessionId.slice(0, 8)} failed: ${detail}\n`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        process.stderr.write(`Aborting: ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last error: ${detail}\n`);
        process.exitCode = 1;
        break;
      }
      if (!testOpts.runner) await sleep(500); // a failing API needs the pause more than a working one
      continue;
    }
    consecutiveFailures = 0;
    // A restyle is a title the sweep wrote, so it counts and prints like any other - a user who
    // turns prefixes on and sweeps their history has to see which titles changed.
    if (res.action === 'titled' || res.action === 'restyled' || res.action === 'dry-run') {
      titled++;
      process.stdout.write(line(sess.mtime, sess.sessionId, res.title));
      if (!testOpts.runner) await sleep(500); // don't machine-gun the API across a long sweep
    } else skipped++;
  }
  // A scoped sweep looks identical to a full one from the output, so say what it covered - otherwise
  // a user whose older sessions went untouched reads the run as broken rather than as bounded.
  if (scope.days !== null) {
    process.stdout.write(`Scanned the ${plural(candidates.length, 'newest session')} from the last ${plural(scope.days, 'day')} (use --all for full history).\n`);
  }
  // A dry run is free of writes but not of tokens - name the cost so nobody runs it as a preview.
  const summary = dryRun
    ? `[dry-run] ${titled} session(s) would be titled (each cost one model call), ${skipped} skipped`
    : `${titled} session(s) titled, ${skipped} skipped`;
  process.stdout.write(`${summary}${failed ? `, ${failed} failed` : ''}.\n`);
}

const SWEEP_DONE_USAGE = 'Usage: claude-session-namer sweep-done [--dry-run] [--project <path>] [--since <days>] [--limit <n>]\n';
const SWEEP_DONE_SWITCHES = ['--dry-run'];
// No --model: the judgment is the same size of question the titler asks and belongs on the same
// configured model. No --all either - marking a session from last year as finished tells nobody
// anything, and it would be a model call each to say it.
const SWEEP_DONE_VALUE_FLAGS = ['--project', '--since', '--limit'];

// Marks the sessions whose work has stopped, so a sidebar shows at a glance which ones are still
// live. Opt-in: off by default, and a no-op when off, because the scheduled sidebar routine calls it
// unconditionally and a setting nobody turned on should cost nothing rather than error.
//
// The economy is the whole design. A session is judged once per size it reaches: answer ONGOING and
// the size is recorded, so the next sweep over an untouched session asks nothing; answer DONE and
// the session is flagged and never asked again until it resumes, which is the worker's job to
// notice. A finished session therefore costs exactly one model call, ever - not one per sweep.
async function sweepDone(argv, testOpts = {}) {
  const unknown = unknownArgs(argv, SWEEP_DONE_SWITCHES, SWEEP_DONE_VALUE_FLAGS);
  if (unknown.length) {
    return usage(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n${SWEEP_DONE_USAGE}`);
  }
  const config = stateMod.loadConfig();
  // Off is not a usage error - it is the default, and the routine that calls this hourly has no way
  // to know the setting. One line, exit 0, nothing written.
  if (!config.doneMarker) {
    process.stdout.write('Done markers are off - nothing swept. Turn them on with: claude-session-namer config done-marker on\n');
    return;
  }
  const scope = sweepScope(argv, SWEEP_DONE_USAGE);
  if (!scope) return;
  if (badProject(argv)) return;
  const dryRun = flag(argv, '--dry-run');
  // Same scoping as backfill, and for the same reason: the sessions a user still recognizes in
  // their sidebar are the only ones a marker helps them read.
  let candidates = sessions(opt(argv, '--project'));
  if (scope.days !== null) {
    const windowStart = Date.now() - scope.days * DAY_MS;
    candidates = candidates.filter((s) => s.mtime >= windowStart);
  }
  if (scope.limit !== null) candidates = candidates.slice(0, scope.limit);
  const cutoff = Date.now() - DONE_INACTIVITY_MS;
  // One walk of the app store for the whole sweep, like `list` - a per-session lookup would re-read
  // its few hundred files for every candidate.
  const renamed = appstore.userRenamedIds();
  let marked = 0, skipped = 0, failed = 0, consecutiveFailures = 0;
  for (const sess of candidates) {
    if (sess.mtime > cutoff) { skipped++; continue; }
    const entries = t.readEntries(sess.file);
    const first = t.firstUserText(entries);
    if (isOurOwnPrompt(first)) { skipped++; continue; }
    const title = t.titleInfo(entries).title;
    const st = stateMod.load().sessions[sess.sessionId];
    // Everything this sweep can act on is a title of ours that is still the session's title. A
    // session we never titled has nothing of ours to mark; a locked one and a name typed in the app
    // are the two hard protections, unchanged here; an already-marked one is answered.
    const ours = st && Array.isArray(st.written) && title && st.written.includes(title);
    if (!ours || st.manual || st.done || renamed.has(sess.sessionId)) { skipped++; continue; }
    if (t.isVagueTitle(title, first)) { skipped++; continue; }
    // One judgment per session size. Without this a sweep would re-ask the same question of the same
    // unchanged transcript every time it ran, at a model call each.
    const records = entries.length;
    if (Number.isInteger(st.doneCheckedRecords) && st.doneCheckedRecords >= records) { skipped++; continue; }

    // The cutoff was taken once, before the loop, but each candidate costs a model call of up to 90
    // seconds - so a session judged late in a long sweep was screened on an mtime that can be many
    // minutes old, and one the user came back to at minute three could still collect a checkmark.
    // Re-stat right before the call, and again after it, on the same cutoff: a file that has moved
    // since is a session in use. A vanished file reads the same way - there is nothing to mark.
    const stillIdle = () => { try { return fs.statSync(sess.file).mtimeMs <= cutoff; } catch { return false; } };
    if (!stillIdle()) { skipped++; continue; }

    let done;
    // One unreadable transcript or one dead `claude` invocation must not end the sweep - count it,
    // say which session, and keep going, the same way backfill does.
    try {
      done = titler.judgeDone({
        currentTitle: title,
        // The tail alone: whether the work stopped is a fact about how the session ended, and the
        // opening turns would only dilute it.
        excerpt: t.buildExcerpt(entries, 4000, { headTurns: 0, tailTurns: 12 }),
        model: config.model,
        runner: testOpts.runner,
      });
    } catch (err) {
      failed++;
      consecutiveFailures++;
      const detail = (err && err.message) || String(err);
      process.stderr.write(`  ! ${sess.sessionId.slice(0, 8)} failed: ${detail}\n`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        process.stderr.write(`Aborting: ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last error: ${detail}\n`);
        process.exitCode = 1;
        break;
      }
      if (!testOpts.runner) await sleep(500);
      continue;
    }
    consecutiveFailures = 0;
    // The other half of the fresh re-check: the session may have been picked up while the judgment
    // was in flight. Nothing is recorded on the way out - a checkpoint here would say the session was
    // judged at a size that no longer describes it, and the answer was about a transcript that has
    // moved on. A dry run skips it too, so the preview says what a real run would do.
    if (!stillIdle()) { skipped++; continue; }

    const markedTitle = titler.markTitle(title);
    if (dryRun) {
      // Nothing is written on this path, state included - so a second dry run judges the same
      // sessions again, and says so by printing them again.
      if (done) { marked++; process.stdout.write(line(sess.mtime, sess.sessionId, markedTitle)); } else skipped++;
      if (!testOpts.runner) await sleep(500);
      continue;
    }

    // The judgment blocked for up to 90 seconds. Everything read before it is stale, so state is
    // re-loaded and every protection re-checked against fresh data - the same discipline the worker
    // keeps, and for the same reason: a `protect` typed inside that window owns the session now.
    const fresh = stateMod.load();
    const freshSess = stateMod.session(fresh, sess.sessionId);
    if (freshSess.manual || appstore.titleSourceFor(sess.sessionId) === 'user') { skipped++; continue; }
    // And the title we judged has to still be the session's: an app re-assertion or a rename landing
    // inside the window means the judgment was about a name that is no longer there.
    if (t.titleInfo(t.readEntries(sess.file)).title !== title) { skipped++; continue; }

    if (!done) {
      freshSess.doneCheckedRecords = records;
      stateMod.save(fresh);
      skipped++;
      if (!testOpts.runner) await sleep(500);
      continue;
    }

    // Claim before the transcript can carry it, the ordering every titled path here keeps: a crash
    // between the two writes must never leave a title of ours reading as somebody else's. Both
    // strings go in, because displacement detection, echo recognition and sync-plan all compare
    // exact strings and a marked title is two of them.
    if (!freshSess.written.includes(markedTitle)) freshSess.written.push(markedTitle);
    if (!freshSess.written.includes(title)) freshSess.written.push(title);
    stateMod.save(fresh);
    t.appendTitleRecord(sess.file, sess.sessionId, markedTitle);
    freshSess.done = true;
    // The append is exactly one record, and the checkpoint has to count it: the worker reads any
    // record past this number as the session moving again, and our own write is not that.
    freshSess.doneCheckedRecords = records + 1;
    stateMod.save(fresh);
    marked++;
    process.stdout.write(line(sess.mtime, sess.sessionId, markedTitle));
    if (!testOpts.runner) await sleep(500);
  }
  if (scope.days !== null) {
    process.stdout.write(`Scanned the ${plural(candidates.length, 'newest session')} from the last ${plural(scope.days, 'day')}.\n`);
  }
  const summary = dryRun
    ? `[dry-run] ${marked} session(s) would be marked done (each cost one model call), ${skipped} skipped`
    : `${marked} session(s) marked done, ${skipped} skipped`;
  process.stdout.write(`${summary}${failed ? `, ${failed} failed` : ''}.\n`);
}

// Every command that acts on one session takes the same id: the full one, or any prefix of it that
// picks out exactly one session. Acting on the wrong session is silent and hard to undo, so a short
// id matching several is an error, not a coin flip. Reports the problem and returns null on a miss,
// so callers just bail.
function matchSession(id) {
  const all = sessions();
  const exact = all.filter((s) => s.sessionId === id);
  const matches = exact.length ? exact : all.filter((s) => s.sessionId.startsWith(id));
  if (!matches.length) { usage(`No session found for ${id}\n`); return null; }
  if (matches.length > 1) {
    usage(`Ambiguous session id ${id} - matches ${matches.length} sessions:\n${matches.map((m) => `  ${m.sessionId}\n`).join('')}`);
    return null;
  }
  return matches[0];
}

// Protection is an explicit act and lives only in state - no title record is written, so an app-set
// or tool-set title is locked exactly as it stands. Nothing about a title record itself can confer
// protection: the desktop app writes its own auto-titles as the same `custom-title` records a human
// rename produces, so the transcript cannot tell the two apart. The app's own session store can, and
// the worker reads it - but only on macOS, and only for sessions the app knows about, so `protect`
// stays the guarantee.
function setManual(argv, value, verb) {
  const [id, ...rest] = argv;
  if (!id || rest.length) return usage(`Usage: claude-session-namer ${verb} <session-id>\n`);
  const match = matchSession(id);
  if (!match) return;
  const s = stateMod.load();
  // session() creates the entry when the tool has never seen this session, so unprotecting one it
  // doesn't know about is a no-op rather than a crash.
  stateMod.session(s, match.sessionId).manual = value;
  stateMod.save(s);
  process.stdout.write(
    value
      ? `Protected ${match.sessionId.slice(0, 8)} - its title won't be changed\n`
      : `Unprotected ${match.sessionId.slice(0, 8)} - it can be re-titled again\n`
  );
}

async function protect(argv) { setManual(argv, true, 'protect'); }
async function unprotect(argv) { setManual(argv, false, 'unprotect'); }

async function rename(argv) {
  const [id, ...words] = argv;
  // A title that sanitizes down to nothing is a usage error, not an empty rename.
  const title = sanitizeTitle(words.join(' '));
  if (!id || !title) return usage('Usage: claude-session-namer rename <session-id> "title"\n');
  const match = matchSession(id);
  if (!match) return;
  // Claim in state, save, then append - the crash ordering every titled path here keeps. Appending
  // first would put a hand-typed name in the transcript with nothing anywhere claiming it, and a
  // failed save (a full disk, an unwritable state dir) would leave it that way: the next worker run
  // reads an unclaimed, unlocked title and reformats it straight off the session. This way the worst
  // a failure leaves is the old title, and the user runs rename again.
  const s = stateMod.load();
  stateMod.recordTitle(s, match.sessionId, title, t.countUserTurns(t.readEntries(match.file)));
  const sess = stateMod.session(s, match.sessionId);
  sess.manual = true;
  // A rename replaces the title wholesale, marker included - a name somebody typed does not inherit
  // a checkmark. Clearing the flags with it keeps them honest: the session is not marked any more,
  // and if the lock is ever dropped it can be judged again rather than read as already answered.
  sess.done = false;
  delete sess.doneCheckedRecords;
  stateMod.save(s);
  t.appendTitleRecord(match.file, match.sessionId, title);
  process.stdout.write(`Renamed ${match.sessionId.slice(0, 8)} -> ${title}\n`);
}

async function list(argv) {
  if (badProject(argv)) return;
  // Neither mark shows in the transcript - one lives in our state, the other in the desktop app's -
  // so the listing is the only place a user can see which sessions the tool has stopped re-titling.
  // Both are read once for the whole listing: a per-row lookup in the app store would walk its few
  // hundred files again for every session printed, which costs seconds.
  const { sessions: known } = stateMod.load();
  const appRenamed = appstore.userRenamedIds();
  for (const sess of sessions(opt(argv, '--project')).slice(0, 50)) {
    const entry = known[sess.sessionId];
    process.stdout.write(line(sess.mtime, sess.sessionId, titleOf(sess.file), Boolean(entry && entry.manual), appRenamed.has(sess.sessionId)));
  }
}

async function search(argv) {
  const q = argv.join(' ').toLowerCase();
  if (!q) return usage('Usage: claude-session-namer search <query>\n');
  for (const sess of sessions()) {
    const title = titleOf(sess.file);
    let raw = '';
    try { raw = fs.readFileSync(sess.file, 'utf8'); } catch { /* vanished mid-sweep */ }
    if ((title && title.toLowerCase().includes(q)) || raw.toLowerCase().includes(q)) {
      process.stdout.write(line(sess.mtime, sess.sessionId, title));
    }
  }
}

// The desktop app's sidebar reads the app's own registry, not the transcript, so a title written
// here never reaches it. This command computes what would have to be pushed to close that gap -
// one JSON line per session whose transcript title differs from the name the app is showing - and
// pushes nothing itself. An agent holding the app's session-rename tool applies the plan.
//
// stdout is machine-read, so it carries JSON lines and nothing else; an empty plan prints nothing
// and exits 0. Sessions the user renamed in the app are left out by default - pushing our title
// over a name they typed is the one thing this must never cause - and --all opts back in.
async function syncPlan(argv) {
  const unknown = argv.filter((a) => a !== '--all');
  if (unknown.length) {
    return usage(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\nUsage: claude-session-namer sync-plan [--all]\n`);
  }
  const includeRenamed = flag(argv, '--all');
  // One walk of the projects tree for the whole plan - the store can hold hundreds of records, and
  // resolving each one's transcript on its own would re-read every project dir per record.
  const byId = new Map();
  for (const sess of sessions()) if (!byId.has(sess.sessionId)) byId.set(sess.sessionId, sess);
  // The exclusion is per session, not per record. The store can hold several records for one
  // session, and only one of them need carry the user marker for the name to be theirs - checking
  // this row's own titleSource alone would still emit a push against a stale sibling row.
  const renamed = appstore.userRenamedIds();
  // Which titles are ours lives in state and nowhere else - the transcript cannot tell our record
  // from the app's. Loaded once for the whole plan, like the walk above.
  const { sessions: known } = stateMod.load();
  for (const entry of appstore.entries()) {
    if (!includeRenamed && (entry.titleSource === 'user' || renamed.has(entry.cliSessionId))) continue;
    // A row the app's API can't be pointed at is not actionable, whatever its title says.
    if (typeof entry.daemonSessionId !== 'string' || !entry.daemonSessionId) continue;
    const sess = byId.get(entry.cliSessionId);
    if (!sess) continue; // a session the app knows about whose transcript isn't on this machine
    const entries = t.readEntries(sess.file);
    // Sanitized here rather than at the point of printing, so the string compared against the app's
    // title is the same string that would be pushed - no diff that a push could never close.
    const transcriptTitle = sanitizeTitle(t.titleInfo(entries).title);
    if (!transcriptTitle) continue;
    // Titles this tool wrote for the session, newest last. A manual session has none for this
    // purpose: `rename` and `protect` are exempt from a re-push the same way they are exempt from a
    // re-title, and so is a name the user typed in the app.
    const st = known[entry.cliSessionId];
    const ours = st && !st.manual && Array.isArray(st.written)
      ? st.written.map(sanitizeTitle).filter(Boolean)
      : [];
    // Displacement, observed live 2026-07-29 on the then-current desktop app: while a session is
    // active the app re-asserts its REGISTRY title into the transcript, over the record we appended.
    // Both sides then read as the app's name, the plain diff is empty, and the session keeps the
    // app's title for good even though the tool titled it. The test for it is shared with the
    // worker's mid-generate guard (`appstore.isDisplaced`), which reads the same two shapes off the
    // same store row. Where it fires, the only title worth proposing is our newest: pushing the
    // foreign string back would argue with a push that already landed. A displacing title the
    // registry does not share came from somewhere else - another tool, a hand edit - and stays with
    // the ordinary diff below.
    const displaced = ours.length > 0 && appstore.isDisplaced(entry, transcriptTitle, ours);
    const title = displaced ? ours[ours.length - 1] : transcriptTitle;
    if (t.isVagueTitle(title, t.firstUserText(entries))) continue;
    // Nothing to push once the registry already says it - which is also what makes a re-push
    // idempotent rather than a loop.
    if (title === entry.title) continue;
    process.stdout.write(JSON.stringify({ sessionId: entry.daemonSessionId, currentTitle: entry.title, newTitle: title }) + '\n');
  }
}

// What `sync-plan` computes still has to be pushed, and the only writer the app trusts is its own
// session-rename tool, held by an agent inside a desktop session. An hourly scheduled task is that
// agent. The task registry is the app's own - it carries the cron line and the tool permissions the
// user approved - so nothing here ever writes it. We hand over the instructions and the app creates
// the routine, with the user's consent, through its own tooling.
const SIDEBAR_TASK_ID = 'session-title-sidebar-sync';
// Hourly, off the top of the hour: the app staggers scheduled starts anyway, and a minute nobody
// else picks keeps this out of the crowd at :00.
const SIDEBAR_TASK_CRON = '2 * * * *';

// The invocation is the bare command name on purpose. ${CLAUDE_PLUGIN_ROOT} resolves only in plugin
// components - hook and monitor commands, MCP and LSP config, and the plugin's own skill content -
// and a scheduled task's prompt is none of those: it lives in the app's task store, where the
// placeholder would reach the Bash tool as an unset shell variable and run `node "/bin/cli.js"`.
// The bare name covers both install paths instead. npm puts it on the shell PATH; an enabled
// plugin's bin/ is on the Bash tool's PATH in any session, and a scheduled run is an ordinary local
// session, so the plugin's own wrapper answers there.
const SIDEBAR_TASK_PROMPT = `Sync claude-session-namer titles into the Claude Code desktop sidebar, then tidy up.

1. Run \`claude-session-namer sync-plan\` (do NOT pass \`--all\` - user-renamed sessions must stay excluded). If the command is not found, stop and say so: it is on this session's Bash PATH only while the plugin is enabled for this folder, or when the npm package is installed globally. Do not guess at a path.
2. The output is JSON lines, each {"sessionId", "currentTitle", "newTitle"}. Empty output means nothing to sync - continue with step 4.
3. For each line in order, call the app's session-rename tool (set_session_title) with that sessionId and newTitle. Stop immediately on the first error - no retries, no continuing - and report what failed.
4. Run \`claude-session-namer sweep-done\`. It is a no-op unless the user turned done markers on.
5. Cleanup: list this app's sessions and archive prior completed runs of this same scheduled task - sessions that are not the current one and whose title exactly matches this task's own name. Never archive the current session, and never archive anything whose title does not match.

Take no actions beyond these: sync-plan, sweep-done, the per-session rename calls, and archiving this task's own previous run sessions. Never run backfill or any other command, and never delete anything.`;

// The paste path, for an install with no plugin to carry the skill. It is one message to a desktop
// session: the same creation step the skill runs, condensed to what the assistant needs.
const SIDEBAR_PASTE_BLOCK = `Set up the claude-session-namer sidebar sync. Using this app's own scheduled-task tool, create a scheduled task with the id \`${SIDEBAR_TASK_ID}\`, running hourly on the cron schedule \`${SIDEBAR_TASK_CRON}\`. List the existing scheduled tasks first: if one already carries that id, update it rather than adding a second, and never pass \`fireAt\` on that update - a one-time fire time replaces the cron schedule. The task prompt must be exactly this:

${SIDEBAR_TASK_PROMPT}

Then offer to pre-approve the routine's permissions durably, and with my consent add these to the permissions.allow array in ~/.claude/settings.json (read the file first, merge, never replace other entries): "Bash(claude-session-namer sync-plan:*)", "Bash(claude-session-namer sweep-done:*)", "mcp__ccd_session_mgmt__set_session_title", "mcp__ccd_session_mgmt__archive_session". Run-time prompt approvals do not reliably persist for the app's own tools. Finish by offering to prove the path once now, by running the task's steps yourself in this session: \`claude-session-namer sync-plan\`, then the set_session_title call for each line it prints, then \`claude-session-namer sweep-done\`, skipping the cleanup step. Never test it by scheduling the task to fire: a one-time \`fireAt\` run clears the cron schedule and the task disables itself after firing, which leaves the hourly sync dead with nothing said.
`;

// Printed by install only when the user says they use the desktop app.
const SIDEBAR_POINTER = `
The desktop app's sidebar reads the app's own registry, not the transcript, so the titles this tool writes reach the CLI but not the sidebar. An hourly scheduled task in the app closes that gap.
Plugin install: run /claude-session-namer:setup-sidebar-sync in a desktop session.
npm install: paste the block below into a desktop session. 'claude-session-namer sidebar-setup' prints it again.

${SIDEBAR_PASTE_BLOCK}`;

// Unconditional - no terminal check, no platform check. A user who asks for the block wants the
// block, and it is as pasteable through a pipe as it is off a screen.
async function sidebarSetup(argv) {
  if (argv.length) {
    return usage(`Unknown option${argv.length > 1 ? 's' : ''}: ${argv.join(', ')}\nUsage: claude-session-namer sidebar-setup\n`);
  }
  process.stdout.write(SIDEBAR_PASTE_BLOCK);
}

// Printed once, when the user opts in. Sonnet is a real step up per call and the one-line command
// that selects it is the only place to say so. The numbers are the published API rates, which is
// what makes the ratio checkable; the last clause is the part that matters, since a handful of
// title calls costs a fraction of a cent either way and a full-history sweep is where it shows.
const SONNET_COST_NOTE = 'Heads up: a sonnet call costs about 3x a haiku call (API rates: $3 vs $1 per million input tokens, $15 vs $5 output). Titles are short, so each call is tiny either way - it adds up mainly on a big backfill.\n';

const CONFIG_USAGE = 'Usage: claude-session-namer config [prefix on|off] [model haiku|sonnet] [done-marker on|off]\n';

async function config(argv) {
  const current = stateMod.loadConfig();
  // Bare `config` is the only view of what the tool is set to, so it prints every setting - one a
  // user can change but never read back is one they can't tell they changed. The keys printed are
  // the words `config` accepts back, so a reading is also a set of commands.
  if (argv.length === 0) {
    process.stdout.write(`prefix: ${current.prefix ? 'on' : 'off'}\nmodel: ${current.model}\ndone-marker: ${current.doneMarker ? 'on' : 'off'}\n`);
    return;
  }
  // argv.length is checked so a trailing argument ("config prefix on globally") is a usage error
  // rather than a setting silently applied with half the request ignored.
  if (argv.length === 2 && argv[0] === 'prefix' && (argv[1] === 'on' || argv[1] === 'off')) {
    // Spread the current config so a key this version doesn't know about survives the write.
    stateMod.saveConfig({ ...current, prefix: argv[1] === 'on' });
    process.stdout.write(`prefix: ${argv[1]}\n`);
    return;
  }
  // Only the two supported names, and nothing is written on a miss. An arbitrary model string here
  // would reach `claude -p` on every Stop event, where a name that doesn't resolve fails the call
  // and the hook swallows it - titling would just stop, with nothing said. `backfill --model` is
  // where an unlisted model can still be tried, for one run the user is watching.
  if (argv.length === 2 && argv[0] === 'model' && stateMod.MODELS.includes(argv[1])) {
    stateMod.saveConfig({ ...current, model: argv[1] });
    process.stdout.write(`model: ${argv[1]}\n`);
    if (argv[1] === 'sonnet') process.stdout.write(SONNET_COST_NOTE);
    return;
  }
  if (argv.length === 2 && argv[0] === 'done-marker' && (argv[1] === 'on' || argv[1] === 'off')) {
    stateMod.saveConfig({ ...current, doneMarker: argv[1] === 'on' });
    process.stdout.write(`done-marker: ${argv[1]}\n`);
    return;
  }
  usage(CONFIG_USAGE);
}

// The CLI dispatches on the command name, so the hyphenated key is the one that matters.
module.exports = {
  backfill, rename, protect, unprotect, list, search, sessions, config,
  'sweep-done': sweepDone,
  'sync-plan': syncPlan,
  'sidebar-setup': sidebarSetup,
  SIDEBAR_TASK_PROMPT, SIDEBAR_PASTE_BLOCK, SIDEBAR_POINTER,
};
