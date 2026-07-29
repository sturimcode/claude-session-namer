const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./fixtures');

// The project dir Claude Code writes worker-call transcripts into, given that the titler spawns
// `claude -p` from the OS temp dir. realpath matters on macOS, where /var is a symlink.
const tmpProjectName = () => fs.realpathSync(os.tmpdir()).replace(/[^a-zA-Z0-9]/g, '-');

// appStore maps cliSessionId -> 'user' | 'auto' | null. Each run gets its own store, empty by
// default, so no test reads the real desktop app store on the machine running the suite.
function fresh(appStore = {}) {
  const { configDir, projectDir } = fx.fakeConfig();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.CLAUDE_SESSION_NAMER_APP_STORE = fx.fakeAppStore(appStore);
  for (const m of ['../src/paths', '../src/state', '../src/appstore', '../src/worker', '../src/commands']) delete require.cache[require.resolve(m)];
  return { commands: require('../src/commands'), projectDir, configDir };
}

// A store dir that was never created at all - the Linux, Windows, and CLI-only case.
function noAppStore() {
  process.env.CLAUDE_SESSION_NAMER_APP_STORE = path.join(fx.tmpDir(), 'no-such-store');
}

// Swaps both streams so a command's stdout and its usage errors can be asserted separately.
function captureBoth(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.stdout.write = origOut; process.stderr.write = origErr; })
    .then(() => ({ out: out.join(''), err: err.join('') }));
}

const capture = (fn) => captureBoth(fn).then((r) => r.out);

const age = (file, ms) => { const d = new Date(Date.now() - ms); fs.utimesSync(file, d, d); };
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// A vague, titleable session aged to `ms` old. The id is derived from `n` so a test can assert on the
// short id backfill prints.
function agedSession(projectDir, n, ms) {
  const id = `${String(n).padStart(8, '0')}-1111-1111-1111-111111111111`;
  const file = fx.writeTranscript(projectDir, id, [fx.userEntry(`help me with thing ${n}`), fx.assistantEntry('sure')]);
  age(file, ms);
  return { id, short: id.slice(0, 8), file };
}

// A usage path must set process.exitCode rather than kill the process; restore it either way.
async function exitCodeOf(fn) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const res = await captureBoth(fn);
  const code = process.exitCode;
  process.exitCode = prev;
  return { ...res, code };
}

test('sessions enumerates jsonl files', () => {
  const { commands, projectDir } = fresh();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('x')]);
  fx.writeTranscript(projectDir, 'bbb22222-2222-2222-2222-222222222222', [fx.userEntry('y')]);
  assert.equal(commands.sessions().length, 2);
});

test('sessions ignores non-jsonl files, stray files in the projects root, and a missing root', () => {
  const { commands, projectDir, configDir } = fresh();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('x')]);
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'not a transcript');
  fs.writeFileSync(path.join(configDir, 'projects', 'stray.json'), '{}');
  assert.equal(commands.sessions().length, 1);

  const empty = fresh();
  fs.rmSync(path.join(empty.configDir, 'projects'), { recursive: true, force: true });
  assert.deepEqual(empty.commands.sessions(), []);
});

test('sessions sorts newest first and filters to one project dir', () => {
  const { commands, projectDir, configDir } = fresh();
  const other = path.join(configDir, 'projects', '-Users-other');
  fs.mkdirSync(other, { recursive: true });
  const older = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('x')]);
  const newer = fx.writeTranscript(other, 'bbb22222-2222-2222-2222-222222222222', [fx.userEntry('y')]);
  age(older, 2 * HOUR);
  age(newer, HOUR);
  assert.deepEqual(commands.sessions().map((s) => s.sessionId.slice(0, 3)), ['bbb', 'aaa']);
  assert.deepEqual(commands.sessions(other).map((s) => s.sessionId.slice(0, 3)), ['bbb']);
  // a bare project-dir name resolves under the projects root too
  assert.deepEqual(commands.sessions('-Users-other').map((s) => s.sessionId.slice(0, 3)), ['bbb']);
});

test('sessions skips the worker-echo project dir for the OS temp dir', () => {
  const { commands, projectDir, configDir } = fresh();
  const echo = path.join(configDir, 'projects', tmpProjectName());
  fs.mkdirSync(echo, { recursive: true });
  fx.writeTranscript(echo, 'ccc33333-3333-3333-3333-333333333333', [fx.userEntry('You title chat sessions')]);
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('x')]);
  assert.deepEqual(commands.sessions().map((s) => s.sessionId.slice(0, 3)), ['aaa']);
});

test('rename appends record and marks manual', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const file = fx.writeTranscript(projectDir, id, [fx.userEntry('x')]);
  await capture(() => commands.rename([id, 'My', 'manual', 'name']));
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), 'My manual name');
  const state = require('../src/state');
  assert.equal(state.load().sessions[id].manual, true);
});

test('rename accepts an unambiguous short id', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const file = fx.writeTranscript(projectDir, id, [fx.userEntry('x')]);
  fx.writeTranscript(projectDir, 'bbb22222-2222-2222-2222-222222222222', [fx.userEntry('y')]);
  const out = await capture(() => commands.rename(['aaa1', 'Short', 'id', 'rename']));
  assert.ok(out.includes('Short id rename'));
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), 'Short id rename');
});

