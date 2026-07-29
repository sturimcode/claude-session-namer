const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const paths = require('./paths');

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Our own entries are the ones whose command points at the claude-session-namer install dir
// (paths.hookScript() always lives under a 'claude-session-namer' directory). Only the command is
// read, quoted or not, so an entry that installs a different tool and merely mentions this one in a
// name or a comment stays put. Everything else in hooks.Stop belongs to the user or another tool
// and must survive install and uninstall untouched.
const isOurs = (entry) =>
  isPlainObject(entry) &&
  Array.isArray(entry.hooks) &&
  entry.hooks.some((h) => isPlainObject(h) && typeof h.command === 'string' && h.command.includes('claude-session-namer'));

// Errors the user is meant to read and act on, as opposed to bugs. The cli prints these as a plain
// message; everything else keeps its stack.
function expected(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

const describe = (v) => {
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
};

// hooks and hooks.Stop have exactly one legal shape each. Anything else - an array where an object
// belongs, a string, an object where the Stop list belongs - is either someone else's format or a
// hand-edit gone wrong. Editing it blind would either silently no-op (the user believes titling is
// on and it never fires) or throw a raw TypeError, so we stop and say why.
function assertHooksShape(settings) {
  const { hooks } = settings;
  if (hooks === undefined || hooks === null) return;
  if (!isPlainObject(hooks)) {
    throw expected(`${paths.settingsFile()}: "hooks" should be an object but is ${describe(hooks)}. Fix or move it, then re-run - refusing to edit it.`);
  }
  if (hooks.Stop !== undefined && hooks.Stop !== null && !Array.isArray(hooks.Stop)) {
    throw expected(`${paths.settingsFile()}: "hooks.Stop" should be an array but is ${describe(hooks.Stop)}. Fix or move it, then re-run - refusing to edit it.`);
  }
}

// Stop hooks take no matcher - they fire on every stop.
function addHook(settings, command) {
  assertHooksShape(settings);
  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = (settings.hooks.Stop || []).filter((e) => !isOurs(e));
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: 15 }] });
  return settings;
}

