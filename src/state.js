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
// doneMarker is off by default: it is an extra model call per finished session, and a checkmark in
// the sidebar is a preference, not a fix for anything. Off has to be what an absent field means too,
// so it reads `=== true` where prefix reads `!== false`.
const DEFAULT_CONFIG = () => ({ prefix: true, model: 'haiku', doneMarker: false });

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

// A prefix entry used to be a bare count, and a count is all a ranked list needs - which is how a
// prefix borrowed onto an unrelated session climbed the list and caught more strays. The entry now
// also carries `dir`, the encoded project dir the prefix was last used in, and `sample`, the most
// recent title carrying it, so a prompt can show the model enough to reject a bad fit.
// Numbers written by every earlier version stay valid forever: one reads as a count with nothing
// else known about it, and the next write upgrades the entry in place. Anything else - a string, a
// null, a hand-edited array - says nothing and reads as no entry at all.
function prefixInfo(name, value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? { name, count: value } : null;
  }
  if (!isPlainObject(value)) return null;
  const out = { name, count: Number.isFinite(value.count) && value.count > 0 ? value.count : 1 };
  if (typeof value.dir === 'string' && value.dir) out.dir = value.dir;
  if (typeof value.sample === 'string' && value.sample) out.sample = value.sample;
  return out;
}

// The written list is a set, not a log - the worker claims a title here before writing it to the
// transcript, and re-titling with the same string must not grow the list without bound.
// `records` is the transcript's record count at the same moment, the second half of the growth
// baseline. It is optional: a caller that isn't measuring growth (a hand `rename`, which locks the
// session anyway) leaves the marker as it found it rather than writing a count it didn't take.
// `dir` is the encoded project dir the title was written in, and is optional for the same reason:
// a caller that doesn't know where it is leaves the dir the entry already carried rather than
// erasing it - a `rename` says nothing about where a prefix belongs, and neither does a session
// that belongs to no project.
function recordTitle(s, id, title, turns, records, dir) {
  const sess = session(s, id);
  if (!sess.written.includes(title)) sess.written.push(title);
  sess.lastCheckTurns = turns;
  if (records !== undefined) sess.lastCheckRecords = records;
  const m = title.match(/^\[([^\]]+)\]/);
  if (!m) return;
  const name = m[1];
  const prev = prefixInfo(name, s.prefixes[name]);
  const entry = { count: (prev ? prev.count : 0) + 1 };
  const keptDir = dir || (prev && prev.dir);
  if (keptDir) entry.dir = keptDir;
  entry.sample = title;
  s.prefixes[name] = entry;
}

// The prefix list a prompt is built from, ranked. A prefix already used in this session's own
// directory comes first however small its count: raw frequency is what let a borrowed prefix
// outrank the session's own work, and the directory is the one fact that says which prefix this
// conversation probably is.
function prefixEntries(s, n = 15, dir) {
  return Object.entries(s.prefixes)
    .map(([name, value]) => prefixInfo(name, value))
    .filter(Boolean)
    .sort((a, b) => (Number(Boolean(dir) && b.dir === dir) - Number(Boolean(dir) && a.dir === dir)) || (b.count - a.count))
    .slice(0, n);
}

// Names only, which is what every caller outside the prompt wants.
const topPrefixes = (s, n = 15, dir) => prefixEntries(s, n, dir).map((e) => e.name);

// Unknown keys are carried through rather than dropped: callers save with
// saveConfig({ ...loadConfig(), <field> }), so anything this function discards is anything a
// later version - or the user's own hand-edit - would silently lose on the next write.
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(paths.configFile(), 'utf8'));
    if (!isPlainObject(c)) return DEFAULT_CONFIG();
    // config.json is a plain file a user can hand-edit, so the model is normalized on the way in
    // rather than trusted - anything outside the supported pair reads as the default.
    return {
      ...c,
      prefix: c.prefix !== false,
      model: MODELS.includes(c.model) ? c.model : 'haiku',
      doneMarker: c.doneMarker === true,
    };
  } catch { return DEFAULT_CONFIG(); }
}

function saveConfig(c) {
  fs.mkdirSync(paths.stateDir(), { recursive: true });
  const tmp = paths.configFile() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, paths.configFile());
}

module.exports = { load, save, session, recordTitle, topPrefixes, prefixEntries, loadConfig, saveConfig, MODELS };