test('rename refuses an ambiguous short id instead of guessing', async () => {
  const { commands, projectDir } = fresh();
  const a = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('x')]);
  const b = fx.writeTranscript(projectDir, 'aaa22222-2222-2222-2222-222222222222', [fx.userEntry('y')]);
  const { err, code } = await exitCodeOf(() => commands.rename(['aaa', 'Nope']));
  assert.match(err, /ambiguous session id/i);
  assert.equal(code, 1);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(a)), null);
  assert.equal(t.currentTitle(t.readEntries(b)), null);
});

test('rename reports an unknown id and a missing title without throwing', async () => {
  const { commands, projectDir } = fresh();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('x')]);
  const missing = await exitCodeOf(() => commands.rename(['zzz', 'Some', 'title']));
  assert.match(missing.err, /No session found/i);
  assert.equal(missing.code, 1);
  const noTitle = await exitCodeOf(() => commands.rename(['aaa11111']));
  assert.match(noTitle.err, /Usage/i);
  assert.equal(noTitle.code, 1);
});

test('rename flattens newlines and terminal escapes into a single row', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const file = fx.writeTranscript(projectDir, id, [fx.userEntry('x')]);
  await capture(() => commands.rename([id, 'Line one\nline\u001b[31m two']));
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), 'Line one line two');
  const lines = (await capture(() => commands.list([]))).trim().split('\n');
  assert.equal(lines.length, 1);
});

// Sanitizing is about characters that break the one-line record, not about punctuation the user
// meant - a hyphen carries meaning in a title and has to survive untouched.
test('rename leaves a hyphenated title exactly as typed', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const file = fx.writeTranscript(projectDir, id, [fx.userEntry('x')]);
  await capture(() => commands.rename([id, '[Emails]', 'Alias-domain', 'split', '-', 'SES-fix']));
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Emails] Alias-domain split - SES-fix');
});

test('rename rejects a title that sanitizes down to nothing', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const file = fx.writeTranscript(projectDir, id, [fx.userEntry('x')]);
  const { err, code } = await exitCodeOf(() => commands.rename([id, '\n\t\u001b[0m']));
  assert.match(err, /Usage/i);
  assert.equal(code, 1);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), null);
});

// `protect` is the guarantee: it locks a title the app or the tool already wrote, without touching
// the transcript. Nothing about the title record itself confers protection any more.
test('protect locks a session against re-titling without writing a title record', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const entries = [];
  for (let i = 0; i < 4; i++) { entries.push(fx.userEntry(`question ${i} about ses bounces`)); entries.push(fx.assistantEntry(`answer ${i}`)); }
  const file = fx.writeTranscript(projectDir, id, [...entries, fx.titleEntry('Revisit Monday', id)]);
  const t = require('../src/transcript');
  const before = t.readEntries(file).length;

  const out = await capture(() => commands.protect([id]));
  assert.match(out, /aaa11111/);
  const state = require('../src/state');
  assert.equal(state.load().sessions[id].manual, true);
  assert.equal(t.readEntries(file).length, before, 'protect must not append a title record');
  assert.equal(t.currentTitle(t.readEntries(file)), 'Revisit Monday');

  // and the worker leaves it alone from here on
  const { processSession } = require('../src/worker');
  assert.equal(processSession({ sessionId: id, transcriptPath: file, runner: () => '[X] Nope' }).action, 'manual-skip');
  assert.equal(t.currentTitle(t.readEntries(file)), 'Revisit Monday');
});

test('unprotect puts a session back in the tool\'s hands', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const entries = [];
  for (let i = 0; i < 4; i++) { entries.push(fx.userEntry(`question ${i} about ses bounces`)); entries.push(fx.assistantEntry(`answer ${i}`)); }
  const file = fx.writeTranscript(projectDir, id, entries);
  await capture(() => commands.protect([id]));
  const out = await capture(() => commands.unprotect([id]));
  assert.match(out, /aaa11111/);
  const state = require('../src/state');
  assert.equal(state.load().sessions[id].manual, false);
  const { processSession } = require('../src/worker');
  assert.equal(processSession({ sessionId: id, transcriptPath: file, runner: () => '[Emails] SES bounce triage' }).action, 'titled');
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Emails] SES bounce triage');
});

// A session the tool has never seen has no state entry - unprotecting it is a no-op, not a crash.
test('unprotect on a session with no state entry creates it unprotected', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  fx.writeTranscript(projectDir, id, [fx.userEntry('x')]);
  const { err, code } = await exitCodeOf(() => commands.unprotect([id]));
  assert.equal(err, '');
  assert.equal(code, undefined);
  const state = require('../src/state');
  assert.equal(state.load().sessions[id].manual, false);
});

