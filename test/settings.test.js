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

function fakeSpawn(result) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  fn.calls = calls;
  return fn;
}

// install probes the claude CLI, so every install here gets a fake spawn - the real one would shell
// out to claude on the machine running the tests.
const probeOk = () => fakeSpawn({ status: 0, stdout: 'pong\n', stderr: '' });

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
  capture(() => settings.install([], { spawn: probeOk() }));
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
  capture(() => settings.install([], { spawn: probeOk() }));

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
  capture(() => settings.install([], { spawn: probeOk() }));
  capture(() => settings.install([], { spawn: probeOk() }));
  const conf = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'));
  assert.equal(conf.hooks.Stop.length, 1);
});

test('install creates settings.json when none exists', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install([], { spawn: probeOk() }));
  const conf = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'));
  assert.equal(conf.hooks.Stop[0].hooks[0].command, paths.hookScript());
});

test('install refuses to overwrite an unparseable settings.json', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  const corrupt = '{ "model": "opus", oops';
  fs.writeFileSync(paths.settingsFile(), corrupt);
  assert.throws(() => capture(() => settings.install([], { spawn: probeOk() })), /not valid JSON/);
  assert.equal(fs.readFileSync(paths.settingsFile(), 'utf8'), corrupt, 'the user\'s file must be left untouched');
});

test('wrapper script falls back to the installing node and is valid sh', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install([], { spawn: probeOk() }));
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
  capture(() => settings.install(['--no-prefix'], { spawn: probeOk() }));
  assert.equal(state.loadConfig().prefix, false);
});

test('install without --no-prefix leaves prefixes on', () => {
  const { settings, state } = fresh();
  capture(() => settings.install([], { spawn: probeOk() }));
  assert.equal(state.loadConfig().prefix, true);
});

test('install and uninstall print confirmations', () => {
  const { settings, paths } = fresh();
  const installed = capture(() => settings.install([], { spawn: probeOk() }));
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
  capture(() => settings.install([], { spawn: probeOk() }));
  assert.equal(modeOf(paths.settingsFile()), 0o600, 'a private settings.json must not be widened');
  capture(() => settings.uninstall());
  assert.equal(modeOf(paths.settingsFile()), 0o600, 'uninstall must not widen it either');
});

test('install preserves a deliberately group-readable settings.json', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.settingsFile(), JSON.stringify({ model: 'opus' }));
  fs.chmodSync(paths.settingsFile(), 0o644);
  capture(() => settings.install([], { spawn: probeOk() }));
  assert.equal(modeOf(paths.settingsFile()), 0o644, 'the existing mode wins, whatever it is');
});

test('a settings.json we create ourselves is private', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install([], { spawn: probeOk() }));
  assert.equal(modeOf(paths.settingsFile()), 0o600);
});

