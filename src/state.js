const fs = require('node:fs');
const paths = require('./paths');

const DEFAULT = () => ({ sessions: {}, prefixes: {} });

// The two models the titling path offers, and the only two `config model` accepts. Titles are
// eight-word phrases, which is haiku's job description, so it is the default; sonnet is there for
// users who want the better read of a messy conversation and will pay ~3x a call for it. The list
// is deliberately closed rather than a free-form model string: a name that reaches `claude -p` and
// isn't a model fails every title call, and the hook is silent on failure by design, so a typo
// would turn titling off with nothing to show for it.
const MODELS = ['haiku', 'sonnet'];
const DEFAULT_CONFIG = () => ({ prefix: true, model: 'haiku' });

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

// The written list is a set, not a log - the worker claims a title here before writing it to the
// transcript, and re-titling with the same string must not grow the list without bound.
// `records` is the transcript's record count at the same moment, the second half of the growth
// baseline. It is optional: a caller that isn't measuring growth (a hand `rename`, which locks the
// session anyway) leaves the marker as it found it rather than writing a count it didn't take.
function recordTitle(s, id, title, turns, records) {
  const sess = session(s, id);
  if (!sess.written.includes(title)) sess.written.push(title);
  sess.lastCheckTurns = turns;
  if (records !== undefined) sess.lastCheckRecords = records;
  const m = title.match(/^\[([^\]]+)\]/);
  if (m) s.prefixes[m[1]] = (s.prefixes[m[1]] || 0) + 1;
}

const topPrefixes = (s, n = 15) => Object.entries(s.prefixes).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

// Unknown keys are carried through rather than dropped: callers save with
// saveConfig({ ...loadConfig(), <field> }), so anything this function discards is anything a
// later version - or the user's own hand-edit - would silently lose on the next write.
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(paths.configFile(), 'utf8'));
    if (!isPlainObject(c)) return DEFAULT_CONFIG();
    // config.json is a plain file a user can hand-edit, so the model is normalized on the way in
    // rather than trusted - anything outside the supported pair reads as the default.
    return { ...c, prefix: c.prefix !== false, model: MODELS.includes(c.model) ? c.model : 'haiku' };
  } catch { return DEFAULT_CONFIG(); }
}

function saveConfig(c) {
  fs.mkdirSync(paths.stateDir(), { recursive: true });
  const tmp = paths.configFile() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, paths.configFile());
}

module.exports = { load, save, session, recordTitle, topPrefixes, loadConfig, saveConfig, MODELS };
