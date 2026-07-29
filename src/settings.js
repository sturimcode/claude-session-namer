const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

// Our own entries are the ones whose command points at the claude-session-namer install dir
// (paths.hookScript() always lives under a 'claude-session-namer' directory). Everything else in
// hooks.Stop belongs to the user or another tool and must survive install and uninstall untouched.
const isOurs = (entry) => JSON.stringify(entry).includes('claude-session-namer');

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Errors the user is meant to read and act on, as opposed to bugs. The cli prints these as a plain
// message; everything else keeps its stack.
function expected(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

const describe = (v) => (Array.isArray(v) ? 'an array' : `a ${typeof v}`);

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
// dotfiles, so the whole dance runs against the resolved path.
function resolvedSettingsFile() {
  try { return fs.realpathSync(paths.settingsFile()); } catch { return paths.settingsFile(); }
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

// A path with a space in it word-splits under sh and the hook 127s at every Stop, so the stored
// command quotes it. Unquoted otherwise - the plain path is what most users expect to see in their
// settings.json, and the substring match that identifies our entry works either way.
const hookCommand = (script) => (/\s/.test(script) ? `"${script}"` : script);

// The hook runs as a shell wrapper rather than a direct node invocation so it survives nvm version
// switches: whatever node is on PATH at hook time wins, and the node that ran the installer is the
// fallback for the case where the hook fires with no PATH node at all. If neither exists - the
// install-time node was uninstalled - we exit 0 rather than let sh report 127 after every single
// turn; titling is a nicety and must never be noise in the user's session.
function wrapperScript(cli) {
  return [
    '#!/bin/sh',
    '# claude-session-namer Stop hook',
    `if command -v node >/dev/null 2>&1; then NODE=node; else NODE="${shEscape(process.execPath)}"; fi`,
    'command -v "$NODE" >/dev/null 2>&1 || exit 0',
    `exec "$NODE" "${shEscape(cli)}" hook`,
    '',
  ].join('\n');
}

const INSTALL_USAGE = 'Usage: claude-session-namer install [--no-prefix]\n';

function install(argv = []) {
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
  process.stdout.write(`Installed. Stop hook registered in ${paths.settingsFile()}\nNew sessions will be titled automatically. Run 'claude-session-namer backfill --dry-run' to preview titling your existing sessions.\n`);
}

function uninstall() {
  // No settings file means nothing to remove - writing one would seed a stray {} we never needed.
  if (fs.existsSync(paths.settingsFile())) writeSettings(removeHook(readSettings()));
  try { fs.unlinkSync(paths.hookScript()); } catch { /* already gone */ }
  process.stdout.write('Uninstalled. Existing titles are kept.\n');
}

module.exports = { install, uninstall, addHook, removeHook, readSettings, writeSettings, wrapperScript };
