const { test } = require('node:test');
const assert = require('node:assert');
const fx = require('./fixtures');

// appStore maps cliSessionId -> 'user' | 'auto' | null (null writes the record with no titleSource
// field). Every setup gets a store of its own, empty by default, so a worker test never reads the
// real desktop app store on the machine running the suite.
function setup(appStore = {}) {
  const { configDir, projectDir } = fx.fakeConfig();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.CLAUDE_SESSION_NAMER_APP_STORE = fx.fakeAppStore(appStore);
  for (const m of ['../src/paths', '../src/state', '../src/appstore', '../src/worker']) delete require.cache[require.resolve(m)];
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

// Protection is an explicit act now - the `manual` flag in state, set by `rename` or `protect`.
// Nothing about a title record itself can turn it on.
test('a session marked manual in state is never overwritten', () => {
  const { worker, state, projectDir } = setup();
  const entries = [...chat(2), fx.titleEntry('My hand-written name')];
  const file = fx.writeTranscript(projectDir, 's1', entries);
  const s = state.load();
  state.session(s, 's1').manual = true;
  state.save(s);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[X] Nope' }).action, 'manual-skip');
  // and it stays manual even at high growth
  const file2 = fx.writeTranscript(projectDir, 's1', [...chat(20), fx.titleEntry('My hand-written name')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file2, runner: () => '[X] Nope' }).action, 'manual-skip');
});

// The transcript can't tell a hand rename from the app's own auto-title, but the app's session
// store can: it records titleSource 'user' for a title typed in the app UI. That marker is the
// only reliable signal a human named the session, and it protects the title outright.
test('a session renamed in the desktop app is left alone', () => {
  const { worker, state, projectDir } = setup({ s1: 'user' });
  const file = fx.writeTranscript(projectDir, 's1', [...chat(4), fx.titleEntry('Revisit Monday')]);
  const res = worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('must not call the model'); } });
  assert.equal(res.action, 'app-renamed-skip');
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), 'Revisit Monday');
  // The app is consulted live on every run, so nothing is recorded - the day the marker changes,
  // behavior follows it rather than a stale copy in our own state.
  assert.equal(require('node:fs').existsSync(require('../src/paths').stateFile()), false);
  assert.equal(state.load().sessions.s1, undefined);
});

// An untitled session whose store record says 'user' is still the user's - the protection is about
// who owns the name, not about whether a title record has reached the transcript yet.
test('the app-rename marker holds on an untitled session and at high growth', () => {
  const { worker, projectDir } = setup({ s1: 'user' });
  const bare = fx.writeTranscript(projectDir, 's1', chat(1));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: bare, runner: () => '[X] Nope' }).action, 'app-renamed-skip');
  const grown = fx.writeTranscript(projectDir, 's1', [...chat(20), fx.titleEntry('Revisit Monday')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: grown, runner: () => '[X] Nope' }).action, 'app-renamed-skip');
});

// Almost every session in the store is titleSource 'auto' - the app naming its own sessions.
// Skipping those would be skipping the entire job.
test('an app auto-titled session is titled and drift-tracked as usual', () => {
  const { worker, projectDir } = setup({ s1: 'auto' });
  const file = fx.writeTranscript(projectDir, 's1', chat(1));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES bounce triage' }).action, 'titled');
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Emails] SES bounce triage');
});

test('a session the app store has never heard of is titled as usual', () => {
  const { worker, projectDir } = setup({ 'some-other-session': 'user' });
  const file = fx.writeTranscript(projectDir, 's1', chat(1));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES bounce triage' }).action, 'titled');
});

// Protection set in our own state is checked first and reported as its own action - a session can
// be both, and 'manual-skip' is the one the user asked for by name.
test('an explicitly protected session still reports manual-skip, app marker or not', () => {
  const { worker, state, projectDir } = setup({ s1: 'user' });
  const file = fx.writeTranscript(projectDir, 's1', chat(4));
  const s = state.load();
  state.session(s, 's1').manual = true;
  state.save(s);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[X] Nope' }).action, 'manual-skip');
});

