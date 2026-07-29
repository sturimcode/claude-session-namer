const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const fx = require('./fixtures');

function fresh(dir) {
  process.env.CLAUDE_CONFIG_DIR = dir || fx.tmpDir();
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

function captureErr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return out;
}

const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
const modeOf = (p) => fs.statSync(p).mode & 0o777;

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

test('install preserves the permissions of an existing settings.json', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.settingsFile(), JSON.stringify({ model: 'opus' }));
  fs.chmodSync(paths.settingsFile(), 0o600);
  capture(() => settings.install());
  assert.equal(modeOf(paths.settingsFile()), 0o600, 'a private settings.json must not be widened');
  capture(() => settings.uninstall());
  assert.equal(modeOf(paths.settingsFile()), 0o600, 'uninstall must not widen it either');
});

test('install preserves a deliberately group-readable settings.json', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.settingsFile(), JSON.stringify({ model: 'opus' }));
  fs.chmodSync(paths.settingsFile(), 0o644);
  capture(() => settings.install());
  assert.equal(modeOf(paths.settingsFile()), 0o644, 'the existing mode wins, whatever it is');
});

test('a settings.json we create ourselves is private', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install());
  assert.equal(modeOf(paths.settingsFile()), 0o600);
});

test('a hook path containing spaces is quoted in settings.json', () => {
  const dir = path.join(fx.tmpDir(), 'My Claude Config');
  fs.mkdirSync(dir, { recursive: true });
  const { settings, paths } = fresh(dir);
  assert.match(paths.hookScript(), /\s/, 'this test is only meaningful with a spaced path');

  capture(() => settings.install());
  const cmd = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8')).hooks.Stop[0].hooks[0].command;
  assert.equal(cmd, `"${paths.hookScript()}"`, 'an unquoted spaced path word-splits under sh');
  // The stored command must be something sh can actually run.
  assert.equal(spawnSync('sh', ['-c', `command -v ${cmd} >/dev/null`]).status, 0);

  capture(() => settings.install());
  assert.equal(JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8')).hooks.Stop.length, 1, 'quoting must not break idempotency');
  capture(() => settings.uninstall());
  assert.ok(!fs.readFileSync(paths.settingsFile(), 'utf8').includes('claude-session-namer'), 'quoting must not break uninstall');
});

test('install writes through a symlinked settings.json', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  const realFile = path.join(fx.tmpDir(), 'dotfiles-settings.json');
  fs.writeFileSync(realFile, JSON.stringify({ model: 'opus' }));
  fs.symlinkSync(realFile, paths.settingsFile());

  capture(() => settings.install());
  assert.ok(fs.lstatSync(paths.settingsFile()).isSymbolicLink(), 'the symlink must survive the write');
  const conf = JSON.parse(fs.readFileSync(realFile, 'utf8'));
  assert.equal(conf.model, 'opus');
  assert.ok(JSON.stringify(conf.hooks.Stop).includes('claude-session-namer'), 'the link target must get the content');
  assert.deepEqual(tmpLeftovers(path.dirname(realFile)), []);

  capture(() => settings.uninstall());
  assert.ok(fs.lstatSync(paths.settingsFile()).isSymbolicLink());
  assert.ok(!fs.readFileSync(realFile, 'utf8').includes('claude-session-namer'));
});

test('addHook refuses to edit a malformed hooks block', () => {
  const { settings } = fresh();
  const cmd = '/x/claude-session-namer/hook.sh';
  for (const bad of [{ hooks: [] }, { hooks: 'oops' }, { hooks: { Stop: {} } }, { hooks: { Stop: 'oops' } }]) {
    assert.throws(
      () => settings.addHook(structuredClone(bad), cmd),
      /refusing to edit/i,
      `${JSON.stringify(bad)} must be refused, not silently edited or crashed on`,
    );
  }
});

test('removeHook refuses to edit a malformed hooks block', () => {
  const { settings } = fresh();
  for (const bad of [{ hooks: [] }, { hooks: 'oops' }, { hooks: { Stop: {} } }, { hooks: { Stop: 'oops' } }]) {
    assert.throws(() => settings.removeHook(structuredClone(bad)), /refusing to edit/i, JSON.stringify(bad));
  }
});

