const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// These manifests are data, not code - nothing in src reads them, and Claude Code only sees them
// after a user installs the plugin. So the only failure mode they have is drifting out of sync with
// the package they wrap: a version bump that misses one file, or bin/cli.js moving while the hook
// command still points at the old path. Every assertion here is that kind of guard.
const root = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const pkg = readJson('package.json');

test('the plugin manifest carries the required fields and the package version', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'claude-session-namer'); // the namespace users see - kebab-case, no spaces
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.description, pkg.description);
  assert.equal(plugin.license, pkg.license);
  assert.ok(plugin.author && plugin.author.name);
});

test('the marketplace lists this repo as its own plugin source, in version sync', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(typeof market.name, 'string');
  assert.ok(market.owner && market.owner.name);
  assert.ok(Array.isArray(market.plugins));

  const entry = market.plugins.find((p) => p.name === 'claude-session-namer');
  assert.ok(entry, 'the marketplace must list the plugin');
  // './' means the marketplace root is the plugin root - the repo is its own marketplace, which is
  // what lets a single `marketplace add` reach the whole package including bin/ and src/.
  assert.equal(entry.source, './');
  assert.equal(entry.version, pkg.version);
});

test('the Stop hook runs the real cli entry through the plugin root', () => {
  const hooks = readJson('hooks/hooks.json').hooks;
  assert.ok(Array.isArray(hooks.Stop));
  assert.equal(hooks.Stop.length, 1); // one worker per Stop event, same as the settings.json entry
  const entry = hooks.Stop[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.ok(entry.command.includes('${CLAUDE_PLUGIN_ROOT}'), 'the command must resolve through the plugin root');
  assert.ok(/\bhook\b\s*$/.test(entry.command), 'the command must end in the hook subcommand');

  // The point of the test: the command names a file that has to exist. Move bin/cli.js without
  // updating hooks.json and every plugin install silently stops titling.
  const referenced = entry.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/);
  assert.ok(referenced, 'the command must reference a path under the plugin root');
  assert.ok(fs.existsSync(path.join(root, referenced[1])), `${referenced[1]} does not exist`);
});

test('the plugin hook timeout matches the one the npm install registers', () => {
  const pluginTimeout = readJson('hooks/hooks.json').hooks.Stop[0].hooks[0].timeout;
  // Read it off the installer rather than restating 15 here: the two install paths have to agree,
  // and a change to either one should fail this test rather than quietly diverge.
  const registered = require('../src/settings').addHook({}, '/some/hook.sh');
  assert.equal(pluginTimeout, registered.hooks.Stop[0].hooks[0].timeout);
});

test('the cli is on PATH for plugin installs under its own name', () => {
  const wrapper = path.join(root, 'bin', 'claude-session-namer');
  assert.ok(fs.existsSync(wrapper), 'bin/claude-session-namer makes the commands runnable without npm');
  assert.ok(fs.statSync(wrapper).mode & 0o111, 'the wrapper must be executable to be usable on PATH');
  assert.ok(fs.readFileSync(wrapper, 'utf8').includes('cli.js'));
});

test('nothing the plugin adds reaches the npm tarball', () => {
  // "files" is a whitelist, and it names bin/cli.js rather than bin/ so that the PATH wrapper - which
  // exists only for plugin installs, where npm's own bin mapping is not there to do the job - stays
  // out of the package too. npm users pay nothing at all for the plugin wrapper.
  assert.deepEqual(pkg.files, ['bin/cli.js', 'src', 'LICENSE']);
});
