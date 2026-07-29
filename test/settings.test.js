const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fx = require('./fixtures');

function fresh() {
  process.env.CLAUDE_CONFIG_DIR = fx.tmpDir();
  for (const m of ['../src/paths', '../src/settings', '../src/state']) delete require.cache[require.resolve(m)];
  return { settings: require('../src/settings'), paths: require('../src/paths'), state: require('../src/state') };
}

// install/uninstall print confirmations; swallow them so the test reporter stays readable.
function capture(fn) {
  const orig = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return out;
}

const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

test('addHook/removeHook round-trip preserves unrelated settings', () => {
  const { settings } = fresh();
  const original = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
  const withOurs = settings.addHook(structuredClone(original), '/x/claude-session-namer/hook.sh');
  assert.equal(withOurs.hooks.Stop.length, 2);
  assert.equal(withOurs.model, 'opus');
  const removed = settings.removeHook(withOurs);
  assert.deepEqual(removed, original);
});

test('addHook is idempotent', () => {
  const { settings } = fresh();
  let s = settings.addHook({}, '/x/claude-session-namer/hook.sh');
  s = settings.addHook(s, '/x/claude-session-namer/hook.sh');
  assert.equal(s.hooks.Stop.length, 1);
});

test('our Stop entry carries no matcher and a timeout', () => {
  const { settings } = fresh();
  const s = settings.addHook({}, '/x/claude-session-namer/hook.sh');
  const entry = s.hooks.Stop[0];
  assert.equal('matcher' in entry, false, 'Stop hooks take no matcher');
  assert.deepEqual(entry.hooks, [{ type: 'command', command: '/x/claude-session-namer/hook.sh', timeout: 15 }]);
});

test('removeHook drops empty containers but keeps foreign hooks', () => {
  const { settings } = fresh();
  const onlyOurs = settings.removeHook(settings.addHook({}, '/x/claude-session-namer/hook.sh'));
  assert.deepEqual(onlyOurs, {}, 'a hooks object we alone created must not be left behind');

  const shared = settings.removeHook(settings.addHook({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } }, '/x/claude-session-namer/hook.sh'));
  assert.deepEqual(shared, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } });
});

test('removeHook tolerates settings with no hooks at all', () => {
  const { settings } = fresh();
  assert.deepEqual(settings.removeHook({ model: 'opus' }), { model: 'opus' });
  assert.deepEqual(settings.removeHook({ model: 'opus', hooks: { PreToolUse: [] } }), { model: 'opus', hooks: { PreToolUse: [] } });
});

test('install writes wrapper, registers hook, uninstall reverses', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.settingsFile(), JSON.stringify({ model: 'opus' }));
  capture(() => settings.install());
  assert.ok(fs.existsSync(paths.hookScript()));
  assert.ok((fs.statSync(paths.hookScript()).mode & 0o111) !== 0);
  const conf = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'));
  assert.equal(conf.model, 'opus');
  assert.ok(JSON.stringify(conf.hooks.Stop).includes('claude-session-namer'));
  capture(() => settings.uninstall());
  const conf2 = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'));
  assert.ok(!JSON.stringify(conf2).includes('claude-session-namer'));
  assert.ok(!fs.existsSync(paths.hookScript()));
});

test('install writes settings.json atomically and leaves no tmp files', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.settingsFile(), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }));
  capture(() => settings.install());

  const raw = fs.readFileSync(paths.settingsFile(), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'settings.json must always be parseable');
  assert.deepEqual(JSON.parse(raw).permissions, { allow: ['Bash(ls:*)'] });
  assert.deepEqual(tmpLeftovers(paths.claudeDir()), [], 'no tmp file may survive the write');

  capture(() => settings.uninstall());
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8')));
  assert.deepEqual(tmpLeftovers(paths.claudeDir()), []);
});

test('install is idempotent across repeated runs', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install());
  capture(() => settings.install());
  const conf = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'));
  assert.equal(conf.hooks.Stop.length, 1);
});

test('install creates settings.json when none exists', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install());
  const conf = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'));
  assert.equal(conf.hooks.Stop[0].hooks[0].command, paths.hookScript());
});

test('install refuses to overwrite an unparseable settings.json', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  const corrupt = '{ "model": "opus", oops';
  fs.writeFileSync(paths.settingsFile(), corrupt);
  assert.throws(() => capture(() => settings.install()), /not valid JSON/);
  assert.equal(fs.readFileSync(paths.settingsFile(), 'utf8'), corrupt, 'the user\'s file must be left untouched');
});

test('wrapper script falls back to the installing node and is valid sh', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install());
  const wrapper = fs.readFileSync(paths.hookScript(), 'utf8');
  assert.ok(wrapper.startsWith('#!/bin/sh\n'));
  assert.match(wrapper, /command -v node/);
  assert.ok(wrapper.includes(process.execPath), 'must pin the install-time node as the fallback');
  const cli = path.resolve(__dirname, '..', 'bin', 'cli.js');
  assert.ok(fs.existsSync(cli));
  assert.ok(wrapper.includes(`"${cli}" hook`), 'must invoke the cli hook command');
  execFileSync('sh', ['-n', paths.hookScript()]);
});

test('install --no-prefix persists the prefix opt-out', () => {
  const { settings, state } = fresh();
  capture(() => settings.install(['--no-prefix']));
  assert.equal(state.loadConfig().prefix, false);
});

test('install without --no-prefix leaves prefixes on', () => {
  const { settings, state } = fresh();
  capture(() => settings.install());
  assert.equal(state.loadConfig().prefix, true);
});

test('install and uninstall print confirmations', () => {
  const { settings, paths } = fresh();
  const installed = capture(() => settings.install());
  assert.ok(installed.includes(paths.settingsFile()));
  assert.match(installed, /backfill/);
  assert.match(capture(() => settings.uninstall()), /Uninstalled/);
});

test('uninstall tolerates a missing wrapper script', () => {
  const { settings } = fresh();
  assert.doesNotThrow(() => capture(() => settings.uninstall()));
});