test('protect and unprotect refuse an ambiguous short id and report an unknown one', async () => {
  const { commands, projectDir } = fresh();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('x')]);
  fx.writeTranscript(projectDir, 'aaa22222-2222-2222-2222-222222222222', [fx.userEntry('y')]);
  const state = require('../src/state');
  for (const cmd of ['protect', 'unprotect']) {
    const ambiguous = await exitCodeOf(() => commands[cmd](['aaa']));
    assert.match(ambiguous.err, /ambiguous session id/i, cmd);
    assert.equal(ambiguous.code, 1);

    const missing = await exitCodeOf(() => commands[cmd](['zzz']));
    assert.match(missing.err, /No session found/i, cmd);
    assert.equal(missing.code, 1);

    const noId = await exitCodeOf(() => commands[cmd]([]));
    assert.match(noId.err, /Usage/i, cmd);
    assert.equal(noId.code, 1);

    assert.deepEqual(state.load().sessions, {}, `${cmd} wrote state on a usage error`);
  }
});

test('list prints titles, search filters', async () => {
  const { commands, projectDir } = fresh();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('about ses bounces'), fx.titleEntry('[Emails] SES fix')]);
  fx.writeTranscript(projectDir, 'bbb22222-2222-2222-2222-222222222222', [fx.userEntry('about figma')]);
  const out = await capture(() => commands.list([]));
  assert.ok(out.includes('[Emails] SES fix'));
  assert.ok(out.includes('(untitled)'));
  const found = await capture(() => commands.search(['figma']));
  assert.ok(found.includes('bbb22222'));
  assert.ok(!found.includes('aaa11111'));
});

// Protection is invisible in the transcript - state is the only place it lives - so `list` is the
// only way a user can see which sessions the tool has stopped touching.
test('list marks protected sessions and leaves the rest unmarked', async () => {
  const { commands, projectDir } = fresh();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('about ses bounces'), fx.titleEntry('[Emails] SES fix', 'aaa11111-1111-1111-1111-111111111111')]);
  fx.writeTranscript(projectDir, 'bbb22222-2222-2222-2222-222222222222', [fx.userEntry('about figma'), fx.titleEntry('[CP] Experts tab', 'bbb22222-2222-2222-2222-222222222222')]);
  await capture(() => commands.protect(['aaa11111']));
  const lines = (await capture(() => commands.list([]))).trim().split('\n');
  const protectedLine = lines.find((l) => l.includes('aaa11111'));
  const plainLine = lines.find((l) => l.includes('bbb22222'));
  assert.ok(protectedLine.endsWith('[Emails] SES fix [protected]'), protectedLine);
  assert.ok(plainLine.endsWith('[CP] Experts tab'), plainLine);
  // and it comes back off with unprotect
  await capture(() => commands.unprotect(['aaa11111']));
  const after = (await capture(() => commands.list([]))).trim().split('\n');
  assert.ok(after.find((l) => l.includes('aaa11111')).endsWith('[Emails] SES fix'));
});

// The desktop app records a title typed in its UI as titleSource 'user'. Those sessions are never
// re-titled, so the listing has to say why - otherwise a user sees a session the tool silently
// never touches and has no idea it is spoken for.
test('list marks sessions renamed in the desktop app', async () => {
  const renamed = 'aaa11111-1111-1111-1111-111111111111';
  const auto = 'bbb22222-2222-2222-2222-222222222222';
  const unknown = 'ccc33333-3333-3333-3333-333333333333';
  const { commands, projectDir } = fresh({ [renamed]: 'user', [auto]: 'auto' });
  fx.writeTranscript(projectDir, renamed, [fx.userEntry('about ses bounces'), fx.titleEntry('Revisit Monday', renamed)]);
  fx.writeTranscript(projectDir, auto, [fx.userEntry('about figma'), fx.titleEntry('[CP] Experts tab', auto)]);
  fx.writeTranscript(projectDir, unknown, [fx.userEntry('about nexus'), fx.titleEntry('[Nexus] Disclaimers', unknown)]);
  const lines = (await capture(() => commands.list([]))).trim().split('\n');
  assert.ok(lines.find((l) => l.includes('aaa11111')).endsWith('Revisit Monday [renamed in app]'), lines.join('\n'));
  assert.ok(lines.find((l) => l.includes('bbb22222')).endsWith('[CP] Experts tab'), lines.join('\n'));
  assert.ok(lines.find((l) => l.includes('ccc33333')).endsWith('[Nexus] Disclaimers'), lines.join('\n'));
});

// Both marks can be true of one session, and each says something the other doesn't: one is a lock
// the user set here, the other is a name they typed in the app.
test('a session both protected and renamed in the app carries both marks', async () => {
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const { commands, projectDir } = fresh({ [id]: 'user' });
  fx.writeTranscript(projectDir, id, [fx.userEntry('about ses bounces'), fx.titleEntry('Revisit Monday', id)]);
  await capture(() => commands.protect([id]));
  const out = await capture(() => commands.list([]));
  assert.ok(out.trim().endsWith('Revisit Monday [protected] [renamed in app]'), out);
});

// No app store means no signal, on Linux, on Windows, or on a machine that has only run the CLI.
// The listing still works and nothing is marked.
test('list works with no desktop app store present', async () => {
  const { commands, projectDir } = fresh();
  noAppStore();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('x'), fx.titleEntry('[Emails] SES fix', 'aaa11111-1111-1111-1111-111111111111')]);
  const out = await capture(() => commands.list([]));
  assert.ok(out.trim().endsWith('[Emails] SES fix'), out);
});

