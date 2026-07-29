const { spawn: childSpawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STDIN_TIMEOUT_MS = 3000;

// Reads the Stop hook payload and reduces it to what the worker needs.
// Returns null for anything we shouldn't act on - including a re-entrant Stop event
// (stop_hook_active), which is how a hook-triggered continuation announces itself.
function parsePayload(raw) {
  try {
    const p = JSON.parse(raw);
    if (p.stop_hook_active) return null;
    if (!p.session_id || !p.transcript_path) return null;
    return { sessionId: p.session_id, transcriptPath: p.transcript_path };
  } catch { return null; }
}

// Resolves with whatever arrived on stdin. The timeout is a floor under a stdin that
// never ends - the hook resolves with what it has rather than hanging the session.
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), STDIN_TIMEOUT_MS).unref();
  });
}

// Guards in order, then hands off to a detached worker and returns. Every rejection path
// is a silent return: a Stop hook that writes or throws disturbs the session it fired on.
// Deps are injectable so the guard order is testable without spawning real processes.
async function run({ spawn = childSpawn, readInput = readStdin, env = process.env } = {}) {
  // Our own worker shells out to `claude -p`, which fires its own Stop hooks. Without this
  // the hook would spawn a worker for every titling run, forever.
  if (env.CLAUDE_SESSION_NAMER_WORKER === '1') return;

  const payload = parsePayload(await readInput());
  if (!payload) return;
  if (!fs.existsSync(payload.transcriptPath)) return;

  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  const args = [cli, 'worker', '--session', payload.sessionId, '--transcript', payload.transcriptPath];
  try {
    // Detached + stdio ignored + unref'd: the worker blocks up to 90s on `claude -p`,
    // and the hook must not wait for it or hold the session's streams open.
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* a hook never fails loudly */ }
}

module.exports = { run, parsePayload };