test('a hook path containing spaces is quoted in settings.json', () => {
  const dir = path.join(fx.tmpDir(), 'My Claude Config');
  fs.mkdirSync(dir, { recursive: true });
  const { settings, paths } = fresh(dir);
  assert.match(paths.hookScript(), /\s/, 'this test is only meaningful with a spaced path');

  capture(() => settings.install([], { spawn: probeOk() }));
  const cmd = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8')).hooks.Stop[0].hooks[0].command;
  assert.equal(cmd, `"${paths.hookScript()}"`, 'an unquoted spaced path word-splits under sh');
  // The stored command must be something sh can actually run.
  assert.equal(spawnSync('sh', ['-c', `command -v ${cmd} >/dev/null`]).status, 0);

  capture(() => settings.install([], { spawn: probeOk() }));
  assert.equal(JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8')).hooks.Stop.length, 1, 'quoting must not break idempotency');
  capture(() => settings.uninstall());
  assert.ok(!fs.readFileSync(paths.settingsFile(), 'utf8').includes('claude-session-namer'), 'quoting must not break uninstall');
});

// A path with no whitespace still word-splits or expands if it carries a shell metacharacter -
// $ is the common one (a directory named after a variable, a '$' in a username).
test('a hook path containing a shell metacharacter is quoted and escaped', () => {
  const dir = path.join(fx.tmpDir(), 'we$ird-config');
  fs.mkdirSync(dir, { recursive: true });
  const { settings, paths } = fresh(dir);
  assert.ok(!/\s/.test(paths.hookScript()), 'this test is only meaningful without whitespace');

  capture(() => settings.install([], { spawn: probeOk() }));
  const cmd = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8')).hooks.Stop[0].hooks[0].command;
  assert.equal(cmd, `"${paths.hookScript().split('$').join('\\$')}"`, 'an unescaped $ expands to nothing under sh');
  assert.equal(spawnSync('sh', ['-c', `command -v ${cmd} >/dev/null`]).status, 0);

  capture(() => settings.install([], { spawn: probeOk() }));
  assert.equal(JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8')).hooks.Stop.length, 1, 'escaping must not break idempotency');
  capture(() => settings.uninstall());
  assert.ok(!fs.readFileSync(paths.settingsFile(), 'utf8').includes('claude-session-namer'), 'escaping must not break uninstall');
});

test('install writes through a symlinked settings.json', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  const realFile = path.join(fx.tmpDir(), 'dotfiles-settings.json');
  fs.writeFileSync(realFile, JSON.stringify({ model: 'opus' }));
  fs.symlinkSync(realFile, paths.settingsFile());

  capture(() => settings.install([], { spawn: probeOk() }));
  assert.ok(fs.lstatSync(paths.settingsFile()).isSymbolicLink(), 'the symlink must survive the write');
  const conf = JSON.parse(fs.readFileSync(realFile, 'utf8'));
  assert.equal(conf.model, 'opus');
  assert.ok(JSON.stringify(conf.hooks.Stop).includes('claude-session-namer'), 'the link target must get the content');
  assert.deepEqual(tmpLeftovers(path.dirname(realFile)), []);

  capture(() => settings.uninstall());
  assert.ok(fs.lstatSync(paths.settingsFile()).isSymbolicLink());
  assert.ok(!fs.readFileSync(realFile, 'utf8').includes('claude-session-namer'));
});

// A dotfiles symlink whose target isn't checked out yet resolves to nothing. Writing to the link
// path itself would replace the link with a regular file and cut the user loose from their repo.
test('install writes through a settings.json symlink whose target does not exist yet', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  const realFile = path.join(fx.tmpDir(), 'dotfiles', 'settings.json');
  fs.symlinkSync(realFile, paths.settingsFile());

  capture(() => settings.install([], { spawn: probeOk() }));
  assert.ok(fs.lstatSync(paths.settingsFile()).isSymbolicLink(), 'a dangling link must not be replaced by a regular file');
  const conf = JSON.parse(fs.readFileSync(realFile, 'utf8'));
  assert.ok(JSON.stringify(conf.hooks.Stop).includes('claude-session-namer'), 'the link target must get the content');
  assert.deepEqual(tmpLeftovers(path.dirname(realFile)), []);
});

test('a relative dangling symlink resolves against the link\'s own directory', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.symlinkSync(path.join('dotfiles', 'settings.json'), paths.settingsFile());

  capture(() => settings.install([], { spawn: probeOk() }));
  const target = path.join(paths.claudeDir(), 'dotfiles', 'settings.json');
  assert.ok(fs.existsSync(target), 'a relative target resolves against the link dir, not the cwd');
  assert.ok(fs.lstatSync(paths.settingsFile()).isSymbolicLink());
});

// The command string is what identifies our entry. Matching the whole stringified entry meant a
// user's unrelated Stop hook that merely mentioned the tool anywhere got deleted on install.
test('a foreign Stop entry that names the tool outside its command survives', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  const foreign = { name: 'runs alongside claude-session-namer', hooks: [{ type: 'command', command: 'other-tool' }] };
  fs.writeFileSync(paths.settingsFile(), JSON.stringify({ hooks: { Stop: [structuredClone(foreign)] } }));

  capture(() => settings.install([], { spawn: probeOk() }));
  const after = JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'));
  assert.equal(after.hooks.Stop.length, 2);
  assert.deepEqual(after.hooks.Stop[0], foreign, 'only the command decides whose entry it is');

  capture(() => settings.uninstall());
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8')), { hooks: { Stop: [foreign] } });
});

test('an entry left by an older install, at another path, is still replaced', () => {
  const { settings } = fresh();
  const old = { hooks: [{ type: 'command', command: '"/opt/old/claude-session-namer/hook.sh"', timeout: 15 }] };
  const s = settings.addHook({ hooks: { Stop: [old] } }, '/new/claude-session-namer/hook.sh');
  assert.equal(s.hooks.Stop.length, 1, 'a reinstall from a new path must not leave the old entry behind');
  assert.equal(s.hooks.Stop[0].hooks[0].command, '/new/claude-session-namer/hook.sh');
});

test('a shape error names the offending type with the right article', () => {
  const { settings } = fresh();
  const cmd = '/x/claude-session-namer/hook.sh';
  assert.throws(() => settings.addHook({ hooks: { Stop: {} } }, cmd), /is an object/);
  assert.throws(() => settings.addHook({ hooks: [] }, cmd), /is an array/);
  assert.throws(() => settings.addHook({ hooks: 'oops' }, cmd), /is a string/);
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
    () => capture(() => settings.install([], { spawn: probeOk() })),
    (e) => e.expected === true && /refusing to edit/i.test(e.message),
    'a hooks block we cannot read must abort the install loudly',
  );
  assert.equal(fs.readFileSync(paths.settingsFile(), 'utf8'), raw, 'the user\'s file must be left untouched');
  assert.ok(!fs.existsSync(paths.hookScript()), 'no wrapper may be left behind by a refused install');
});