test('list is newest first and caps at 50', async () => {
  const { commands, projectDir } = fresh();
  for (let i = 0; i < 55; i++) {
    const id = `${String(i).padStart(8, '0')}-1111-1111-1111-111111111111`;
    const file = fx.writeTranscript(projectDir, id, [fx.userEntry(`turn ${i}`)]);
    age(file, (55 - i) * 60_000);
  }
  const lines = (await capture(() => commands.list([]))).trim().split('\n');
  assert.equal(lines.length, 50);
  assert.ok(lines[0].includes('00000054'));
});

test('list dates the session in the local timezone', async () => {
  const { commands, projectDir } = fresh();
  const file = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('x')]);
  const out = await capture(() => commands.list([]));
  assert.ok(out.startsWith(new Date(fs.statSync(file).mtimeMs).toLocaleDateString('en-CA') + '  '), out);
});

test('list pads a short session id so the title column stays aligned', async () => {
  const { commands, projectDir } = fresh();
  fx.writeTranscript(projectDir, 'ab', [fx.userEntry('x')]);
  const out = await capture(() => commands.list([]));
  assert.ok(out.includes('  ab        (untitled)'), JSON.stringify(out));
});

test('list and backfill reject a --project that resolves to nothing', async () => {
  const { commands } = fresh();
  const listed = await exitCodeOf(() => commands.list(['--project', '/no/such/project']));
  assert.equal(listed.out, '');
  assert.match(listed.err, /No project directory: \/no\/such\/project/);
  assert.equal(listed.code, 1);

  const swept = await exitCodeOf(() => commands.backfill(['--project', '-Users-nope'], { runner: () => 'X' }));
  assert.equal(swept.out, '');
  assert.match(swept.err, /No project directory: -Users-nope/);
  assert.equal(swept.code, 1);
});

// `--project "$SOME_UNSET_VAR"` is the real case: an empty value used to pass the existence check
// (the projects root itself) and then read as falsy, sweeping every project in the store.
test('an explicit but empty --project is a usage error, not a sweep of everything', async () => {
  const { commands, projectDir } = fresh();
  const file = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  age(file, HOUR);
  for (const value of ['', '   ']) {
    const listed = await exitCodeOf(() => commands.list(['--project', value]));
    assert.equal(listed.out, '', `list swept the whole store for --project ${JSON.stringify(value)}`);
    assert.match(listed.err, /--project/);
    assert.equal(listed.code, 1);

    const swept = await exitCodeOf(() => commands.backfill(['--project', value], { runner: () => { throw new Error('must not sweep'); } }));
    assert.equal(swept.out, '', `backfill swept the whole store for --project ${JSON.stringify(value)}`);
    assert.match(swept.err, /--project/);
    assert.equal(swept.code, 1);
  }
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), null);
});

// `--project` typed with nothing after it reads as undefined - the same value a missing flag gives -
// so the filter fell through to "no filter" and the sweep took in every project in the store.
test('a dangling --project is a usage error, not a sweep of everything', async () => {
  const { commands, projectDir } = fresh();
  const file = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  age(file, HOUR);

  const listed = await exitCodeOf(() => commands.list(['--project']));
  assert.equal(listed.out, '', 'list swept the whole store for a dangling --project');
  assert.match(listed.err, /--project/);
  assert.equal(listed.code, 1);

  const swept = await exitCodeOf(() => commands.backfill(['--project'], { runner: () => { throw new Error('must not sweep'); } }));
  assert.equal(swept.out, '', 'backfill swept the whole store for a dangling --project');
  assert.match(swept.err, /--project/);
  assert.equal(swept.code, 1);

  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), null);
});

// A mistyped flag used to be ignored, so `--dryrun` and `--dry` ran a real, writing sweep while the
// user believed they were previewing one.
test('backfill refuses an unknown flag instead of running a real sweep', async () => {
  const { commands, projectDir } = fresh();
  const file = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  age(file, HOUR);
  const t = require('../src/transcript');

  for (const typo of ['--dryrun', '--dry']) {
    let calls = 0;
    const res = await exitCodeOf(() => commands.backfill([typo], { runner: () => { calls++; return '[X] Nope'; } }));
    assert.equal(calls, 0, `${typo} reached the runner`);
    assert.equal(res.out, '');
    assert.match(res.err, new RegExp(`Unknown option: \\${typo}`));
    assert.match(res.err, /Usage/i);
    assert.equal(res.code, 1);
    assert.equal(t.currentTitle(t.readEntries(file)), null);
  }

  // several at once are all named, so the user fixes the whole line in one go
  const many = await exitCodeOf(() => commands.backfill(['--dryrun', 'extra'], { runner: () => { throw new Error('must not sweep'); } }));
  assert.match(many.err, /Unknown options: --dryrun, extra/);
  assert.equal(many.code, 1);
});

test('backfill accepts its own flags and their values without complaint', async () => {
  const { commands, projectDir } = fresh();
  const file = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  age(file, HOUR);
  const { out, err, code } = await exitCodeOf(() => commands.backfill(
    ['--dry-run', '--model', 'sonnet', '--project', projectDir, '--since', '60', '--limit', '10'],
    { runner: () => '[Emails] SES bounce help' },
  ));
  assert.equal(err, '', err);
  assert.equal(code, undefined);
  assert.ok(out.includes('[Emails] SES bounce help'), out);

  const swept = await exitCodeOf(() => commands.backfill(['--all'], { runner: () => '[Emails] SES bounce help' }));
  assert.equal(swept.err, '', swept.err);
  assert.equal(swept.code, undefined);
});

