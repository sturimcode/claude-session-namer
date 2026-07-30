const { test } = require('node:test');
const assert = require('node:assert');
const fx = require('./fixtures');

function freshState() {
  process.env.CLAUDE_CONFIG_DIR = fx.tmpDir();
  delete require.cache[require.resolve('../src/state')];
  delete require.cache[require.resolve('../src/paths')];
  return require('../src/state');
}

test('load returns default on missing file, round-trips after save', () => {
  const state = freshState();
  const s = state.load();
  assert.deepEqual(s, { sessions: {}, prefixes: {} });
  state.session(s, 'abc').lastCheckTurns = 3;
  state.save(s);
  assert.equal(state.load().sessions.abc.lastCheckTurns, 3);
});

test('load returns default on corrupt file', () => {
  const state = freshState();
  const paths = require('../src/paths');
  require('node:fs').mkdirSync(paths.stateDir(), { recursive: true });
  require('node:fs').writeFileSync(paths.stateFile(), '{broken');
  assert.deepEqual(state.load(), { sessions: {}, prefixes: {} });
});

test('load defaults wrong-typed fields to empty objects', () => {
  const state = freshState();
  const paths = require('../src/paths');
  require('node:fs').mkdirSync(paths.stateDir(), { recursive: true });
  require('node:fs').writeFileSync(paths.stateFile(), '{"sessions":"oops"}');
  const s = state.load();
  assert.deepEqual(s, { sessions: {}, prefixes: {} });
  state.session(s, 'x').lastCheckTurns = 1;
  assert.equal(s.sessions.x.lastCheckTurns, 1);

  require('node:fs').writeFileSync(paths.stateFile(), '{"sessions":{},"prefixes":[1,2]}');
  assert.deepEqual(state.load(), { sessions: {}, prefixes: {} });
});

test('loadConfig defaults prefix to true and round-trips', () => {
  const state = freshState();
  assert.deepEqual(state.loadConfig(), { prefix: true, model: 'haiku', doneMarker: false });
  state.saveConfig({ prefix: false });
  assert.deepEqual(state.loadConfig(), { prefix: false, model: 'haiku', doneMarker: false });
});

test('loadConfig defaults model to haiku and round-trips sonnet', () => {
  const state = freshState();
  assert.equal(state.loadConfig().model, 'haiku');
  state.saveConfig({ ...state.loadConfig(), model: 'sonnet' });
  assert.deepEqual(state.loadConfig(), { prefix: true, model: 'sonnet', doneMarker: false });
});

// The CLI only ever writes one of the two, but config.json is a plain file a user can edit. A model
// name we don't support reaching `claude -p` would fail every title call silently, so an unknown
// value reads as the default rather than being passed through.
test('loadConfig falls back to haiku on a model it does not support', () => {
  const state = freshState();
  const paths = require('../src/paths');
  require('node:fs').mkdirSync(paths.stateDir(), { recursive: true });
  for (const bad of ['opus', '', 'Sonnet', 42, null]) {
    require('node:fs').writeFileSync(paths.configFile(), JSON.stringify({ prefix: true, model: bad }));
    assert.equal(state.loadConfig().model, 'haiku', `model ${JSON.stringify(bad)} should read as haiku`);
  }
});

test('loadConfig keeps keys it does not know about', () => {
  const state = freshState();
  const paths = require('../src/paths');
  require('node:fs').mkdirSync(paths.stateDir(), { recursive: true });
  require('node:fs').writeFileSync(paths.configFile(), JSON.stringify({ model: 'haiku', prefix: false }));
  assert.deepEqual(state.loadConfig(), { model: 'haiku', prefix: false, doneMarker: false }, 'a save built on loadConfig would otherwise drop them');
  state.saveConfig({ ...state.loadConfig(), prefix: true });
  assert.deepEqual(state.loadConfig(), { model: 'haiku', prefix: true, doneMarker: false });
});

test('loadConfig falls back to defaults on a wrong-shaped config file', () => {
  const state = freshState();
  const paths = require('../src/paths');
  require('node:fs').mkdirSync(paths.stateDir(), { recursive: true });
  require('node:fs').writeFileSync(paths.configFile(), '["oops"]');
  assert.deepEqual(state.loadConfig(), { prefix: true, model: 'haiku', doneMarker: false });

  require('node:fs').writeFileSync(paths.configFile(), '{broken');
  assert.deepEqual(state.loadConfig(), { prefix: true, model: 'haiku', doneMarker: false });
});

test('recordTitle tracks written titles and prefix counts', () => {
  const state = freshState();
  const s = state.load();
  state.recordTitle(s, 'abc', '[Emails] SES bounce fix', 5);
  state.recordTitle(s, 'def', '[Emails] Alias rollout', 2);
  state.recordTitle(s, 'ghi', '[CSA] Defaults audit', 1);
  assert.deepEqual(s.sessions.abc.written, ['[Emails] SES bounce fix']);
  assert.equal(s.sessions.abc.lastCheckTurns, 5);
  // A prefix entry is an object now - the count plus where the prefix is used - so the count is read
  // off the entry rather than being the entry. A number written by an earlier version still reads;
  // see the migration test below.
  assert.equal(s.prefixes['Emails'].count, 2);
  assert.deepEqual(state.topPrefixes(s, 1), ['Emails']);
});