// The desktop app writes its own auto-titles as custom-title records, re-asserting the same string
// every few turns, so a foreign custom-title says nothing about who wrote it. Treating one as a
// human rename manual-locked nearly every session on first sight and killed drift re-titling.
test('a foreign custom-title is drift-tracked, not manual-locked', () => {
  const { worker, state, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('[Spending] Analysis review')]);
  // present, not vague, and already in the configured format: no first-title need, drift baseline
  // set without an LLM call
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('no call yet'); } }).action, 'no-check-needed');
  assert.equal(state.load().sessions.s1.manual, false);
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2);
  // at 2x growth it gets re-checked like any other title, and a drifted session is re-titled
  const file2 = fx.writeTranscript(projectDir, 's1', [...chat(6), fx.titleEntry('[Spending] Analysis review')]);
  const res = worker.processSession({ sessionId: 's1', transcriptPath: file2, runner: () => '[Emails] SES bounce triage' });
  assert.equal(res.action, 'titled');
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file2)), '[Emails] SES bounce triage');
});

test('our own title, read back as a custom-title, still drift-rechecks', () => {
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
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.aiTitleEntry('[Spending] Analysis review')]);
  // ai-title present and not vague: no first-title need, baseline established -> no-check-needed (not manual-skip)
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('no call yet'); } }).action, 'no-check-needed');
  const state = require('../src/state');
  assert.equal(state.load().sessions.s1.manual, false);
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2); // drift baseline set without an LLM call
  // at 2x growth the ai-title gets drift-rechecked like any derived title
  const file2 = fx.writeTranscript(projectDir, 's1', [...chat(6), fx.aiTitleEntry('[Spending] Analysis review')]);
  const res = worker.processSession({ sessionId: 's1', transcriptPath: file2, runner: () => 'KEEP' });
  assert.equal(res.action, 'kept');
  assert.equal(res.title, '[Spending] Analysis review'); // the kept result carries the title that was kept
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

test('a vague session past its drift baseline retries on growth, not on every event', () => {
  const { worker, state, projectDir } = setup();
  let file = fx.writeTranscript(projectDir, 's1', chat(2));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2);
  // the title record is gone but the baseline remains, so the session reads vague with lastCheckTurns > 0
  file = fx.writeTranscript(projectDir, 's1', chat(8));
  let calls = 0;
  const keep = () => { calls++; return 'KEEP'; };
  const first = worker.processSession({ sessionId: 's1', transcriptPath: file, runner: keep });
  assert.equal(first.action, 'kept');
  assert.equal(first.title, null); // nothing usable was kept - don't report a vague title as the kept one
  assert.equal(calls, 1);
  // repeated events at the same turn count have nothing new to go on - no more calls
  for (let i = 0; i < 3; i++) worker.processSession({ sessionId: 's1', transcriptPath: file, runner: keep });
  assert.equal(calls, 1);
  assert.equal(state.load().sessions.s1.lastTryTurns, 8);
  // one more turn of signal and it tries again
  file = fx.writeTranscript(projectDir, 's1', chat(9));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: keep }).action, 'kept');
  assert.equal(calls, 2);
});

test('a compacted transcript drops the stale retry marker too', () => {
  const { worker, state, projectDir } = setup();
  let file = fx.writeTranscript(projectDir, 's1', chat(8));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => 'KEEP' }).action, 'kept');
  assert.equal(state.load().sessions.s1.lastTryTurns, 8);
  // compaction rewrites the transcript shorter - the retry marker measured a transcript that no longer exists
  file = fx.writeTranscript(projectDir, 's1', chat(2));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2);
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
  // the claim is on record and survived the crash, so the title still reads as ours on the next
  // run - the session picks up its drift baseline and carries on rather than starting over
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
  // already-titled by a custom-title record - would otherwise persist the drift baseline
  const f1 = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('[Notes] My hand-written name')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: f1, dryRun: true, runner }).action, 'no-check-needed');
  // already-titled session inside the gate - would otherwise persist the drift baseline
  const f2 = fx.writeTranscript(projectDir, 's2', [...chat(2), fx.aiTitleEntry('[Spending] Analysis review', 's2')]);
  assert.equal(worker.processSession({ sessionId: 's2', transcriptPath: f2, dryRun: true, runner }).action, 'no-check-needed');
  // untitled session drawing a KEEP - would otherwise persist lastTryTurns
  const f3 = fx.writeTranscript(projectDir, 's3', chat(2));
  assert.equal(worker.processSession({ sessionId: 's3', transcriptPath: f3, dryRun: true, runner: () => 'KEEP' }).action, 'kept');
  // untitled session drawing a title
  const f4 = fx.writeTranscript(projectDir, 's4', chat(1));
  assert.equal(worker.processSession({ sessionId: 's4', transcriptPath: f4, dryRun: true, runner }).action, 'dry-run');
  assert.equal(require('node:fs').existsSync(stateFile), false);
});

