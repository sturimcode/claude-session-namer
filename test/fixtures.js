const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'csn-test-')); }

function userEntry(text) { return { type: 'user', message: { role: 'user', content: text }, isSidechain: false }; }
function assistantEntry(text) { return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }; }
function toolResultEntry() { return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, isSidechain: false }; }
function titleEntry(title, sessionId = 's1') { return { type: 'custom-title', customTitle: title, sessionId }; }

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

module.exports = { tmpDir, userEntry, assistantEntry, toolResultEntry, titleEntry, writeTranscript, fakeConfig };
