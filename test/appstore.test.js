const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./fixtures');

function withStore(dir) {
  process.env.CLAUDE_SESSION_NAMER_APP_STORE = dir;
  for (const m of ['../src/paths', '../src/appstore']) delete require.cache[require.resolve(m)];
  return require('../src/appstore');
}

test('titleSourceFor reports a session the user renamed in the app', () => {
  const store = fx.fakeAppStore({ 'sess-user': 'user', 'sess-auto': 'auto' });
  const appstore = withStore(store);
  assert.equal(appstore.titleSourceFor('sess-user'), 'user');
});

test('titleSourceFor reports an app-generated title as auto', () => {
  const store = fx.fakeAppStore({ 'sess-user': 'user', 'sess-auto': 'auto' });
  const appstore = withStore(store);
  assert.equal(appstore.titleSourceFor('sess-auto'), 'auto');
});

// Older app builds wrote the session file without a titleSource field. Absent means the app named
// it - a rename has always been recorded explicitly - so those read as 'auto', not as unknown.
test('a matching file with no titleSource field reads as auto', () => {
  const appstore = withStore(fx.fakeAppStore({ 'sess-old': null }));
  assert.equal(appstore.titleSourceFor('sess-old'), 'auto');
});

test('titleSourceFor is null for a session the app has never seen', () => {
  const appstore = withStore(fx.fakeAppStore({ 'sess-user': 'user' }));
  assert.equal(appstore.titleSourceFor('sess-nobody-knows'), null);
});

// The store is a macOS desktop-app path. On Linux, on Windows, or on a machine that has only ever
// run the CLI, it isn't there - that reads as "no signal", never as an error.
test('a missing store reads as null rather than throwing', () => {
  const appstore = withStore(path.join(fx.tmpDir(), 'no-such-store'));
  assert.doesNotThrow(() => appstore.titleSourceFor('sess-user'));
  assert.equal(appstore.titleSourceFor('sess-user'), null);
});

test('an empty store reads as null', () => {
  const appstore = withStore(fx.fakeAppStore({}));
  assert.equal(appstore.titleSourceFor('sess-user'), null);
});

// One half-written or truncated file must not hide every session behind it.
test('unparseable and unrelated files are skipped, not fatal', () => {
  const store = fx.fakeAppStore({ 'sess-user': 'user' });
  const junkDir = path.join(store, 'outer-junk', 'inner-junk');
  fs.mkdirSync(junkDir, { recursive: true });
  fs.writeFileSync(path.join(junkDir, 'local_broken.json'), '{ not json');
  fs.writeFileSync(path.join(junkDir, 'notes.txt'), 'not a session file');
  fs.writeFileSync(path.join(store, 'stray.json'), '{}');
  const appstore = withStore(store);
  assert.equal(appstore.titleSourceFor('sess-user'), 'user');
  assert.equal(appstore.titleSourceFor('sess-missing'), null);
});

// A file that isn't nested two levels deep isn't the app's, and a file whose JSON isn't an object
// has no cliSessionId to match on - neither should be read as a session record.
test('files at the wrong depth and non-object JSON are ignored', () => {
  const store = fx.fakeAppStore({});
  fs.writeFileSync(path.join(store, 'local_toplevel.json'), JSON.stringify({ cliSessionId: 'sess-shallow', titleSource: 'user' }));
  const oneDeep = path.join(store, 'outer-only');
  fs.mkdirSync(oneDeep, { recursive: true });
  fs.writeFileSync(path.join(oneDeep, 'local_shallow.json'), JSON.stringify({ cliSessionId: 'sess-shallow', titleSource: 'user' }));
  const deep = path.join(store, 'outer-a', 'inner-a');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'local_array.json'), JSON.stringify(['not', 'a', 'record']));
  const appstore = withStore(store);
  assert.equal(appstore.titleSourceFor('sess-shallow'), null);
});

// `list` asks about every session it prints. One walk of the store per row costs seconds on a real
// store, so the whole answer comes out of a single pass.
test('userRenamedIds collects every user-renamed session in one pass', () => {
  const appstore = withStore(fx.fakeAppStore({ 'sess-a': 'user', 'sess-b': 'auto', 'sess-c': 'user', 'sess-d': null }));
  assert.deepEqual([...appstore.userRenamedIds()].sort(), ['sess-a', 'sess-c']);
});

test('userRenamedIds is empty for an absent store and for a store with no renames', () => {
  assert.equal(withStore(path.join(fx.tmpDir(), 'no-such-store')).userRenamedIds().size, 0);
  assert.equal(withStore(fx.fakeAppStore({ 'sess-a': 'auto' })).userRenamedIds().size, 0);
});

// An id given to us is not a path component. A store lookup must never walk out of the store.
test('a session id that looks like a path does not escape the store', () => {
  const appstore = withStore(fx.fakeAppStore({ 'sess-user': 'user' }));
  assert.equal(appstore.titleSourceFor('../../etc/passwd'), null);
  assert.equal(appstore.titleSourceFor(''), null);
  assert.equal(appstore.titleSourceFor(undefined), null);
});