// rename sanitizes on write, but a title the app or the model wrote lands in the transcript
// unfiltered - the display path has to hold the line too.
test('list and search strip escapes from a title written outside rename', async () => {
  const { commands, projectDir } = fresh();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [
    fx.userEntry('about ses bounces'),
    fx.titleEntry('\u001b[31m[Emails] SES fix\nsecond line'),
  ]);
  const out = await capture(() => commands.list([]));
  assert.equal(out.trim().split('\n').length, 1, 'a title with a newline must not break the row');
  assert.ok(out.includes('[Emails] SES fix second line'), out);
  assert.ok(!out.includes('\u001b'), 'terminal escapes must not reach the terminal');
  const found = await capture(() => commands.search(['ses fix']));
  assert.ok(found.includes('aaa11111'), found);
  assert.ok(!found.includes('\u001b'));
});

test('search matches titles case-insensitively and reports a missing query', async () => {
  const { commands, projectDir } = fresh();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('nothing relevant'), fx.titleEntry('[Emails] SES fix')]);
  const byTitle = await capture(() => commands.search(['ses', 'fix']));
  assert.ok(byTitle.includes('aaa11111'));
  const usage = await exitCodeOf(() => commands.search([]));
  assert.match(usage.err, /Usage/i);
  assert.equal(usage.code, 1);
});

test('config prints and toggles prefix setting', async () => {
  const { commands } = fresh();
  assert.ok((await capture(() => commands.config([]))).includes('prefix: on'));
  await capture(() => commands.config(['prefix', 'off']));
  assert.ok((await capture(() => commands.config([]))).includes('prefix: off'));
  const state = require('../src/state');
  assert.deepEqual(state.loadConfig(), { prefix: false });
});

test('config keeps unknown keys and rejects bad arguments', async () => {
  const { commands, configDir } = fresh();
  const state = require('../src/state');
  const dir = path.join(configDir, 'claude-session-namer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ prefix: true, future: 'keep me' }));
  await capture(() => commands.config(['prefix', 'off']));
  assert.deepEqual(state.loadConfig(), { prefix: false, future: 'keep me' });

  const bad = await exitCodeOf(() => commands.config(['prefix', 'maybe']));
  assert.match(bad.err, /Usage/i);
  assert.equal(bad.code, 1);
  assert.equal(state.loadConfig().prefix, false); // unchanged

  // A trailing argument means the user meant something we don't support - say so rather than
  // quietly acting on the part we understood.
  const garbage = await exitCodeOf(() => commands.config(['prefix', 'on', 'globally']));
  assert.match(garbage.err, /Usage/i);
  assert.equal(garbage.code, 1);
  assert.equal(state.loadConfig().prefix, false); // unchanged
});

test('backfill dry-run titles vague sessions without writing', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const file = fx.writeTranscript(projectDir, id, [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  // age the file past the active-session window
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
  const out = await capture(() => commands.backfill(['--dry-run'], { runner: () => '[Emails] SES bounce help' }));
  assert.ok(out.includes('[Emails] SES bounce help'));
  // A dry run still spends a model call per session - the summary has to say so.
  assert.ok(out.includes('[dry-run] 1 session(s) would be titled (each cost one model call), 0 skipped.'), out);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), null);
});

// A restyle is a title the sweep wrote, so it counts and prints like any other - a user who turns
// prefixes on and sweeps has to see which titles changed.
test('backfill counts and prints a restyled title', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const file = fx.writeTranscript(projectDir, id, [
    fx.userEntry('help me with ses bounces'),
    fx.assistantEntry('sure'),
    fx.titleEntry('SES bounce triage', id),
  ]);
  age(file, HOUR);
  const out = await capture(() => commands.backfill([], { runner: () => '[Emails] SES bounce triage' }));
  assert.ok(out.includes('[Emails] SES bounce triage'), out);
  assert.ok(out.includes('1 session(s) titled, 0 skipped.'), out);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Emails] SES bounce triage');
});

// Backfill counts anything that isn't a title it wrote as skipped, so the app-rename protection
// carries over to the sweep without backfill knowing the action exists.
test('backfill leaves a session renamed in the desktop app alone', async () => {
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const { commands, projectDir } = fresh({ [id]: 'user' });
  const file = fx.writeTranscript(projectDir, id, [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  age(file, HOUR);
  const out = await capture(() => commands.backfill([], { runner: () => { throw new Error('must not call the model'); } }));
  assert.ok(out.includes('0 session(s) titled, 1 skipped.'), out);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), null);
});

test('backfill skips its own worker transcripts by prompt signature', async () => {
  const { commands, projectDir } = fresh();
  const { PROMPT_SIGNATURE } = require('../src/titler');
  const file = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [
    fx.userEntry(`${PROMPT_SIGNATURE}\n\nCurrent title: (none)\n\nConversation excerpt:\nUser: hi`),
    fx.assistantEntry('[Emails] SES fix'),
  ]);
  age(file, HOUR);
  const out = await capture(() => commands.backfill([], { runner: () => { throw new Error('should not be called'); } }));
  assert.ok(out.includes('0 session(s) titled, 1 skipped.'), out);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), null);
});