// `claude -p` blocks for up to 90 seconds. Another worker that finishes inside that window saves
// state of its own, and a stale in-memory copy written afterwards erases it - including a `written`
// claim. Lose that claim and our own title stops reading as ours: the app re-asserting it mid-
// generate looks like a title someone else just set, and the re-title is abandoned for nothing.
test('a concurrent state write during generation is not lost', () => {
  const { worker, state, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  const runner = () => {
    const other = state.load();
    state.session(other, 's2').written.push('[Other] Concurrent work');
    state.recordTitle(other, 's2', '[Other] Concurrent work', 4);
    state.save(other);
    return '[Emails] SES triage';
  };
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner }).action, 'titled');
  const after = state.load();
  assert.deepEqual(after.sessions.s1.written, ['[Emails] SES triage']);
  assert.equal(after.sessions.s1.lastCheckTurns, 2);
  assert.deepEqual(after.sessions.s2.written, ['[Other] Concurrent work']);
  assert.equal(after.sessions.s2.lastCheckTurns, 4);
  assert.deepEqual(after.prefixes, { Emails: 1, Other: 1 });
});

test('a concurrent state write during a generation that ends in KEEP is not lost', () => {
  const { worker, state, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  const runner = () => {
    const other = state.load();
    state.session(other, 's2').manual = true;
    state.save(other);
    return 'KEEP';
  };
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner }).action, 'kept');
  const after = state.load();
  assert.equal(after.sessions.s1.lastTryTurns, 2);
  assert.equal(after.sessions.s2.manual, true);
});

// A rename that lands inside the 90-second generate window used to lose: our title was appended
// after theirs and won as the last record, and the manual flag their rename set then blocked every
// later correction - so the title we clobbered theirs with stuck for good.
test('a rename that lands mid-generate is not clobbered by the title we asked for', () => {
  const { worker, state, projectDir } = setup();
  const t = require('../src/transcript');
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  const runner = () => {
    // the user renames the session while `claude -p` is still blocked
    t.appendTitleRecord(file, 's1', 'My hand-written name');
    const other = state.load();
    state.recordTitle(other, 's1', 'My hand-written name', 2);
    state.session(other, 's1').manual = true;
    state.save(other);
    return '[Emails] SES triage';
  };
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner }).action, 'manual-skip');
  assert.equal(t.currentTitle(t.readEntries(file)), 'My hand-written name');
  assert.equal(t.readEntries(file).filter((e) => e.type === 'custom-title').length, 1);
  assert.equal(state.load().sessions.s1.manual, true);
});

// A rename typed in the desktop app writes no state at all - the only mark it leaves is the
// titleSource in the app's own store. So the fresh-state re-check above cannot see it, and without
// a second look at the marker our title lands on top of the name the user just typed, then the skip
// on the next run freezes it there for good.
test('an app rename that lands mid-generate is not clobbered by the title we asked for', () => {
  const { worker, state, projectDir } = setup();
  const t = require('../src/transcript');
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  const runner = () => {
    // the user types a name in the app UI while `claude -p` is still blocked
    fx.appStoreRecord(process.env.CLAUDE_SESSION_NAMER_APP_STORE, 's1', { titleSource: 'user', title: 'Revisit Monday' });
    return '[Emails] SES triage';
  };
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner }).action, 'app-renamed-skip');
  // nothing appended over their name, and nothing recorded - the marker is read live every run
  assert.equal(t.readEntries(file).filter((e) => e.type === 'custom-title').length, 0);
  assert.equal(require('node:fs').existsSync(require('../src/paths').stateFile()), false);
  assert.equal(state.load().sessions.s1, undefined);
});

