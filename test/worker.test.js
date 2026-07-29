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
  const res = worker.processSession({ sessionId: 's1', transcriptPath: file2, runner: () => 'KEEP' });
  assert.equal(res.action, 'kept');
  assert.equal(res.title, 'Spending analysis review'); // the kept result carries the title that was kept
});

test('vague custom-title (New session) is fair game', () => {
  const { worker, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(1), fx.titleEntry('New session')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
});

test('KEEP on a still-untitled session retries once the conversation moves, not before', () => {
  const { worker, state, projectDir } = setup();
  let file = fx.writeTranscript(projectDir, 's1', chat(2));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => 'KEEP' }).action, 'kept');
  // the KEEP is recorded as a try, not as a drift baseline
  assert.equal(state.load().sessions.s1.lastCheckTurns, 0);
  assert.equal(state.load().sessions.s1.lastTryTurns, 2);
  // same turn count, so nothing new to go on - don't spend another call
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('should not call'); } }).action, 'no-check-needed');
  // one more turn of signal and it tries again
  file = fx.writeTranscript(projectDir, 's1', chat(3));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 3);
});

test('a crash while writing the transcript record leaves the title claimed in state', () => {
  const { worker, state, projectDir } = setup();
  const t = require('../src/transcript');
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  const real = t.appendTitleRecord;
  t.appendTitleRecord = () => { throw new Error('disk died'); };
  try {
    assert.throws(() => worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }));
  } finally { t.appendTitleRecord = real; }
  assert.deepEqual(state.load().sessions.s1.written, ['[Emails] SES triage']);
  assert.equal(state.load().sessions.s1.manual, false);
});

test('recovers from a crash between the state claim and the transcript record', () => {
  const { worker, state, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  const s = state.load();
  state.session(s, 's1').written.push('[Emails] SES triage');
  state.save(s);
  // the title never reached the transcript, so the session is still untitled - re-title it
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  assert.equal(state.load().sessions.s1.manual, false);
  // and the repeat claim doesn't grow the written list
  assert.deepEqual(state.load().sessions.s1.written, ['[Emails] SES triage']);
});

test('recovers from a crash between the transcript record and the final save', () => {
  const { worker, state, projectDir } = setup();
  const t = require('../src/transcript');
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  const s = state.load();
  state.session(s, 's1').written.push('[Emails] SES triage');
  state.save(s);
  t.appendTitleRecord(file, 's1', '[Emails] SES triage');
  // the claim is on record, so our own title never reads as a human's
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('should not call'); } }).action, 'no-check-needed');
  assert.equal(state.load().sessions.s1.manual, false);
});

test('a transcript that shrank drops its stale baseline and is titled fresh', () => {
  const { worker, state, projectDir } = setup();
  let file = fx.writeTranscript(projectDir, 's1', chat(10));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 10);
  // the transcript is rewritten shorter and the title record is gone with it
  file = fx.writeTranscript(projectDir, 's1', chat(2));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] Shorter thread' }).action, 'titled');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2);
});

test('a dry run never writes state', () => {
  const { worker, projectDir } = setup();
  const stateFile = require('../src/paths').stateFile();
  const runner = () => '[X] Nope';
  // human-titled session - would otherwise persist manual = true
  const f1 = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('My hand-written name')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: f1, dryRun: true, runner }).action, 'manual-skip');
  // already-titled session inside the gate - would otherwise persist the drift baseline
  const f2 = fx.writeTranscript(projectDir, 's2', [...chat(2), fx.aiTitleEntry('Spending analysis review', 's2')]);
  assert.equal(worker.processSession({ sessionId: 's2', transcriptPath: f2, dryRun: true, runner }).action, 'no-check-needed');
  // untitled session drawing a KEEP - would otherwise persist lastTryTurns
  const f3 = fx.writeTranscript(projectDir, 's3', chat(2));
  assert.equal(worker.processSession({ sessionId: 's3', transcriptPath: f3, dryRun: true, runner: () => 'KEEP' }).action, 'kept');
  // untitled session drawing a title
  const f4 = fx.writeTranscript(projectDir, 's4', chat(1));
  assert.equal(worker.processSession({ sessionId: 's4', transcriptPath: f4, dryRun: true, runner }).action, 'dry-run');
  assert.equal(require('node:fs').existsSync(stateFile), false);
});

test('parseArgs reads flags in any order and tolerates missing values', () => {
  const { worker } = setup();
  assert.deepEqual(
    worker.parseArgs(['--transcript', '/t.jsonl', '--model', 'sonnet', '--session', 'abc']),
    { sessionId: 'abc', transcriptPath: '/t.jsonl', model: 'sonnet' },
  );
  assert.deepEqual(worker.parseArgs([]), { sessionId: undefined, transcriptPath: undefined, model: undefined });
  assert.deepEqual(worker.parseArgs(['--session', 'abc']), { sessionId: 'abc', transcriptPath: undefined, model: undefined });
  // a trailing flag with no value yields undefined rather than throwing
  assert.deepEqual(worker.parseArgs(['--session']), { sessionId: undefined, transcriptPath: undefined, model: undefined });
  assert.deepEqual(worker.parseArgs(['--session', 'abc', '--model']), { sessionId: 'abc', transcriptPath: undefined, model: undefined });
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