test('backfill aborts the sweep after five consecutive failures', async () => {
  const { commands, projectDir } = fresh();
  for (let i = 0; i < 7; i++) {
    const file = fx.writeTranscript(projectDir, `${String(i).padStart(8, '0')}-1111-1111-1111-111111111111`, [
      fx.userEntry(`help me with thing ${i}`),
      fx.assistantEntry('sure'),
    ]);
    age(file, HOUR);
  }
  let calls = 0;
  const { err, code } = await exitCodeOf(() => commands.backfill([], {
    runner: () => { calls++; throw new Error('claude exited 1'); },
  }));
  assert.equal(calls, 5);
  assert.match(err, /5 consecutive failures/);
  assert.match(err, /claude exited 1/);
  assert.equal(code, 1);
});

test('backfill leaves likely-active sessions alone', async () => {
  const { commands, projectDir } = fresh();
  fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('still typing'), fx.assistantEntry('ok')]);
  const out = await capture(() => commands.backfill([], { runner: () => { throw new Error('should not be called'); } }));
  assert.ok(out.includes('0 session(s) titled, 1 skipped.'), out);
});

test('backfill writes titles and reports no failures on a clean sweep', async () => {
  const { commands, projectDir } = fresh();
  const id = 'aaa11111-1111-1111-1111-111111111111';
  const file = fx.writeTranscript(projectDir, id, [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  age(file, HOUR);
  const out = await capture(() => commands.backfill([], { runner: () => '[Emails] SES bounce help' }));
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(file)), '[Emails] SES bounce help');
  assert.ok(out.includes('1 session(s) titled, 0 skipped.'), out);
  assert.ok(!out.includes('failed'), out);
});

test('backfill survives a session that throws and counts it in the summary', async () => {
  const { commands, projectDir } = fresh();
  const bad = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('boom please'), fx.assistantEntry('ok')]);
  const good = fx.writeTranscript(projectDir, 'bbb22222-2222-2222-2222-222222222222', [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  age(bad, 2 * HOUR);
  age(good, HOUR);
  const runner = (prompt) => {
    if (prompt.includes('boom')) throw new Error('claude exited 1');
    return '[Emails] SES bounce help';
  };
  const { out, err } = await captureBoth(() => commands.backfill([], { runner }));
  assert.ok(out.includes('[Emails] SES bounce help'), out);
  assert.ok(out.includes('1 session(s) titled, 0 skipped, 1 failed.'), out);
  assert.match(err, /aaa11111/);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(good)), '[Emails] SES bounce help');
});

test('backfill limits the sweep to one project dir', async () => {
  const { commands, projectDir, configDir } = fresh();
  const other = path.join(configDir, 'projects', '-Users-other');
  fs.mkdirSync(other, { recursive: true });
  const mine = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  const theirs = fx.writeTranscript(other, 'bbb22222-2222-2222-2222-222222222222', [fx.userEntry('something else'), fx.assistantEntry('ok')]);
  age(mine, HOUR);
  age(theirs, HOUR);
  const out = await capture(() => commands.backfill(['--project', projectDir], { runner: () => '[Emails] SES bounce help' }));
  assert.ok(out.includes('aaa11111'), out);
  assert.ok(!out.includes('bbb22222'), out);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(theirs)), null);
});

test('backfill passes the requested model through to the runner', async () => {
  const { commands, projectDir } = fresh();
  const file = fx.writeTranscript(projectDir, 'aaa11111-1111-1111-1111-111111111111', [fx.userEntry('help me with ses bounces'), fx.assistantEntry('sure')]);
  age(file, HOUR);
  const seen = [];
  await capture(() => commands.backfill(['--model', 'sonnet'], { runner: (_p, model) => { seen.push(model); return '[Emails] SES bounce help'; } }));
  assert.deepEqual(seen, ['sonnet']);
});

// Backfill scope
//
// A sweep of the whole store is hundreds of model calls and most of an hour, spent largely on
// sessions the user will never scroll back to. The default covers what their sidebar shows - the
// newest 50 from the last 30 days - and --all is the opt-in to everything.

test('backfill by default leaves a session older than the 30-day window alone', async () => {
  const { commands, projectDir } = fresh();
  const recent = agedSession(projectDir, 1, HOUR);
  const old = agedSession(projectDir, 2, 40 * DAY);
  const out = await capture(() => commands.backfill([], { runner: () => '[Emails] SES bounce help' }));
  assert.ok(out.includes(recent.short), out);
  assert.ok(!out.includes(old.short), out);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(recent.file)), '[Emails] SES bounce help');
  assert.equal(t.currentTitle(t.readEntries(old.file)), null);
  // Out-of-scope sessions are not "skipped" - they were never candidates.
  assert.ok(out.includes('1 session(s) titled, 0 skipped.'), out);
});

