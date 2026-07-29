const { test } = require('node:test');
const assert = require('node:assert');
const fx = require('./fixtures');

function setup() {
  const { configDir, projectDir } = fx.fakeConfig();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  for (const m of ['../src/paths', '../src/state', '../src/worker']) delete require.cache[require.resolve(m)];
  return { worker: require('../src/worker'), state: require('../src/state'), projectDir };
}

const chat = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) { out.push(fx.userEntry(`question ${i} about SES bounces`)); out.push(fx.assistantEntry(`answer ${i}`)); }
  return out;
};

test('titles a fresh session after first exchange', () => {
  const { worker, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', chat(1));
  const res = worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES bounce triage' });
  assert.equal(res.action, 'titled');
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Emails] SES bounce triage');
});

test('no-check-needed inside growth gate; rechecks at 2x growth', () => {
  const { worker, projectDir } = setup();
  let file = fx.writeTranscript(projectDir, 's1', chat(2));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  file = fx.writeTranscript(projectDir, 's1', chat(3));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('should not call'); } }).action, 'no-check-needed');
  file = fx.writeTranscript(projectDir, 's1', chat(6));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => 'KEEP' }).action, 'kept');
});

test('manual title is detected and never overwritten', () => {
  const { worker, projectDir } = setup();
  const entries = [...chat(2), fx.titleEntry('My hand-written name')];
  const file = fx.writeTranscript(projectDir, 's1', entries);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[X] Nope' }).action, 'manual-skip');
  // and it stays manual even at high growth
  const file2 = fx.writeTranscript(projectDir, 's1', [...chat(20), fx.titleEntry('My hand-written name')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file2, runner: () => '[X] Nope' }).action, 'manual-skip');
});

test('a custom-title we wrote ourselves is not treated as manual', () => {
  const { worker, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  const state = require('../src/state');
  assert.equal(state.load().sessions.s1.manual, false);
  // the title we appended is read back as a custom-title on the next run - still not manual
  const file2 = fx.writeTranscript(projectDir, 's1', [...chat(6), fx.titleEntry('[Emails] SES triage')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file2, runner: () => 'KEEP' }).action, 'kept');
  assert.equal(state.load().sessions.s1.manual, false);
});

test('non-vague ai-title is not manual-protected and drift-rechecks', () => {
  const { worker, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.aiTitleEntry('Spending analysis review')]);
  // ai-title present and not vague: no first-title need, baseline established -> no-check-needed (not manual-skip)
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('no call yet'); } }).action, 'no-check-needed');
  const state = require('../src/state');
  assert.equal(state.load().sessions.s1.manual, false);
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2); // drift baseline set without an LLM call
  // at 2x growth the ai-title gets drift-rechecked like any derived title
  const file2 = fx.writeTranscript(projectDir, 's1', [...chat(6), fx.aiTitleEntry('Spending analysis review')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file2, runner: () => 'KEEP' }).action, 'kept');
});

test('vague custom-title (New session) is fair game', () => {
  const { worker, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(1), fx.titleEntry('New session')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
});

test('KEEP on a still-untitled session does not suppress the next attempt', () => {
  const { worker, state, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => 'KEEP' }).action, 'kept');
  assert.equal(state.session(state.load(), 's1').lastCheckTurns, 0);
  // next Stop event on the same still-vague session tries again
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2);
});

test('empty session and dry-run', () => {
  const { worker, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [fx.toolResultEntry()]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => 'x' }).action, 'no-turns');
  const file2 = fx.writeTranscript(projectDir, 's2', chat(1));
  const res = worker.processSession({ sessionId: 's2', transcriptPath: file2, dryRun: true, runner: () => '[Emails] Would be this' });
  assert.equal(res.action, 'dry-run');
  assert.equal(res.title, '[Emails] Would be this');
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file2)), null);
});

test('runFromArgs never throws on bad input', () => {
  const { worker, projectDir } = setup();
  assert.doesNotThrow(() => worker.runFromArgs([]));
  assert.doesNotThrow(() => worker.runFromArgs(['--session', 's1']));
  assert.doesNotThrow(() => worker.runFromArgs(['--session', 's1', '--transcript', '/no/such/file.jsonl']));
  // a real transcript is processed without throwing (no turns -> no LLM call)
  const file = fx.writeTranscript(projectDir, 's1', [fx.toolResultEntry()]);
  assert.doesNotThrow(() => worker.runFromArgs(['--session', 's1', '--transcript', file, '--model', 'haiku']));
});