// A title that appeared while we were generating wins - ours would be appended after it and take
// over a name the user may have just typed. It does not make the session manual: the appearing
// title is just as likely the app re-asserting its own auto-title, so the next Stop event
// re-evaluates it through the normal flow.
test('a title appearing mid-generate is left alone without locking the session', () => {
  const { worker, state, projectDir } = setup();
  const t = require('../src/transcript');
  const file = fx.writeTranscript(projectDir, 's1', chat(2));
  const runner = () => {
    t.appendTitleRecord(file, 's1', '[Notes] Renamed in the app');
    return '[Emails] SES triage';
  };
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner }).action, 'title-changed');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Notes] Renamed in the app');
  assert.equal(t.readEntries(file).filter((e) => e.type === 'custom-title').length, 1);
  // nothing is recorded at all - no lock, and no claim on a title we never wrote
  assert.equal(state.load().sessions.s1, undefined);
  // the next event treats it as any other title: baseline set, no LLM call, still not manual
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('no call'); } }).action, 'no-check-needed');
  assert.equal(state.load().sessions.s1.manual, false);
});

// The re-check must not fire on the title that was already there when we started - a session whose
// name is the app's vague default still reads as a custom-title record on the second read.
test('the mid-generate re-check ignores the vague title the session started with', () => {
  const { worker, state, projectDir } = setup();
  const t = require('../src/transcript');
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('New session')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Emails] SES triage');
  assert.equal(state.load().sessions.s1.manual, false);
});

// The app re-asserts a title it already has by writing it again as a `custom-title` record, so the
// same string can change record type under us mid-generate. An identical string is never a new
// arrival, whatever record carries it - only a genuinely different title is.
test('an ai-title re-asserted as an identical custom-title mid-generate is not a new arrival', () => {
  const { worker, projectDir } = setup();
  const t = require('../src/transcript');
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.aiTitleEntry('[Spending] Analysis review')]);
  // baseline set from the ai-title, no LLM call
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('no call yet'); } }).action, 'no-check-needed');
  const file2 = fx.writeTranscript(projectDir, 's1', [...chat(6), fx.aiTitleEntry('[Spending] Analysis review')]);
  const runner = () => {
    // the app re-asserts the same title it already showed, this time as a custom-title record
    t.appendTitleRecord(file2, 's1', '[Spending] Analysis review');
    return '[Emails] SES bounce triage';
  };
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file2, runner }).action, 'titled');
  assert.equal(t.currentTitle(t.readEntries(file2)), '[Emails] SES bounce triage');
});

// The kept title is what the session is left with. A title that reads vague is not one, even when
// a string is present - reporting 'New session' as the kept title would misread as a real name.
test('a KEEP on a vague-but-present title reports no title', () => {
  const { worker, state, projectDir } = setup();
  let file = fx.writeTranscript(projectDir, 's1', chat(2));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2);
  // the session's name is back to the app's vague default, but the drift baseline stands
  file = fx.writeTranscript(projectDir, 's1', [...chat(8), fx.titleEntry('New session')]);
  assert.deepEqual(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => 'KEEP' }), { action: 'kept', title: null });
});

// The prefix setting is a format contract: if the user asked for prefixes, every title the tool
// manages carries one. An accurate title in the wrong format is reformatted with its meaning intact
// rather than re-derived from scratch.
test('prefix on: an accurate title with no prefix is restyled rather than left alone', () => {
  const { worker, state, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('SES bounce triage')]);
  let prompt = '';
  const res = worker.processSession({
    sessionId: 's1',
    transcriptPath: file,
    runner: (p) => { prompt = p; return '[Emails] SES bounce triage'; },
  });
  assert.equal(res.action, 'restyled');
  assert.equal(res.title, '[Emails] SES bounce triage');
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Emails] SES bounce triage');
  // the reformat prompt, not the drift prompt
  assert.ok(prompt.includes('rewrite it into the required format, preserving its meaning'));
  assert.ok(!prompt.includes('If the current title still accurately describes'));
  // written the same crash-safe way a first title is: claimed in state, baseline set, prefix counted
  const after = state.load();
  assert.deepEqual(after.sessions.s1.written, ['[Emails] SES bounce triage']);
  assert.equal(after.sessions.s1.lastCheckTurns, 2);
  assert.equal(after.sessions.s1.manual, false);
  assert.deepEqual(after.prefixes, { Emails: 1 });
});

