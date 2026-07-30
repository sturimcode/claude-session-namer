const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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

// The desktop app's session store is its own directory, unrelated to CLAUDE_CONFIG_DIR - it lives
// under Application Support and moves only for a test.
test('the app store dir honours its override and otherwise sits under Application Support', () => {
  process.env.CLAUDE_SESSION_NAMER_APP_STORE = '/tmp/fake-app-store';
  delete require.cache[require.resolve('../src/paths')];
  assert.equal(require('../src/paths').appStoreDir(), '/tmp/fake-app-store');

  delete process.env.CLAUDE_SESSION_NAMER_APP_STORE;
  delete require.cache[require.resolve('../src/paths')];
  assert.equal(
    require('../src/paths').appStoreDir(),
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
  );
});

// --- which project a transcript belongs to -------------------------------------------------------

// A transcript lives at <projectsDir>/<encoded-cwd>/<id>.jsonl, and that dir name is the only record
// on disk of where the session was run from. It is the answer to the question a prefix asks: a
// session run from the home directory belongs to no project, so any prefix on its title could only
// have been borrowed from somebody else's work.
const paths = () => { delete require.cache[require.resolve('../src/paths')]; return require('../src/paths'); };
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const transcriptIn = (dirName) => path.join('/whatever/projects', dirName, 'abc.jsonl');

test('projectSignal reads the home directory as no project', () => {
  const signal = paths().projectSignal(transcriptIn(enc(os.homedir())));
  assert.equal(signal.inProject, false);
  assert.equal(signal.dir, null);
  assert.equal(signal.hint, null);
});

test('projectSignal reads any other dir as a project and names it in words', () => {
  const p = paths();
  const dir = enc(path.join(os.homedir(), 'projects', 'claude-session-namer'));
  const signal = p.projectSignal(transcriptIn(dir));
  assert.equal(signal.inProject, true);
  assert.equal(signal.dir, dir);
  // The encoding is lossy, so the hint is words for a prompt rather than a path: the first segment
  // below home reads as the enclosing folder and the rest as one name.
  assert.equal(signal.hint, 'projects/claude-session-namer');
  // A dir outside home keeps its whole tail, minus the leading separator.
  assert.equal(p.projectSignal(transcriptIn('-srv-www-app')).hint, 'srv/www-app');
  // and a home the caller supplies is what the tail is measured against
  assert.equal(p.dirHint('-Users-x-projects-farsight', { home: '/Users/x' }), 'projects/farsight');
});

// Our own headless title calls run from the OS temp dir, so Claude Code files their transcripts under
// the encoded tmpdir - the same dir the sweeps already exclude. Nothing about those is a project.
test('projectSignal reads the tmpdir as no project, symlinked or not', () => {
  const p = paths();
  for (const dir of [enc(os.tmpdir()), enc(fs.realpathSync(os.tmpdir()))]) {
    assert.equal(p.projectSignal(transcriptIn(dir)).inProject, false, dir);
  }
});

// Best-effort, like every other read of an undocumented format here: anything unparseable is no
// signal, and no signal reads as no project - a bare title is the safe answer when we cannot tell.
test('projectSignal reads anything unparseable as no project', () => {
  const p = paths();
  for (const bad of [null, undefined, 42, '', 'abc.jsonl', '/a/b/abc.jsonl', '/projects//abc.jsonl']) {
    assert.equal(p.projectSignal(bad).inProject, false, JSON.stringify(bad));
  }
});
