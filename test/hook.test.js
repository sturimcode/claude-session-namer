const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./fixtures');
const hook = require('../src/hook');

// A fake spawn that records calls instead of forking a process.
function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = { unrefed: false, unref() { child.unrefed = true; } };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

// Builds the deps run() needs: a payload on stdin, a recording spawn, a chosen env.
function deps(payload, env = {}) {
  const spawn = fakeSpawn();
  const readInput = async () => (typeof payload === 'string' ? payload : JSON.stringify(payload));
  return { spawn, readInput, env, opts: { spawn, readInput, env } };
}

function transcriptFile() {
  return fx.writeTranscript(fx.tmpDir(), 's1', [fx.userEntry('hello')]);
}

test('parsePayload extracts session and transcript', () => {
  const p = hook.parsePayload(JSON.stringify({ session_id: 'abc', transcript_path: '/tmp/x.jsonl', stop_hook_active: false }));
  assert.deepEqual(p, { sessionId: 'abc', transcriptPath: '/tmp/x.jsonl' });
});

test('parsePayload rejects garbage and active stop hooks', () => {
  assert.equal(hook.parsePayload('not json'), null);
  assert.equal(hook.parsePayload(JSON.stringify({ session_id: 'a', transcript_path: '/t', stop_hook_active: true })), null);
  assert.equal(hook.parsePayload(JSON.stringify({ session_id: 'a' })), null);
  assert.equal(hook.parsePayload(JSON.stringify({ transcript_path: '/t' })), null);
  assert.equal(hook.parsePayload(''), null);
});

test('run spawns the worker detached with session and transcript', async () => {
  const file = transcriptFile();
  const d = deps({ session_id: 'abc', transcript_path: file });
  await hook.run(d.opts);

  assert.equal(d.spawn.calls.length, 1);
  const { cmd, args, opts, child } = d.spawn.calls[0];
  assert.equal(cmd, process.execPath);
  assert.equal(args[0], path.join(__dirname, '..', 'bin', 'cli.js'));
  assert.ok(fs.existsSync(args[0]), 'spawned cli path must exist');
  assert.deepEqual(args.slice(1), ['worker', '--session', 'abc', '--transcript', file]);
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, 'ignore');
  assert.equal(child.unrefed, true, 'child must be unref\'d so the hook returns immediately');
});

test('run exits silently when running inside our own worker', async () => {
  const file = transcriptFile();
  const d = deps({ session_id: 'abc', transcript_path: file }, { CLAUDE_SESSION_NAMER_WORKER: '1' });
  await hook.run(d.opts);
  assert.equal(d.spawn.calls.length, 0);
});

test('run does not spawn on unparseable payload', async () => {
  const d = deps('not json at all');
  await hook.run(d.opts);
  assert.equal(d.spawn.calls.length, 0);
});

test('run does not spawn when stop_hook_active is true', async () => {
  const file = transcriptFile();
  const d = deps({ session_id: 'abc', transcript_path: file, stop_hook_active: true });
  await hook.run(d.opts);
  assert.equal(d.spawn.calls.length, 0);
});

test('run does not spawn when the transcript is missing or absent from disk', async () => {
  const noPath = deps({ session_id: 'abc' });
  await hook.run(noPath.opts);
  assert.equal(noPath.spawn.calls.length, 0);

  const gone = deps({ session_id: 'abc', transcript_path: path.join(fx.tmpDir(), 'nope.jsonl') });
  await hook.run(gone.opts);
  assert.equal(gone.spawn.calls.length, 0);
});

test('run never throws when the spawn itself fails', async () => {
  const file = transcriptFile();
  const boom = () => { throw new Error('EMFILE'); };
  await hook.run({ spawn: boom, readInput: async () => JSON.stringify({ session_id: 'abc', transcript_path: file }), env: {} });
});

test('run defaults to the real process env and stdin reader', async () => {
  // Called with no deps (as bin/cli.js does) it must not throw; stdin is not a TTY
  // stream under the test runner, so this exercises the default readInput path.
  await assert.doesNotReject(hook.run({ spawn: fakeSpawn(), env: { CLAUDE_SESSION_NAMER_WORKER: '1' } }));
});
