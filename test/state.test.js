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
  assert.equal(s.prefixes['Emails'], 2);
  assert.deepEqual(state.topPrefixes(s, 1), ['Emails']);
});

test('recordTitle does not re-push a title already claimed', () => {
  const state = freshState();
  const s = state.load();
  state.session(s, 'abc').written.push('[Emails] SES bounce fix');
  state.recordTitle(s, 'abc', '[Emails] SES bounce fix', 5);
  assert.deepEqual(s.sessions.abc.written, ['[Emails] SES bounce fix']);
  assert.equal(s.sessions.abc.lastCheckTurns, 5);
  assert.equal(s.prefixes['Emails'], 1);
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