test('a title already in the configured format costs no model call', () => {
  const { worker, state, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('[Emails] SES bounce triage')]);
  const res = worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => { throw new Error('should not call'); } });
  assert.equal(res.action, 'no-check-needed');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2);
});

// The contract runs both ways - with prefixes off, a prefixed title is the non-conforming one.
test('prefix off: a prefixed title is restyled down to a bare phrase', () => {
  const { worker, state, projectDir } = setup();
  state.saveConfig({ prefix: false });
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('[Emails] SES bounce triage')]);
  let prompt = '';
  const res = worker.processSession({
    sessionId: 's1',
    transcriptPath: file,
    runner: (p) => { prompt = p; return 'SES bounce triage'; },
  });
  assert.equal(res.action, 'restyled');
  assert.equal(res.title, 'SES bounce triage');
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), 'SES bounce triage');
  assert.ok(prompt.includes('- Drop the prefix and keep the phrase as it is'));
  // stripping a prefix is mechanical, so the prompt spends nothing on the conversation
  assert.ok(!prompt.includes('Conversation excerpt'));
  assert.ok(!prompt.includes('question 0 about SES bounces'));
  // and a bare title under the same setting is the conforming one
  const file2 = fx.writeTranscript(projectDir, 's2', [...chat(2), fx.titleEntry('SES bounce triage', 's2')]);
  assert.equal(
    worker.processSession({ sessionId: 's2', transcriptPath: file2, runner: () => { throw new Error('should not call'); } }).action,
    'no-check-needed',
  );
});

// Both hard protections - the manual flag and the app's 'user' marker - sit upstream of the format
// check, so a wrong-format title on a session the user owns stays exactly as they left it. The
// KEEP-biased personal-label rule is not one of them: it lives in the drift prompt, which restyle
// mode strips, so an unmarked personal label gets reformatted rather than spared.
test('a wrong-format title on a protected or app-renamed session is left as it is', () => {
  const { worker, state, projectDir } = setup({ s2: 'user' });
  const t = require('../src/transcript');
  const mustNotCall = () => { throw new Error('must not call the model'); };

  const f1 = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('Revisit Monday')]);
  const s = state.load();
  state.session(s, 's1').manual = true;
  state.save(s);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: f1, runner: mustNotCall }).action, 'manual-skip');
  assert.equal(t.currentTitle(t.readEntries(f1)), 'Revisit Monday');

  const f2 = fx.writeTranscript(projectDir, 's2', [...chat(2), fx.titleEntry('Revisit Monday', 's2')]);
  assert.equal(worker.processSession({ sessionId: 's2', transcriptPath: f2, runner: mustNotCall }).action, 'app-renamed-skip');
  assert.equal(t.currentTitle(t.readEntries(f2)), 'Revisit Monday');
});

// The other half of that: a personal label carrying neither marker is not spared. The KEEP rule that
// would have spared it is a drift-prompt rule, and restyle mode strips every KEEP rule - so the
// label is reshaped into the format with its meaning intact. `protect` is what holds one as typed.
test('an unmarked personal label in the wrong format is reformatted, not spared', () => {
  const { worker, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('Revisit Monday')]);
  let prompt = '';
  const res = worker.processSession({
    sessionId: 's1',
    transcriptPath: file,
    runner: (p) => { prompt = p; return '[Emails] Revisit Monday'; },
  });
  assert.equal(res.action, 'restyled');
  assert.equal(res.title, '[Emails] Revisit Monday');
  assert.ok(!prompt.includes('deliberate personal label'));
});

