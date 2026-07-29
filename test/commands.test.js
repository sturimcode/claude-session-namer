const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./fixtures');

// The project dir Claude Code writes worker-call transcripts into, given that the titler spawns
// `claude -p` from the OS temp dir. realpath matters on macOS, where /var is a symlink.
const tmpProjectName = () => fs.realpathSync(os.tmpdir()).replace(/[^a-zA-Z0-9]/g, '-');

function fresh() {
  const { configDir, projectDir } = fx.fakeConfig();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  for (const m of ['../src/paths', '../src/state', '../src/worker', '../src/commands']) delete require.cache[require.resolve(m)];
  return { commands: require('../src/commands'), projectDir, configDir };
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
