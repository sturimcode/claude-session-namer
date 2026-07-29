const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const t = require('./transcript');
const stateMod = require('./state');
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

function sessions(projectFilter) {
  const out = [];
  const root = paths.projectsDir();
  if (!fs.existsSync(root)) return out;
  const dirs = projectFilter ? [resolveProject(projectFilter)] : fs.readdirSync(root).map((d) => path.join(root, d));
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

const line = (mtime, sessionId, title) =>
  `${new Date(mtime).toISOString().slice(0, 10)}  ${sessionId.slice(0, 8)}  ${title || '(untitled)'}\n`;

// Sessions touched in the last 10 minutes are probably still open - titling one would race the
// app's own writes, and the Stop hook will get to it anyway.
const ACTIVE_WINDOW_MS = 10 * 60_000;

async function backfill(argv, testOpts = {}) {
  const dryRun = flag(argv, '--dry-run');
  const model = opt(argv, '--model') || 'haiku';
  const all = sessions(opt(argv, '--project'));
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let titled = 0, skipped = 0, failed = 0;
  for (const sess of all) {
    if (sess.mtime > cutoff) { skipped++; continue; }
    let res;
    // One unreadable transcript, one claude invocation that dies, one unwritable state file must
    // not end the sweep - count it, say which session, and keep going.
    try {
      res = processSession({ sessionId: sess.sessionId, transcriptPath: sess.file, model, dryRun, runner: testOpts.runner });
    } catch (err) {
      failed++;
      process.stderr.write(`  ! ${sess.sessionId.slice(0, 8)} failed: ${(err && err.message) || err}\n`);
      continue;
    }
    if (res.action === 'titled' || res.action === 'dry-run') {
      titled++;
      process.stdout.write(line(sess.mtime, sess.sessionId, res.title));
      if (!testOpts.runner) await sleep(500); // don't machine-gun the API across a long sweep
    } else skipped++;
  }
  process.stdout.write(`${dryRun ? '[dry-run] ' : ''}${titled} session(s) titled, ${skipped} skipped${failed ? `, ${failed} failed` : ''}.\n`);
}

async function rename(argv) {
  const [id, ...words] = argv;
  const title = words.join(' ').trim();
  if (!id || !title) return usage('Usage: claude-session-namer rename <session-id> "title"\n');
  const all = sessions();
  const exact = all.filter((s) => s.sessionId === id);
  const matches = exact.length ? exact : all.filter((s) => s.sessionId.startsWith(id));
  if (!matches.length) return usage(`No session found for ${id}\n`);
  // Renaming the wrong session is silent and hard to undo, so a short id that matches several
  // sessions is an error, not a coin flip.
  if (matches.length > 1) {
    return usage(`Ambiguous session id ${id} - matches ${matches.length} sessions:\n${matches.map((m) => `  ${m.sessionId}\n`).join('')}`);
  }
  const match = matches[0];
  t.appendTitleRecord(match.file, match.sessionId, title);
  const s = stateMod.load();
  stateMod.recordTitle(s, match.sessionId, title, t.countUserTurns(t.readEntries(match.file)));
  stateMod.session(s, match.sessionId).manual = true;
  stateMod.save(s);
  process.stdout.write(`Renamed ${match.sessionId.slice(0, 8)} -> ${title}\n`);
}

async function list(argv) {
  for (const sess of sessions(opt(argv, '--project')).slice(0, 50)) {
    process.stdout.write(line(sess.mtime, sess.sessionId, titleOf(sess.file)));
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

async function config(argv) {
  if (argv.length === 0) {
    process.stdout.write(`prefix: ${stateMod.loadConfig().prefix ? 'on' : 'off'}\n`);
    return;
  }
  if (argv[0] === 'prefix' && (argv[1] === 'on' || argv[1] === 'off')) {
    // Spread the current config so a key this version doesn't know about survives the write.
    stateMod.saveConfig({ ...stateMod.loadConfig(), prefix: argv[1] === 'on' });
    process.stdout.write(`prefix: ${argv[1]}\n`);
    return;
  }
  usage('Usage: claude-session-namer config [prefix on|off]\n');
}

module.exports = { backfill, rename, list, search, sessions, config };