// KEEP is forbidden in restyle mode, but the parser still returns it defensively when a model
// disobeys. Recording the baseline is what stops that from re-asking on every Stop event.
test('a restyle the model answers KEEP to keeps the title and waits for growth', () => {
  const { worker, state, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('SES bounce triage')]);
  let calls = 0;
  const keep = () => { calls++; return 'KEEP'; };
  assert.deepEqual(
    worker.processSession({ sessionId: 's1', transcriptPath: file, runner: keep }),
    { action: 'kept', title: 'SES bounce triage' },
  );
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2);
  // repeated events at the same turn count don't re-ask
  for (let i = 0; i < 3; i++) worker.processSession({ sessionId: 's1', transcriptPath: file, runner: keep });
  assert.equal(calls, 1);
  // the growth cadence owns the next look, and a model that obeys converges the title
  const grown = fx.writeTranscript(projectDir, 's1', [...chat(4), fx.titleEntry('SES bounce triage')]);
  const res = worker.processSession({ sessionId: 's1', transcriptPath: grown, runner: () => '[Emails] SES bounce triage' });
  assert.equal(res.action, 'restyled');
  assert.equal(require('../src/transcript').currentTitle(require('../src/transcript').readEntries(grown)), '[Emails] SES bounce triage');
});

// A drift check can answer KEEP, and a KEEP on a non-conforming title would leave the format wrong
// for good. So once a title is out of format, the reformat is the check that runs - the next drift
// check, one growth step later, is where its meaning gets re-derived.
test('a wrong-format title is restyled even when a drift check is due', () => {
  const { worker, state, projectDir } = setup();
  let file = fx.writeTranscript(projectDir, 's1', chat(10));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner: () => '[Emails] SES triage' }).action, 'titled');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 10);
  // the session's name is a bare phrase now - the app's own, or ours from before prefixes were on
  file = fx.writeTranscript(projectDir, 's1', [...chat(20), fx.titleEntry('SES bounce triage')]);
  let prompt = '';
  const res = worker.processSession({
    sessionId: 's1',
    transcriptPath: file,
    runner: (p) => { prompt = p; return '[Emails] SES bounce triage'; },
  });
  assert.equal(res.action, 'restyled');
  assert.ok(prompt.includes('rewrite it into the required format, preserving its meaning'));
  assert.ok(!prompt.includes('If the current title still accurately describes'));
  assert.equal(state.load().sessions.s1.lastCheckTurns, 20);
});

// A session nobody is adding turns to any more never grows, so its baseline gates the reformat out
// for good and a sweep over history could never converge it - the one thing flipping the setting
// promises. `backfill` passes force to open that gate, and only that gate.
test('force opens the reformat gate on a baselined session and nothing else', () => {
  const { worker, state, projectDir } = setup();
  const t = require('../src/transcript');
  const mustNotCall = () => { throw new Error('must not call the model'); };

  // a conforming title with a baseline - force is not a licence to re-run the drift check
  const conforming = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('[Emails] SES bounce triage')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: conforming, force: true, runner: mustNotCall }).action, 'no-check-needed');
  assert.equal(state.load().sessions.s1.lastCheckTurns, 2);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: conforming, force: true, runner: mustNotCall }).action, 'no-check-needed');

  // a non-conforming title sitting at its own baseline: gated out unforced, converges forced
  const file = fx.writeTranscript(projectDir, 's2', [...chat(2), fx.titleEntry('SES bounce triage', 's2')]);
  const s = state.load();
  state.session(s, 's2').lastCheckTurns = 2;
  state.save(s);
  assert.equal(worker.processSession({ sessionId: 's2', transcriptPath: file, runner: mustNotCall }).action, 'no-check-needed');
  const res = worker.processSession({ sessionId: 's2', transcriptPath: file, force: true, runner: () => '[Emails] SES bounce triage' });
  assert.equal(res.action, 'restyled');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Emails] SES bounce triage');
  // and the gate closes on the title it just wrote - a second forced look costs nothing
  assert.equal(worker.processSession({ sessionId: 's2', transcriptPath: file, force: true, runner: mustNotCall }).action, 'no-check-needed');
});

// A session with nothing usable to reformat needs a title, not a restyle - the first-title path
// still owns it.
test('a vague title takes the first-title path, whatever format it is in', () => {
  const { worker, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(1), fx.titleEntry('New session')]);
  let prompt = '';
  const res = worker.processSession({
    sessionId: 's1',
    transcriptPath: file,
    runner: (p) => { prompt = p; return '[Emails] SES triage'; },
  });
  assert.equal(res.action, 'titled');
  assert.ok(prompt.includes('There is no current title yet'));
  assert.ok(!prompt.includes('rewrite it into the required format'));
});