test('reinstall restores the wrapper exec bit', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install([], { spawn: probeOk() }));
  fs.chmodSync(paths.hookScript(), 0o644);
  capture(() => settings.install([], { spawn: probeOk() }));
  assert.equal(modeOf(paths.hookScript()), 0o755, 'a non-executable wrapper 126s at every Stop');
});

test('wrapper exits quietly when no node exists at hook time', () => {
  const { settings, paths } = fresh();
  capture(() => settings.install([], { spawn: probeOk() }));
  const wrapper = fs.readFileSync(paths.hookScript(), 'utf8');
  // Simulate a machine with no node at all: the pinned fallback is gone and PATH has none.
  const noNode = path.join(fx.tmpDir(), 'deleted-node');
  const script = path.join(fx.tmpDir(), 'wrapper-no-node.sh');
  fs.writeFileSync(script, wrapper.split(process.execPath).join(noNode), { mode: 0o755 });
  const res = spawnSync('/bin/sh', [script], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
  assert.equal(res.status, 0, 'a missing node must not fail the Stop hook');
  assert.equal(res.stderr, '', 'and must not print anything at every Stop');
});

// An nvm upgrade relocates global node_modules and the installed package moves out from under the
// wrapper. Without a guard the hook prints MODULE_NOT_FOUND and exits 1 at every single Stop.
test('wrapper exits quietly when the cli it points at is gone', () => {
  const { settings } = fresh();
  const gone = path.join(fx.tmpDir(), 'moved-away', 'cli.js');
  const script = path.join(fx.tmpDir(), 'wrapper-no-cli.sh');
  fs.writeFileSync(script, settings.wrapperScript(gone), { mode: 0o755 });
  execFileSync('sh', ['-n', script]);
  const res = spawnSync('/bin/sh', [script], { encoding: 'utf8' });
  assert.equal(res.status, 0, 'a moved package must not fail the Stop hook');
  assert.equal(res.stderr, '', 'and must not print at every Stop');
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
  const err = captureErr(() => capture(() => settings.install(['--no-prefx', 'backfill'], { spawn: probeOk() })));
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
  capture(() => settings.install(['--no-prefix'], { spawn: probeOk() }));
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

// process.exit() can truncate a message still buffered on a piped stderr, so the cli sets the exit
// code and lets the process end on its own.
test('an unknown command prints the whole help text and exits 1', () => {
  const cli = path.resolve(__dirname, '..', 'bin', 'cli.js');
  const res = spawnSync(process.execPath, [cli, 'nope'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: fx.tmpDir() },
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown command: nope/);
  assert.match(res.stderr, /config {6}Show or change settings/, 'the help text must survive whole on a pipe');
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

// The hook is silent on every failure path by design, so an unauthenticated or missing claude CLI
// makes titling a no-op the user never hears about. install is the one moment that can say so.
const spawnError = (code) => { const e = new Error(code); e.code = code; return e; };
const hookRegistered = (paths) =>
  JSON.stringify(JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8'))).includes('claude-session-namer');

// Captures both streams around one call so a test can assert on what install said where.
function captureBoth(fn) {
  let err = '';
  const out = capture(() => { err = captureErr(fn); });
  return { out, err };
}

test('a working claude probe adds nothing to the install output', () => {
  const { settings, paths } = fresh();
  const spawn = probeOk();
  const { out, err } = captureBoth(() => settings.install([], { spawn }));
  assert.equal(spawn.calls.length, 1, 'install must probe the claude CLI');
  assert.equal(err, '', 'a working CLI is the normal case and says nothing');
  assert.match(out, /^Installed\./);
  assert.ok(!/[Ww]arning/.test(out), 'the success output must stay as it was');
  assert.ok(hookRegistered(paths));
});

test('a claude probe that exits non-zero warns but still leaves a working install', () => {
  const { settings, paths } = fresh();
  const prevExit = process.exitCode;
  const spawn = fakeSpawn({ status: 1, stdout: '', stderr: '' });
  const { out, err } = captureBoth(() => settings.install([], { spawn }));
  assert.match(out, /^Installed\./, 'the install itself succeeded and still says so');
  assert.match(err, /Warning/);
  assert.match(err, /claude/);
  assert.match(err, /silently/, 'the point of the warning is that the hook stays quiet');
  assert.match(err, /claude \/login/, 'the usual fix belongs in the message');
  assert.equal(process.exitCode, prevExit, 'a failed probe must not fail the install');
  assert.ok(hookRegistered(paths), 'the hook is registered whatever the probe says');
  assert.ok(fs.existsSync(paths.hookScript()));
});

test('a claude CLI that is not on PATH warns in its own words', () => {
  const { settings, paths } = fresh();
  const prevExit = process.exitCode;
  const spawn = fakeSpawn({ error: spawnError('ENOENT'), status: null, stdout: '', stderr: '' });
  const { err } = captureBoth(() => settings.install([], { spawn }));
  assert.match(err, /Warning/);
  assert.match(err, /not found|not on PATH/, 'a missing CLI is a different problem from a failing one');
  assert.match(err, /install the claude CLI/i);
  assert.equal(process.exitCode, prevExit);
  assert.ok(hookRegistered(paths));
});

test('a claude probe that times out warns rather than hanging the install', () => {
  const { settings, paths } = fresh();
  const prevExit = process.exitCode;
  // What spawnSync returns when its timeout fires: the child is killed and the error carries the code.
  const spawn = fakeSpawn({ error: spawnError('ETIMEDOUT'), status: null, signal: 'SIGTERM', stdout: '', stderr: '' });
  const { err } = captureBoth(() => settings.install([], { spawn }));
  assert.match(err, /Warning/);
  assert.match(err, /30 seconds|did not answer|timed out/);
  assert.equal(process.exitCode, prevExit);
  assert.ok(hookRegistered(paths));
});

test('the probe warning carries the claude CLI\'s own stderr line', () => {
  const { settings } = fresh();
  const spawn = fakeSpawn({ status: 1, stdout: 'partial answer\n', stderr: '\nInvalid API key: 401 authentication_error\n  more detail\n' });
  const { err } = captureBoth(() => settings.install([], { spawn }));
  assert.match(err, /Invalid API key: 401 authentication_error/, 'a 401 is the thing the user needs to see');
  assert.ok(!err.includes('more detail'), 'one line only - the rest is noise in an install summary');
  assert.ok(!err.includes('partial answer'), 'stderr is the better diagnosis when the CLI wrote one');
});

// Observed live: an unauthenticated CLI exits 1 with the reason on stdout and nothing on stderr.
// Reading stderr alone left the most common real failure showing a bare exit code.
test('the probe warning falls back to the claude CLI\'s stdout line', () => {
  const { settings } = fresh();
  const spawn = fakeSpawn({ status: 1, stdout: 'Not logged in · Please run /login\n', stderr: '' });
  const { err } = captureBoth(() => settings.install([], { spawn }));
  assert.match(err, /Not logged in · Please run \/login/, 'the CLI said why - pass it on');
  assert.match(err, /claude exited 1/);
});

test('a probe detail line is capped however long the CLI\'s output is', () => {
  const { settings } = fresh();
  const spawn = fakeSpawn({ status: 1, stdout: 'x'.repeat(5000), stderr: '' });
  const { err } = captureBoth(() => settings.install([], { spawn }));
  assert.ok(err.length < 700, `an install summary is not a log dump: ${err.length} chars`);
});

test('the probe runs claude headless with the recursion guard and a timeout', () => {
  const { settings } = fresh();
  const spawn = probeOk();
  captureBoth(() => settings.install([], { spawn }));
  const { cmd, args, opts } = spawn.calls[0];
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, ['-p', 'ping', '--model', 'haiku']);
  // Headless runs fire Stop hooks too, so without the guard the hook we just installed would spawn a
  // worker for the probe's own session.
  assert.equal(opts.env.CLAUDE_SESSION_NAMER_WORKER, '1');
  assert.equal(opts.env.PATH, process.env.PATH, 'the probe must inherit the rest of the environment');
  assert.equal(opts.timeout, 30000, 'install must never hang on a wedged CLI');
  assert.equal(opts.encoding, 'utf8');
});

test('an install that aborts never reaches the probe', () => {
  const { settings, paths } = fresh();
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.settingsFile(), JSON.stringify({ hooks: [] }));
  const spawn = probeOk();
  assert.throws(() => captureBoth(() => settings.install([], { spawn })), /refusing to edit/i);
  assert.equal(spawn.calls.length, 0, 'nothing was installed, so there is nothing to probe');

  const prevExit = process.exitCode;
  const rejected = probeOk();
  captureBoth(() => settings.install(['--nope'], { spawn: rejected }));
  assert.equal(rejected.calls.length, 0, 'a rejected flag is not an install either');
  process.exitCode = prevExit;
});