// A prefix used to be a bare count, which said nothing about whether it belonged to the session in
// front of it. It now carries the project dir it was last used in and a title that carries it, so a
// prompt can show the model enough to reject a bad fit.
test('recordTitle records where a prefix is used and a sample title carrying it', () => {
  const state = freshState();
  const s = state.load();
  state.recordTitle(s, 'abc', '[API] Rate limiter fix', 5, 120, '-Users-x-projects-api');
  assert.deepEqual(s.prefixes.API, { count: 1, dir: '-Users-x-projects-api', sample: '[API] Rate limiter fix' });
  state.recordTitle(s, 'def', '[API] Retry backoff', 2, 40, '-Users-x-projects-api');
  assert.deepEqual(s.prefixes.API, { count: 2, dir: '-Users-x-projects-api', sample: '[API] Retry backoff' });
});

// State files written before the entry grew are valid forever - a number reads as a count with
// nothing else known about it, and the next write upgrades it in place rather than starting over.
test('a numeric prefix entry still reads, and upgrades on the next write', () => {
  const state = freshState();
  const s = state.load();
  s.prefixes = { Legacy: 3 };
  state.save(s);
  const loaded = state.load();
  assert.deepEqual(state.topPrefixes(loaded), ['Legacy']);
  assert.deepEqual(state.prefixEntries(loaded), [{ name: 'Legacy', count: 3 }]);

  state.recordTitle(loaded, 'abc', '[Legacy] Old billing path', 4, 90, '-Users-x-projects-billing');
  assert.deepEqual(loaded.prefixes.Legacy, { count: 4, dir: '-Users-x-projects-billing', sample: '[Legacy] Old billing path' });
});

// A rename takes no project dir - it is not measuring anything - so a write that doesn't know where
// it is must not erase what the last one did know.
test('a write with no project dir keeps the dir the entry already had', () => {
  const state = freshState();
  const s = state.load();
  state.recordTitle(s, 'abc', '[API] Rate limiter fix', 5, 120, '-Users-x-projects-api');
  state.recordTitle(s, 'def', '[API] Retry backoff', 2);
  assert.equal(s.prefixes.API.dir, '-Users-x-projects-api');
  assert.equal(s.prefixes.API.sample, '[API] Retry backoff');
});

// Raw count ordering is what let a borrowed prefix climb: the more strays it caught, the higher it
// ranked. A prefix already used in this session's own directory outranks a bigger one from
// somebody else's work.
test('prefixEntries ranks this session own directory first, then by count', () => {
  const state = freshState();
  const s = state.load();
  s.prefixes = {
    Domestique: { count: 9, dir: '-Users-x-projects-domestique', sample: '[Domestique] Contact form' },
    API: { count: 2, dir: '-Users-x-projects-api', sample: '[API] Rate limiter fix' },
    Emails: 5,
  };
  assert.deepEqual(state.prefixEntries(s, 15, '-Users-x-projects-api').map((e) => e.name), ['API', 'Domestique', 'Emails']);
  // with no directory to match on, the ranking is the count ordering it always was
  assert.deepEqual(state.prefixEntries(s).map((e) => e.name), ['Domestique', 'Emails', 'API']);
  assert.deepEqual(state.topPrefixes(s, 2), ['Domestique', 'Emails']);
});

// Every prefix entry is a line of a file a user can hand-edit, so a wrong-shaped one reads as
// nothing rather than reaching a prompt as an object.
test('prefixEntries drops entries whose shape says nothing', () => {
  const state = freshState();
  const s = state.load();
  s.prefixes = { Good: 2, Zero: 0, Nope: 'yes', Null: null, Listy: ['x'], Partial: { count: 3 } };
  assert.deepEqual(state.prefixEntries(s).map((e) => e.name), ['Partial', 'Good']);
});

test('recordTitle does not re-push a title already claimed', () => {
  const state = freshState();
  const s = state.load();
  state.session(s, 'abc').written.push('[Emails] SES bounce fix');
  state.recordTitle(s, 'abc', '[Emails] SES bounce fix', 5);
  assert.deepEqual(s.sessions.abc.written, ['[Emails] SES bounce fix']);
  assert.equal(s.sessions.abc.lastCheckTurns, 5);
  assert.equal(s.prefixes['Emails'].count, 1);
});

test('session() leaves lazily added fields intact across a save/load', () => {
  const state = freshState();
  const s = state.load();
  state.session(s, 'abc').lastTryTurns = 4;
  state.save(s);
  const reloaded = state.load();
  assert.equal(state.session(reloaded, 'abc').lastTryTurns, 4);
});

// doneMarker is off unless it was explicitly turned on, so an absent field and a hand-edited
// non-boolean both read as off - the opposite default to prefix, and the reason it is checked for
// `true` rather than for `!== false`.
test('loadConfig defaults doneMarker to off and round-trips it on', () => {
  const state = freshState();
  const paths = require('../src/paths');
  const fs = require('node:fs');
  assert.equal(state.loadConfig().doneMarker, false);
  state.saveConfig({ ...state.loadConfig(), doneMarker: true });
  assert.equal(state.loadConfig().doneMarker, true);

  fs.mkdirSync(paths.stateDir(), { recursive: true });
  for (const bad of ['on', 1, 'true', null, {}]) {
    fs.writeFileSync(paths.configFile(), JSON.stringify({ prefix: true, doneMarker: bad }));
    assert.equal(state.loadConfig().doneMarker, false, `doneMarker ${JSON.stringify(bad)} should read as off`);
  }
});
