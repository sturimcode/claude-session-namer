const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

test('paths derive from CLAUDE_CONFIG_DIR when set', () => {
  process.env.CLAUDE_CONFIG_DIR = '/tmp/fake-claude';
  delete require.cache[require.resolve('../src/paths')];
  const paths = require('../src/paths');
  assert.equal(paths.claudeDir(), '/tmp/fake-claude');
  assert.equal(paths.projectsDir(), '/tmp/fake-claude/projects');
  assert.equal(paths.stateFile(), '/tmp/fake-claude/claude-session-namer/state.json');
  assert.equal(paths.settingsFile(), '/tmp/fake-claude/settings.json');
  assert.equal(paths.hookScript(), '/tmp/fake-claude/claude-session-namer/hook.sh');
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('paths fall back to ~/.claude', () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete require.cache[require.resolve('../src/paths')];
  const paths = require('../src/paths');
  assert.equal(paths.claudeDir(), path.join(os.homedir(), '.claude'));
});
