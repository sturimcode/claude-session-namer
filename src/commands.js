const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('./paths');
const t = require('./transcript');
const stateMod = require('./state');
const appstore = require('./appstore');
const { PROMPT_SIGNATURE } = require('./titler');
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

const BACKFILL_USAGE = 'Usage: claude-session-namer backfill [--dry-run] [--model <model>] [--project <path>]\n';
const BACKFILL_SWITCHES = ['--dry-run'];
const BACKFILL_VALUE_FLAGS = ['--model', '--project'];

// A mistyped flag used to be ignored, and `--dryrun` or `--dry` then ran a real, writing sweep on
// a user who thought they were previewing one. Anything we don't recognize is a usage error.
// A value flag consumes the token after it whatever that token looks like, matching what opt()
// reads as its value - so the two can never disagree about which tokens are values.
function unknownBackfillArgs(argv) {
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BACKFILL_SWITCHES.includes(a)) continue;
    if (BACKFILL_VALUE_FLAGS.includes(a)) { i++; continue; }
    unknown.push(a);
  }
  return unknown;
}

async function backfill(argv, testOpts = {}) {
  const unknown = unknownBackfillArgs(argv);
  if (unknown.length) {
    return usage(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n${BACKFILL_USAGE}`);
  }
  if (badProject(argv)) return;
  const dryRun = flag(argv, '--dry-run');
  const model = opt(argv, '--model') || 'haiku';
  const all = sessions(opt(argv, '--project'));
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let titled = 0, skipped = 0, failed = 0, consecutiveFailures = 0;
  for (const sess of all) {
    if (sess.mtime > cutoff) { skipped++; continue; }
    // Belt and braces over the echo-dir exclusion in sessions(): wherever a worker transcript
    // lands, its first user message is our own prompt, and titling it would mint another.
    const first = t.firstUserText(t.readEntries(sess.file));
    if (first && first.startsWith(PROMPT_SIGNATURE)) { skipped++; continue; }
    let res;
    // One unreadable transcript, one claude invocation that dies, one unwritable state file must
    // not end the sweep - count it, say which session, and keep going.
    try {
      res = processSession({ sessionId: sess.sessionId, transcriptPath: sess.file, model, dryRun, runner: testOpts.runner });
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
    if (res.action === 'titled' || res.action === 'dry-run') {
      titled++;
      process.stdout.write(line(sess.mtime, sess.sessionId, res.title));
      if (!testOpts.runner) await sleep(500); // don't machine-gun the API across a long sweep
    } else skipped++;
  }
  // A dry run is free of writes but not of tokens - name the cost so nobody runs it as a preview.
  const summary = dryRun
    ? `[dry-run] ${titled} session(s) would be titled (each cost one model call), ${skipped} skipped`
    : `${titled} session(s) titled, ${skipped} skipped`;
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
  t.appendTitleRecord(match.file, match.sessionId, title);
  const s = stateMod.load();
  stateMod.recordTitle(s, match.sessionId, title, t.countUserTurns(t.readEntries(match.file)));
  stateMod.session(s, match.sessionId).manual = true;
  stateMod.save(s);
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
  for (const entry of appstore.entries()) {
    if (!includeRenamed && (entry.titleSource === 'user' || renamed.has(entry.cliSessionId))) continue;
    // A row the app's API can't be pointed at is not actionable, whatever its title says.
    if (typeof entry.daemonSessionId !== 'string' || !entry.daemonSessionId) continue;
    const sess = byId.get(entry.cliSessionId);
    if (!sess) continue; // a session the app knows about whose transcript isn't on this machine
    const entries = t.readEntries(sess.file);
    // Sanitized here rather than at the point of printing, so the string compared against the app's
    // title is the same string that would be pushed - no diff that a push could never close.
    const title = sanitizeTitle(t.titleInfo(entries).title);
    if (!title || t.isVagueTitle(title, t.firstUserText(entries))) continue;
    if (title === entry.title) continue;
    process.stdout.write(JSON.stringify({ sessionId: entry.daemonSessionId, currentTitle: entry.title, newTitle: title }) + '\n');
  }
}

async function config(argv) {
  if (argv.length === 0) {
    process.stdout.write(`prefix: ${stateMod.loadConfig().prefix ? 'on' : 'off'}\n`);
    return;
  }
  // argv.length is checked so a trailing argument ("config prefix on globally") is a usage error
  // rather than a setting silently applied with half the request ignored.
  if (argv.length === 2 && argv[0] === 'prefix' && (argv[1] === 'on' || argv[1] === 'off')) {
    // Spread the current config so a key this version doesn't know about survives the write.
    stateMod.saveConfig({ ...stateMod.loadConfig(), prefix: argv[1] === 'on' });
    process.stdout.write(`prefix: ${argv[1]}\n`);
    return;
  }
  usage('Usage: claude-session-namer config [prefix on|off]\n');
}

// The CLI dispatches on the command name, so the hyphenated key is the one that matters.
module.exports = { backfill, rename, protect, unprotect, list, search, sessions, config, 'sync-plan': syncPlan };
