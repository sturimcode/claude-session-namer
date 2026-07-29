const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = [];
process.on('exit', () => {
  for (const d of created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csn-test-'));
  created.push(dir);
  return dir;
}

function userEntry(text) { return { type: 'user', message: { role: 'user', content: text }, isSidechain: false }; }
function assistantEntry(text) { return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }; }
function toolResultEntry() { return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, isSidechain: false }; }
function titleEntry(title, sessionId = 's1') { return { type: 'custom-title', customTitle: title, sessionId }; }
function aiTitleEntry(title, sessionId = 's1') { return { type: 'ai-title', aiTitle: title, sessionId }; }

function writeTranscript(dir, sessionId, entries) {
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

// Builds a temp CLAUDE_CONFIG_DIR with a projects subdir; returns { configDir, projectDir }
function fakeConfig() {
  const configDir = tmpDir();
  const projectDir = path.join(configDir, 'projects', '-Users-test');
  fs.mkdirSync(projectDir, { recursive: true });
  return { configDir, projectDir };
}

// Writes one session file into an existing store root, nested the two directory levels deep the app
// nests them. `spec` is 'user' | 'auto' | null - null omits titleSource entirely, the shape older
// app builds left behind - or an object overriding any of { titleSource, title, sessionId }.
// `slot` keeps two records in one store from colliding on a directory or a file name.
function appStoreRecord(root, cliSessionId, spec = null, slot = `x${Math.random().toString(36).slice(2)}`) {
  const dir = path.join(root, `outer-${slot}`, `inner-${slot}`);
  fs.mkdirSync(dir, { recursive: true });
  const o = spec && typeof spec === 'object' ? spec : { titleSource: spec };
  const record = {
    sessionId: o.sessionId === undefined ? `app-${slot}` : o.sessionId,
    cliSessionId,
    title: o.title === undefined ? `App title ${slot}` : o.title,
  };
  if (o.titleSource) record.titleSource = o.titleSource;
  fs.writeFileSync(path.join(dir, `local_${slot}.json`), JSON.stringify(record));
  return record;
}

// Builds a temp stand-in for the desktop app's session store, which nests one JSON file per session
// two directory levels deep. Takes { [cliSessionId]: spec }, with the spec shapes appStoreRecord
// accepts. Returns the root, which the caller points CLAUDE_SESSION_NAMER_APP_STORE at.
function fakeAppStore(entries = {}) {
  const root = tmpDir();
  let i = 0;
  for (const [cliSessionId, spec] of Object.entries(entries)) appStoreRecord(root, cliSessionId, spec, i++);
  return root;
}

module.exports = { tmpDir, userEntry, assistantEntry, toolResultEntry, titleEntry, aiTitleEntry, writeTranscript, fakeConfig, fakeAppStore, appStoreRecord };
