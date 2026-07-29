const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fx = require('./fixtures');
const hook = require('../src/hook');

// A fake spawn that records calls instead of forking a process.
function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = { unrefed: false, unref() { child.unrefed = true; }, on() {} };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

// A fake spawn whose child is a real EventEmitter, so an unhandled 'error' throws for real.
function emittingSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.unrefed = false;
    child.unref = () => { child.unrefed = true; };
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

test('run never throws when the spawn fails asynchronously', async () => {
  const file = transcriptFile();
  const spawn = emittingSpawn();
  await hook.run({ spawn, readInput: async () => JSON.stringify({ session_id: 'abc', transcript_path: file }), env: {} });

  assert.equal(spawn.calls.length, 1);
  const { child } = spawn.calls[0];
  assert.equal(child.unrefed, true);
  assert.ok(child.listenerCount('error') > 0, 'hook must listen for the async spawn error');

  // ENOENT and friends arrive after run() has returned; unhandled, an EventEmitter
  // 'error' throws and takes the whole hook process down.
  const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  await new Promise((resolve, reject) => {
    setImmediate(() => {
      try { child.emit('error', err); resolve(); } catch (e) { reject(e); }
    });
  });
});

test('run tolerates a partial deps object and falls back to the real defaults', async () => {
  // bin/cli.js calls run() with nothing; passing only some deps must not throw.
  await assert.doesNotReject(hook.run({ spawn: fakeSpawn(), env: { CLAUDE_SESSION_NAMER_WORKER: '1' } }));
});

test('readStdin concatenates chunks and resolves on end', async () => {
  const stream = new PassThrough();
  const read = hook.readStdin(stream);
  stream.write('{"session_id":"abc",');
  stream.write('"transcript_path":"/tmp/x.jsonl"}');
  stream.end();
  assert.equal(await read, '{"session_id":"abc","transcript_path":"/tmp/x.jsonl"}');
});

test('readStdin resolves with what it has when the stream errors', async () => {
  const stream = new PassThrough();
  const read = hook.readStdin(stream);
  stream.write('partial');
  await new Promise((r) => setImmediate(r));
  stream.emit('error', new Error('EPIPE'));
  assert.equal(await read, 'partial');
});

test('readStdin releases the stream when the timeout fires', async () => {
  const stream = new PassThrough();
  const started = Date.now();
  const read = hook.readStdin(stream, 50);
  stream.write('held open');
  // No end() - a writer that never closes the pipe is exactly the hang case.
  assert.equal(await read, 'held open');
  assert.ok(Date.now() - started < 1000, 'must resolve on the injected timeout, not hang');
  assert.equal(stream.listenerCount('data'), 0, 'data listener must be removed so the event loop can drain');
  assert.equal(stream.listenerCount('end'), 0);
  // One no-op error listener stays behind on purpose: a stream with no error listener at all
  // throws on a late EPIPE and takes the hook down after it has already done its job.
  assert.equal(stream.listenerCount('error'), 1);
});

test('readStdin absorbs a stream error that arrives after it resolved', async () => {
  const stream = new PassThrough();
  assert.equal(await hook.readStdin(stream, 20), '');
  assert.doesNotThrow(() => stream.emit('error', new Error('EPIPE')));
});