test('a dry-run restyle reports the title it would write and writes nothing', () => {
  const { worker, projectDir } = setup();
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('SES bounce triage')]);
  const res = worker.processSession({
    sessionId: 's1',
    transcriptPath: file,
    dryRun: true,
    runner: () => '[Emails] SES bounce triage',
  });
  assert.equal(res.action, 'dry-run');
  assert.equal(res.title, '[Emails] SES bounce triage');
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), 'SES bounce triage');
  assert.equal(require('node:fs').existsSync(require('../src/paths').stateFile()), false);
});

// The restyle path shares the normal write path, so the mid-generate protections cover it too.
test('a rename that lands mid-restyle is not clobbered by the reformatted title', () => {
  const { worker, state, projectDir } = setup();
  const t = require('../src/transcript');
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('SES bounce triage')]);
  const runner = () => {
    t.appendTitleRecord(file, 's1', 'My hand-written name');
    const other = state.load();
    state.recordTitle(other, 's1', 'My hand-written name', 2);
    state.session(other, 's1').manual = true;
    state.save(other);
    return '[Emails] SES bounce triage';
  };
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner }).action, 'manual-skip');
  assert.equal(t.currentTitle(t.readEntries(file)), 'My hand-written name');
});

// The hook path passes no model at all, so the config file is the only thing that decides what a
// title costs on a live session. Asserted through the runner seam - the second argument is what
// reaches `claude -p --model`.
test('the worker titles with the configured model', () => {
  const { worker, state, projectDir } = setup();
  const seen = [];
  const runner = (_p, model) => { seen.push(model); return '[Emails] SES bounce triage'; };

  const file = fx.writeTranscript(projectDir, 's1', chat(1));
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner }).action, 'titled');
  assert.deepEqual(seen, ['haiku'], 'the default');

  state.saveConfig({ ...state.loadConfig(), model: 'sonnet' });
  const file2 = fx.writeTranscript(projectDir, 's2', chat(1));
  assert.equal(worker.processSession({ sessionId: 's2', transcriptPath: file2, runner }).action, 'titled');
  assert.deepEqual(seen, ['haiku', 'sonnet']);
});

// A restyle and a drift recheck are title calls like any other - the setting covers all three, or a
// user who switched would still be billed the old model on most of their calls.
test('drift and restyle calls use the configured model too', () => {
  const { worker, state, projectDir } = setup();
  state.saveConfig({ ...state.loadConfig(), model: 'sonnet' });
  const seen = [];
  const runner = (_p, model) => { seen.push(model); return '[Emails] SES bounce triage'; };

  // restyle: a non-conforming title with prefixes on
  const file = fx.writeTranscript(projectDir, 's1', [...chat(2), fx.titleEntry('SES bounce triage')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: file, runner }).action, 'restyled');
  // drift: the same session doubled past its new baseline
  const grown = fx.writeTranscript(projectDir, 's1', [...chat(8), fx.titleEntry('[Emails] SES bounce triage')]);
  assert.equal(worker.processSession({ sessionId: 's1', transcriptPath: grown, runner: (p, m) => { seen.push(m); return 'KEEP'; } }).action, 'kept');
  assert.deepEqual(seen, ['sonnet', 'sonnet']);
});

// backfill --model is the escape hatch, and it is deliberately unrestricted - an explicit request
// beats the configured default rather than being validated against it.
test('an explicit model argument overrides the configured one', () => {
  const { worker, state, projectDir } = setup();
  state.saveConfig({ ...state.loadConfig(), model: 'sonnet' });
  const seen = [];
  const file = fx.writeTranscript(projectDir, 's1', chat(1));
  worker.processSession({
    sessionId: 's1',
    transcriptPath: file,
    model: 'opus',
    runner: (_p, model) => { seen.push(model); return '[Emails] SES bounce triage'; },
  });
  assert.deepEqual(seen, ['opus']);
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