test('install aborts on a malformed hooks block and changes nothing', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  const raw = JSON.stringify({ model: 'opus', hooks: [] });
  fs.writeFileSync(paths.settingsFile(), raw);
  assert.throws(
    () => capture(() => settings.install()),
    (e) => e.expected === true && /refusing to edit/i.test(e.message),
    'a hooks block we cannot read must abort the install loudly',
  );
  assert.equal(fs.readFileSync(paths.settingsFile(), 'utf8'), raw, 'the user\'s file must be left untouched');
  assert.ok(!fs.existsSync(paths.hookScript()), 'no wrapper may be left behind by a refused install');
});

test('reinstall restores the wrapper exec bit', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install());
  fs.chmodSync(paths.hookScript(), 0o644);
  capture(() => settings.install());
  assert.equal(modeOf(paths.hookScript()), 0o755, 'a non-executable wrapper 126s at every Stop');
});

test('wrapper exits quietly when no node exists at hook time', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install());
  const wrapper = fs.readFileSync(paths.hookScript(), 'utf8');
  // Simulate a machine with no node at all: the pinned fallback is gone and PATH has none.
  const noNode = path.join(fx.tmpDir(), 'deleted-node');
  const script = path.join(fx.tmpDir(), 'wrapper-no-node.sh');
  fs.writeFileSync(script, wrapper.split(process.execPath).join(noNode), { mode: 0o755 });
  const res = spawnSync('/bin/sh', [script], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
  assert.equal(res.status, 0, 'a missing node must not fail the Stop hook');
  assert.equal(res.stderr, '', 'and must not print anything at every Stop');
});

test('wrapper survives shell metacharacters in the paths it embeds', () => {
  const { settings } = fresh();
  const dir = path.join(fx.tmpDir(), 'we$ird `back` "quoted" \\slashed dir');
  fs.mkdirSync(dir, { recursive: true });
  const cli = path.join(dir, 'echo-argv.js');
  fs.writeFileSync(cli, 'process.stdout.write(process.argv[1] + "|" + process.argv[2]);');
  const script = path.join(fx.tmpDir(), 'wrapper-meta.sh');
  fs.writeFileSync(script, settings.wrapperScript(cli), { mode: 0o755 });
  execFileSync('sh', ['-n', script]);
  assert.equal(execFileSync('sh', [script], { encoding: 'utf8' }), `${cli}|hook`);
});

test('install rejects unknown flags and changes nothing', () => {
  const { settings, paths } = fresh();
  const prevExit = process.exitCode;
  const err = captureErr(() => capture(() => settings.install(['--no-prefx', 'backfill'])));
  assert.match(err, /--no-prefx/);
  assert.match(err, /Usage/);
  assert.equal(process.exitCode, 1);
  process.exitCode = prevExit;
  assert.ok(!fs.existsSync(paths.settingsFile()), 'a rejected install must not touch settings.json');
  assert.ok(!fs.existsSync(paths.hookScript()), 'a rejected install must not write the wrapper');
});

test('uninstall on a never-installed setup creates no settings.json', () => {
  const { settings, paths } = fresh();
  capture(() => settings.uninstall());
  assert.ok(!fs.existsSync(paths.settingsFile()), 'nothing to remove means nothing to write');
});

test('install --no-prefix leaves unrelated config keys alone', () => {
  const { settings, paths, state } = fresh();
  fs.mkdirSync(paths.stateDir(), { recursive: true });
  fs.writeFileSync(paths.configFile(), JSON.stringify({ model: 'haiku' }));
  capture(() => settings.install(['--no-prefix']));
  assert.deepEqual(state.loadConfig(), { model: 'haiku', prefix: false });
});

test('the cli prints expected errors without a stack trace', () => {
  const dir = fx.tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ "model": "opus", oops');
  const cli = path.resolve(__dirname, '..', 'bin', 'cli.js');
  const res = spawnSync(process.execPath, [cli, 'install'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not valid JSON/);
  assert.ok(!/\n\s+at /.test(res.stderr), `expected errors must not dump a stack: ${res.stderr}`);
});

test('the cli still prints a stack for unexpected errors', () => {
  const dir = fx.tmpDir();
  // settings.json as a directory is not a case we model - the rename fails with a raw fs error.
  fs.mkdirSync(path.join(dir, 'settings.json'));
  const cli = path.resolve(__dirname, '..', 'bin', 'cli.js');
  const res = spawnSync(process.execPath, [cli, 'install'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.ok(/\n\s+at /.test(res.stderr), `unexpected errors must keep their stack: ${res.stderr}`);
});
