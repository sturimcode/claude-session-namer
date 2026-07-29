const fs = require('node:fs');
const paths = require('./paths');

const DEFAULT = () => ({ sessions: {}, prefixes: {} });

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// A missing, corrupt, or wrong-shaped state file is never fatal - the tool starts over from
// defaults. Valid JSON with the wrong types (eg {"sessions":"oops"}) would otherwise throw
// downstream, so each field is type-checked rather than just null-checked.
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(paths.stateFile(), 'utf8'));
    if (!isPlainObject(s)) return DEFAULT();
    return {
      sessions: isPlainObject(s.sessions) ? s.sessions : {},
      prefixes: isPlainObject(s.prefixes) ? s.prefixes : {},
    };
  } catch { return DEFAULT(); }
}

// Write to a tmp file and rename so a crash mid-write can't leave a half-written state file.
// The tmp name carries the pid so concurrent hook processes can't clobber each other's write.
function save(s) {
  fs.mkdirSync(paths.stateDir(), { recursive: true });
  const tmp = paths.stateFile() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, paths.stateFile());
}

function session(s, id) {
  if (!s.sessions[id]) s.sessions[id] = { lastCheckTurns: 0, written: [], manual: false };
  return s.sessions[id];
}

function recordTitle(s, id, title, turns) {
  const sess = session(s, id);
  sess.written.push(title);
  sess.lastCheckTurns = turns;
  const m = title.match(/^\[([^\]]+)\]/);
  if (m) s.prefixes[m[1]] = (s.prefixes[m[1]] || 0) + 1;
}

const topPrefixes = (s, n = 15) => Object.entries(s.prefixes).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(paths.configFile(), 'utf8'));
    return { prefix: c.prefix !== false };
  } catch { return { prefix: true }; }
}

function saveConfig(c) {
  fs.mkdirSync(paths.stateDir(), { recursive: true });
  const tmp = paths.configFile() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, paths.configFile());
}

module.exports = { load, save, session, recordTitle, topPrefixes, loadConfig, saveConfig };
