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
  assert.deepEqual(state.loadConfig(), { prefix: true });
  state.saveConfig({ prefix: false });
  assert.deepEqual(state.loadConfig(), { prefix: false });
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