test('backfill by default stops at the 50 newest sessions in the window', async () => {
  const { commands, projectDir } = fresh();
  const made = [];
  for (let i = 0; i < 51; i++) made.push(agedSession(projectDir, i, HOUR + i * 60_000));
  const oldest = made[50];
  let calls = 0;
  const out = await capture(() => commands.backfill([], { runner: () => { calls++; return '[Emails] SES bounce help'; } }));
  assert.equal(calls, 50);
  assert.ok(out.includes('50 session(s) titled, 0 skipped.'), out);
  assert.ok(!out.includes(oldest.short), out);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(oldest.file)), null);
});

test('backfill --since widens the window and keeps the 50 cap', async () => {
  const { commands, projectDir } = fresh();
  const old = agedSession(projectDir, 2, 40 * DAY);
  const out = await capture(() => commands.backfill(['--since', '90'], { runner: () => '[Emails] SES bounce help' }));
  assert.ok(out.includes(old.short), out);
  const t = require('../src/transcript');
  assert.equal(t.currentTitle(t.readEntries(old.file)), '[Emails] SES bounce help');
  assert.ok(out.includes('from the last 90 days'), out);
});

test('backfill --limit overrides the cap', async () => {
  const { commands, projectDir } = fresh();
  for (let i = 0; i < 12; i++) agedSession(projectDir, i, HOUR + i * 60_000);
  let calls = 0;
  const out = await capture(() => commands.backfill(['--limit', '5'], { runner: () => { calls++; return '[Emails] SES bounce help'; } }));
  assert.equal(calls, 5);
  assert.ok(out.includes('5 session(s) titled, 0 skipped.'), out);
  assert.ok(out.includes('Scanned the 5 newest sessions'), out);
});

test('backfill --all sweeps the whole history with no window and no cap', async () => {
  const { commands, projectDir } = fresh();
  const old = agedSession(projectDir, 900, 40 * DAY);
  for (let i = 0; i < 51; i++) agedSession(projectDir, i, HOUR + i * 60_000);
  let calls = 0;
  const out = await capture(() => commands.backfill(['--all'], { runner: () => { calls++; return '[Emails] SES bounce help'; } }));
  assert.equal(calls, 52);
  assert.ok(out.includes(old.short), out);
  // The scope note is a nudge toward --all, so it has no business in an --all run.
  assert.ok(!out.includes('use --all for full history'), out);
});

test('backfill prints the scope it actually scanned before the summary', async () => {
  const { commands, projectDir } = fresh();
  agedSession(projectDir, 1, HOUR);
  const out = await capture(() => commands.backfill(['--dry-run'], { runner: () => '[Emails] SES bounce help' }));
  const lines = out.trim().split('\n');
  assert.equal(lines[lines.length - 2], 'Scanned the 1 newest session from the last 30 days (use --all for full history).');
  assert.match(lines[lines.length - 1], /^\[dry-run\]/);
});

test('backfill refuses --all combined with --since or --limit', async () => {
  const { commands, projectDir } = fresh();
  agedSession(projectDir, 1, HOUR);
  for (const argv of [['--all', '--since', '90'], ['--all', '--limit', '5'], ['--all', '--since', '90', '--limit', '5']]) {
    const res = await exitCodeOf(() => commands.backfill(argv, { runner: () => { throw new Error('must not sweep'); } }));
    assert.equal(res.out, '', `${argv.join(' ')} swept anyway`);
    assert.match(res.err, /--all/);
    assert.match(res.err, /Usage/i);
    assert.equal(res.code, 1);
  }
});

test('backfill rejects a --since or --limit that is not a positive whole number', async () => {
  const { commands, projectDir } = fresh();
  agedSession(projectDir, 1, HOUR);
  const bad = [
    ['--since', '0'], ['--since', '-5'], ['--since', 'ninety'], ['--since', '1.5'], ['--since'],
    ['--limit', '0'], ['--limit', '-1'], ['--limit', 'five'], ['--limit'],
  ];
  for (const argv of bad) {
    const res = await exitCodeOf(() => commands.backfill(argv, { runner: () => { throw new Error('must not sweep'); } }));
    assert.equal(res.out, '', `${argv.join(' ')} swept anyway`);
    assert.match(res.err, new RegExp(`\\${argv[0]}`), res.err);
    assert.equal(res.code, 1);
  }
});

// sync-plan
//
// The desktop app's sidebar reads the app's own registry, not the transcript, so a title we wrote
// never reaches it on its own. This command computes the diff between the two for an agent holding
// the app's session-rename tool to apply. It writes nothing itself, and its output is machine-read,
// so stdout carries JSON lines and nothing else.

const AUTO = 'aaa11111-1111-1111-1111-111111111111';
const USER = 'bbb22222-2222-2222-2222-222222222222';
const jsonLines = (out) => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('sync-plan emits a diff for a session the app titled itself', async () => {
  const { commands, projectDir } = fresh({ [AUTO]: { sessionId: 'local_aaa', title: 'New session', titleSource: 'auto' } });
  fx.writeTranscript(projectDir, AUTO, [fx.userEntry('why are ses bounces climbing'), fx.titleEntry('[Emails] SES bounce triage', AUTO)]);
  const out = await capture(() => commands['sync-plan']([]));
  assert.deepEqual(jsonLines(out), [
    { sessionId: 'local_aaa', currentTitle: 'New session', newTitle: '[Emails] SES bounce triage' },
  ]);
});

