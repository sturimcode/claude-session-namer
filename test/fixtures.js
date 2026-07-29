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

// Builds a temp stand-in for the desktop app's session store, which nests one JSON file per session
// two directory levels deep. Takes { [cliSessionId]: 'user' | 'auto' | null }, where null writes a
// file with no titleSource field at all - the shape older app builds left behind. Returns the root,
// which the caller points CLAUDE_SESSION_NAMER_APP_STORE at.
function fakeAppStore(entries = {}) {
  const root = tmpDir();
  let i = 0;
  for (const [cliSessionId, titleSource] of Object.entries(entries)) {
    const dir = path.join(root, `outer-${i}`, `inner-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const record = { sessionId: `app-${i}`, cliSessionId, title: `App title ${i}` };
    if (titleSource) record.titleSource = titleSource;
    fs.writeFileSync(path.join(dir, `local_${i}.json`), JSON.stringify(record));
    i++;
  }
  return root;
}

module.exports = { tmpDir, userEntry, assistantEntry, toolResultEntry, titleEntry, aiTitleEntry, writeTranscript, fakeConfig, fakeAppStore };
