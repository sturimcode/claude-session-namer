const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

// Our own entries are the ones whose command points at the claude-session-namer install dir
// (paths.hookScript() always lives under a 'claude-session-namer' directory). Everything else in
// hooks.Stop belongs to the user or another tool and must survive install and uninstall untouched.
const isOurs = (entry) => JSON.stringify(entry).includes('claude-session-namer');

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Stop hooks take no matcher - they fire on every stop.
function addHook(settings, command) {
  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = (settings.hooks.Stop || []).filter((e) => !isOurs(e));
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: 15 }] });
  return settings;
}

// Containers we may have created are pruned when they end up empty, so an uninstall leaves the
// file byte-identical to what it was before install rather than seeding empty scaffolding.
function removeHook(settings) {
  if (settings.hooks && settings.hooks.Stop) {
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
    throw new Error(`${paths.settingsFile()} is not valid JSON settings. Fix or move it, then re-run - refusing to overwrite it.`);
  }
  return parsed;
}

// Same tmp-then-rename dance as the state file, and for a stronger reason: a crash partway through
// a plain write would leave the user with a truncated settings.json and a broken Claude Code.
// The pid in the tmp name keeps concurrent writers off each other's file.
function writeSettings(s) {
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  const tmp = paths.settingsFile() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, paths.settingsFile());
}

// The hook runs as a shell wrapper rather than a direct node invocation so it survives nvm version
// switches: whatever node is on PATH at hook time wins, and the node that ran the installer is the
// fallback for the case where the hook fires with no PATH node at all.
function wrapperScript(cli) {
  return `#!/bin/sh\n# claude-session-namer Stop hook\nif command -v node >/dev/null 2>&1; then NODE=node; else NODE="${process.execPath}"; fi\nexec "$NODE" "${cli}" hook\n`;
}

function install(argv = []) {
  const cli = path.resolve(__dirname, '..', 'bin', 'cli.js');
  // Read before writing anything - a corrupt settings.json aborts the install untouched.
  const settings = readSettings();
  fs.mkdirSync(paths.stateDir(), { recursive: true });
  if (argv.includes('--no-prefix')) require('./state').saveConfig({ prefix: false });
  fs.writeFileSync(paths.hookScript(), wrapperScript(cli), { mode: 0o755 });
  writeSettings(addHook(settings, paths.hookScript()));
  process.stdout.write(`Installed. Stop hook registered in ${paths.settingsFile()}\nNew sessions will be titled automatically. Run 'claude-session-namer backfill --dry-run' to preview titling your existing sessions.\n`);
}

function uninstall() {
  writeSettings(removeHook(readSettings()));
  try { fs.unlinkSync(paths.hookScript()); } catch { /* already gone */ }
  process.stdout.write('Uninstalled. Existing titles are kept.\n');
}

module.exports = { install, uninstall, addHook, removeHook, readSettings, writeSettings };