// Containers we may have created are pruned when they end up empty, so an uninstall leaves the
// file byte-identical to what it was before install rather than seeding empty scaffolding.
function removeHook(settings) {
  assertHooksShape(settings);
  if (settings.hooks && Array.isArray(settings.hooks.Stop)) {
    settings.hooks.Stop = settings.hooks.Stop.filter((e) => !isOurs(e));
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  return settings;
}

// A missing or empty settings.json is normal - we start from {}. A file that exists but does not
// parse is not: writing over it would silently destroy the user's entire Claude Code config, so we
// refuse and let the error surface.
function readSettings() {
  let raw;
  try { raw = fs.readFileSync(paths.settingsFile(), 'utf8'); } catch { return {}; }
  if (raw.trim() === '') return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (!isPlainObject(parsed)) {
    throw expected(`${paths.settingsFile()} is not valid JSON settings. Fix or move it, then re-run - refusing to overwrite it.`);
  }
  return parsed;
}

// Settings often live in a dotfiles repo behind a symlink. Writing tmp-then-rename against the link
// itself would replace it with a regular file and quietly cut the user's settings loose from their
// dotfiles, so the whole dance runs against the resolved path. realpathSync also fails on a link
// whose target doesn't exist yet - a dotfiles repo not checked out, a file the user hasn't created -
// and falling back to the link path there is the exact severing case, so the intended target is
// read off the link instead and created. A relative target resolves against the link's own
// directory, the way the kernel resolves it, not against the process cwd.
function resolvedSettingsFile() {
  const link = paths.settingsFile();
  try { return fs.realpathSync(link); } catch { /* missing file, or a link pointing at one */ }
  try {
    const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return target;
  } catch { return link; } // not a symlink at all - the file simply isn't there yet
}

// Same tmp-then-rename dance as the state file, and for a stronger reason: a crash partway through
// a plain write would leave the user with a truncated settings.json and a broken Claude Code.
// The pid in the tmp name keeps concurrent writers off each other's file. settings.json holds API
// keys and is commonly 0600 - rename swaps the tmp file's mode in wholesale, so the tmp file is
// created and chmod'ed to the target's own mode (writeFileSync's mode applies on create only, and
// an existing tmp file from a crashed run would otherwise keep its old mode).
function writeSettings(s) {
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  const target = resolvedSettingsFile();
  let mode = 0o600; // a file we create ourselves stays private
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* not there yet - keep the private default */ }
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

// Paths land inside double quotes in the wrapper, where sh still expands $ and ` and honours \.
const shEscape = (s) => s.replace(/(["$`\\])/g, '\\$1');

// A path with a space in it word-splits under sh and the hook 127s at every Stop; a path carrying
// $, a backtick, a quote or a backslash is worse, because sh expands it into something else
// entirely. Anything outside a plain path alphabet is quoted and escaped. Unquoted otherwise - the
// plain path is what most users expect to see in their settings.json, and the command match that
// identifies our entry works either way.
const NEEDS_QUOTING = /[^A-Za-z0-9_/.-]/;
const hookCommand = (script) => (NEEDS_QUOTING.test(script) ? `"${shEscape(script)}"` : script);

// The hook runs as a shell wrapper rather than a direct node invocation so it survives nvm version
// switches: whatever node is on PATH at hook time wins, and the node that ran the installer is the
// fallback for the case where the hook fires with no PATH node at all. If neither exists - the
// install-time node was uninstalled - we exit 0 rather than let sh report 127 after every single
// turn; titling is a nicety and must never be noise in the user's session. The cli itself gets the
// same treatment: an nvm upgrade relocates global node_modules and the package moves out from under
// the embedded path, which would otherwise print MODULE_NOT_FOUND and exit 1 at every Stop.
function wrapperScript(cli) {
  return [
    '#!/bin/sh',
    '# claude-session-namer Stop hook',
    `if command -v node >/dev/null 2>&1; then NODE=node; else NODE="${shEscape(process.execPath)}"; fi`,
    'command -v "$NODE" >/dev/null 2>&1 || exit 0',
    `[ -e "${shEscape(cli)}" ] || exit 0`,
    `exec "$NODE" "${shEscape(cli)}" hook`,
    '',
  ].join('\n');
}

const INSTALL_USAGE = 'Usage: claude-session-namer install [--no-prefix]\n';

// Long enough that a cold CLI start and one haiku round-trip fit, short enough that a wedged or
// network-stalled CLI can't leave the user staring at a hung install.
const PROBE_TIMEOUT_MS = 30_000;

const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean);

// Titles only ever come from `claude -p`, and the hook is silent on every failure path by design, so
// a CLI that isn't authenticated (or isn't installed) makes titling a no-op nobody hears about.
// install is the one moment we can say so, and it says it without failing: the hook is registered
// either way, so a probe that fails for a reason of its own never costs the user the install.
function probe(spawn = spawnSync) {
  let res;
  try {
    res = spawn('claude', ['-p', 'ping', '--model', 'haiku'], {
      encoding: 'utf8',
      // Same reason the titler uses it: a headless run files a transcript under the cwd's project
      // dir, and the sweep already excludes the tmpdir one, so the probe leaves no session behind
      // that a later backfill would try to title.
      cwd: os.tmpdir(),
      timeout: PROBE_TIMEOUT_MS,
      // Headless `claude -p` runs fire Stop hooks too, so without the guard the hook this very
      // install just registered would spawn a worker for the probe's own session.
      env: { ...process.env, CLAUDE_SESSION_NAMER_WORKER: '1' },
    }) || {};
  } catch (err) {
    res = { error: err }; // spawnSync throws rather than returns on some platform-level failures
  }
  if (!res.error && res.status === 0) return null;

  const code = res.error && res.error.code;
  // An unauthenticated CLI reports the reason on stdout ("Not logged in · Please run /login") and
  // leaves stderr empty, so stderr alone left the most common failure showing a bare exit code.
  // stderr still wins when it has anything: an API error or a crash lands there and diagnoses better
  // than whatever partial answer stdout got to.
  const detail = firstLine(res.stderr) || firstLine(res.stdout);
  if (code === 'ENOENT') {
    return probeWarning('the claude CLI was not found on PATH', '', 'install the claude CLI, then run \'claude /login\' if you are not signed in yet.');
  }
  if (code === 'ETIMEDOUT' || res.signal) {
    return probeWarning(`the claude CLI did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds`, detail, 'run the check below by hand; if it asks you to sign in, run \'claude /login\'.');
  }
  const why = res.error ? res.error.message : `claude exited ${res.status}`;
  return probeWarning('the claude CLI could not generate a title just now', detail ? `${why}: ${detail}` : why, 'run \'claude /login\'.');
}

function probeWarning(reason, detail, fix) {
  return [
    `Warning: the Stop hook is registered, but ${reason}.`,
    ...(detail ? [`  ${detail.slice(0, 200)}`] : []),
    'Titling will silently do nothing until that works - the hook exits quietly on every failure, so it will not tell you again.',
    `Fix: ${fix}`,
    'Then check it with: claude -p ping --model haiku',
    '',
  ].join('\n');
}

// testOpts carries the spawn seam only, the way backfill takes a runner - nothing else may set it.
function install(argv = [], testOpts = {}) {
  // A typo'd flag must not read as a plain install - the user would think --no-prefix took effect.
  const unknown = argv.filter((a) => a !== '--no-prefix');
  if (unknown.length) {
    process.stderr.write(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n${INSTALL_USAGE}`);
    process.exitCode = 1;
    return;
  }
  const cli = path.resolve(__dirname, '..', 'bin', 'cli.js');
  // Read and edit before writing anything - a corrupt or unrecognizable settings.json aborts the
  // install with nothing on disk changed, not with a half-installed wrapper left behind.
  const settings = addHook(readSettings(), hookCommand(paths.hookScript()));
  fs.mkdirSync(paths.stateDir(), { recursive: true });
  if (argv.includes('--no-prefix')) {
    const state = require('./state');
    state.saveConfig({ ...state.loadConfig(), prefix: false });
  }
  fs.writeFileSync(paths.hookScript(), wrapperScript(cli), { mode: 0o755 });
  fs.chmodSync(paths.hookScript(), 0o755); // a reinstall over an existing file ignores the mode above
  writeSettings(settings);
  process.stdout.write(`Installed. Stop hook registered in ${paths.settingsFile()}\nNew sessions will be titled automatically. Run 'claude-session-namer backfill --dry-run' to preview titling your existing sessions (recent ones only - last 30 days, 50 max; add --all for full history).\n`);

  // Last, and after the success message: the install is done and stands on its own, this only makes
  // an already-broken titling path visible.
  const warning = probe(testOpts.spawn);
  if (warning) process.stderr.write(warning);
}

function uninstall() {
  // No settings file means nothing to remove - writing one would seed a stray {} we never needed.
  if (fs.existsSync(paths.settingsFile())) writeSettings(removeHook(readSettings()));
  try { fs.unlinkSync(paths.hookScript()); } catch { /* already gone */ }
  process.stdout.write('Uninstalled. Existing titles are kept.\n');
}

module.exports = { install, uninstall, addHook, removeHook, readSettings, writeSettings, wrapperScript };