// A name the user typed in the app is theirs, and pushing our title over it is the one thing this
// command must never cause. --all is the deliberate opt-out.
test('sync-plan excludes user-renamed sessions unless --all is passed', async () => {
  const store = {
    [AUTO]: { sessionId: 'local_aaa', title: 'New session', titleSource: 'auto' },
    [USER]: { sessionId: 'local_bbb', title: 'Revisit Monday', titleSource: 'user' },
  };
  const { commands, projectDir } = fresh(store);
  fx.writeTranscript(projectDir, AUTO, [fx.userEntry('why are ses bounces climbing'), fx.titleEntry('[Emails] SES bounce triage', AUTO)]);
  fx.writeTranscript(projectDir, USER, [fx.userEntry('what did we decide on aliases'), fx.titleEntry('[Emails] Alias domain split', USER)]);

  const plain = jsonLines(await capture(() => commands['sync-plan']([])));
  assert.deepEqual(plain.map((r) => r.sessionId), ['local_aaa']);

  const all = jsonLines(await capture(() => commands['sync-plan'](['--all'])));
  assert.deepEqual(all.map((r) => r.sessionId).sort(), ['local_aaa', 'local_bbb']);
  assert.deepEqual(all.find((r) => r.sessionId === 'local_bbb'), {
    sessionId: 'local_bbb', currentTitle: 'Revisit Monday', newTitle: '[Emails] Alias domain split',
  });
});

// The store can hold more than one record for the same session - the app writes a fresh file when it
// re-registers a session, and the older one stays behind. If any of them says the user typed the
// name, the name is theirs: excluding only the record that carries the marker would still emit a
// push against its sibling and overwrite what they typed.
test('sync-plan excludes a session the user renamed even when the store also holds an auto record for it', async () => {
  const { commands, projectDir } = fresh({ [USER]: { sessionId: 'local_bbb', title: 'Revisit Monday', titleSource: 'user' } });
  fx.appStoreRecord(process.env.CLAUDE_SESSION_NAMER_APP_STORE, USER, { sessionId: 'local_bbb_old', title: 'New session', titleSource: 'auto' }, 'dup');
  fx.writeTranscript(projectDir, USER, [fx.userEntry('what did we decide on aliases'), fx.titleEntry('[Emails] Alias domain split', USER)]);

  assert.equal(await capture(() => commands['sync-plan']([])), '');

  const all = jsonLines(await capture(() => commands['sync-plan'](['--all'])));
  assert.deepEqual(all.map((r) => r.sessionId).sort(), ['local_bbb', 'local_bbb_old']);
});

// Nothing to push is the common case, and a push is only worth making when our title is both real
// and different. A vague title is what the app already has.
test('sync-plan skips matching titles, vague titles, and sessions with no transcript', async () => {
  const same = 'ccc33333-3333-3333-3333-333333333333';
  const vague = 'ddd44444-4444-4444-4444-444444444444';
  const gone = 'eee55555-5555-5555-5555-555555555555';
  const { commands, projectDir } = fresh({
    [same]: { sessionId: 'local_ccc', title: '[Emails] SES bounce triage', titleSource: 'auto' },
    [vague]: { sessionId: 'local_ddd', title: 'Something else', titleSource: 'auto' },
    [gone]: { sessionId: 'local_eee', title: 'Whatever', titleSource: 'auto' },
  });
  fx.writeTranscript(projectDir, same, [fx.userEntry('why are ses bounces climbing'), fx.titleEntry('[Emails] SES bounce triage', same)]);
  fx.writeTranscript(projectDir, vague, [fx.userEntry('why are ses bounces climbing'), fx.titleEntry('New session', vague)]);
  // `gone` has a store record but no transcript on this machine at all
  const { out, code } = await exitCodeOf(() => commands['sync-plan']([]));
  assert.equal(out, '');
  assert.ok(code === undefined || code === 0, `exit code ${code}`);
});

// A transcript with no title record yet has nothing to push either.
test('sync-plan skips a session with no title in the transcript', async () => {
  const { commands, projectDir } = fresh({ [AUTO]: { sessionId: 'local_aaa', title: 'New session', titleSource: 'auto' } });
  fx.writeTranscript(projectDir, AUTO, [fx.userEntry('why are ses bounces climbing'), fx.assistantEntry('checking')]);
  assert.equal(await capture(() => commands['sync-plan']([])), '');
});

// No store is the Linux, Windows, and CLI-only case - an empty plan, not an error.
test('sync-plan prints nothing with no desktop app store present', async () => {
  const { commands, projectDir } = fresh();
  noAppStore();
  fx.writeTranscript(projectDir, AUTO, [fx.userEntry('why are ses bounces climbing'), fx.titleEntry('[Emails] SES bounce triage', AUTO)]);
  assert.equal(await capture(() => commands['sync-plan']([])), '');
});

test('sync-plan rejects an unknown flag', async () => {
  const { commands } = fresh();
  const { out, err, code } = await exitCodeOf(() => commands['sync-plan'](['--push']));
  assert.equal(out, '');
  assert.match(err, /Unknown option: --push/);
  assert.equal(code, 1);
});
