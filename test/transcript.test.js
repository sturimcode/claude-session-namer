const { test } = require('node:test');
const assert = require('node:assert');
const fx = require('./fixtures');
const t = require('../src/transcript');

test('readEntries parses JSONL and skips bad lines', () => {
  const dir = fx.tmpDir();
  const file = fx.writeTranscript(dir, 's1', [fx.userEntry('hello'), fx.assistantEntry('hi')]);
  require('node:fs').appendFileSync(file, 'not json\n');
  const entries = t.readEntries(file);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].message.content, 'hello');
});

test('readEntries skips non-object JSON lines and returns [] for a missing file', () => {
  const dir = fx.tmpDir();
  const file = fx.writeTranscript(dir, 's1', [fx.userEntry('hello')]);
  require('node:fs').appendFileSync(file, 'null\n"a string"\n[1,2]\n42\n');
  const entries = t.readEntries(file);
  assert.equal(entries.length, 1);
  assert.equal(t.countUserTurns(entries), 1);
  assert.deepEqual(t.readEntries(require('node:path').join(dir, 'nope.jsonl')), []);
});

test('malformed entries do not break turn extraction', () => {
  const dir = fx.tmpDir();
  const file = fx.writeTranscript(dir, 's1', [fx.userEntry('hello'), { type: 'user' }, { type: 'assistant' }, fx.assistantEntry('hi')]);
  require('node:fs').appendFileSync(file, 'null\n');
  const entries = t.readEntries(file);
  assert.equal(t.countUserTurns(entries), 1);
  assert.equal(t.firstUserText(entries), 'hello');
  assert.ok(t.buildExcerpt(entries).includes('hello'));
});

test('userText handles string, array, tool_result, meta and empty content', () => {
  assert.equal(t.userText(fx.userEntry('plain')), 'plain');
  assert.equal(t.userText({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'tool_result', content: 'ok' }, { type: 'text', text: 'b' }] } }), 'a\nb');
  assert.equal(t.userText(fx.toolResultEntry()), null);
  assert.equal(t.userText({ type: 'user' }), null);
  assert.equal(t.userText({ ...fx.userEntry('caveat'), isMeta: true }), null);
  assert.equal(t.userText(fx.userEntry('')), null);
  assert.equal(t.userText(fx.userEntry('   \n ')), null);
});

test('assistantText joins text parts, null when there are none', () => {
  assert.equal(t.assistantText(fx.assistantEntry('reply')), 'reply');
  assert.equal(t.assistantText({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }), 'a\nb');
  assert.equal(t.assistantText({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }), null);
  assert.equal(t.assistantText({ type: 'assistant' }), null);
  assert.equal(t.assistantText({ ...fx.assistantEntry('meta'), isMeta: true }), null);
});

test('currentTitle returns last custom-title, null when absent', () => {
  assert.equal(t.currentTitle([fx.userEntry('x')]), null);
  const entries = [fx.titleEntry('First'), fx.userEntry('x'), fx.titleEntry('Second')];
  assert.equal(t.currentTitle(entries), 'Second');
});

test('titleInfo prefers custom-title over ai-title regardless of order', () => {
  assert.deepEqual(t.titleInfo([fx.aiTitleEntry('Auto one'), fx.titleEntry('Mine')]), { title: 'Mine', source: 'custom' });
  assert.deepEqual(t.titleInfo([fx.titleEntry('Mine'), fx.aiTitleEntry('Auto one')]), { title: 'Mine', source: 'custom' });
  assert.equal(t.currentTitle([fx.titleEntry('Mine'), fx.aiTitleEntry('Auto one')]), 'Mine');
});

test('titleInfo returns the last ai-title when no custom-title exists', () => {
  const entries = [fx.aiTitleEntry('Auto one'), fx.userEntry('x'), fx.aiTitleEntry('Auto two')];
  assert.deepEqual(t.titleInfo(entries), { title: 'Auto two', source: 'ai' });
  assert.equal(t.currentTitle(entries), 'Auto two');
});

test('titleInfo returns nulls when no title record exists', () => {
  assert.deepEqual(t.titleInfo([fx.userEntry('x')]), { title: null, source: null });
});

test('countUserTurns counts real user text, not tool results or sidechains', () => {
  const side = { ...fx.userEntry('sub'), isSidechain: true };
  const entries = [fx.userEntry('a'), fx.toolResultEntry(), side, fx.assistantEntry('r'), fx.userEntry('b')];
  assert.equal(t.countUserTurns(entries), 2);
  assert.equal(t.firstUserText(entries), 'a');
});

test('isVagueTitle detects missing, New session, and truncated first-message titles', () => {
  assert.equal(t.isVagueTitle(null, 'anything'), true);
  assert.equal(t.isVagueTitle('New session', 'anything'), true);
  assert.equal(t.isVagueTitle('i need to write some sort of...', 'i need to write some sort of parser for this'), true);
  assert.equal(t.isVagueTitle('I need to write some', 'i need to write some sort of parser'), true);
  assert.equal(t.isVagueTitle('[Emails] SES bounce fix', 'i need to write some sort of parser'), false);
});

test('isVagueTitle ignores case, surrounding whitespace and trailing punctuation', () => {
  assert.equal(t.isVagueTitle('new session', 'anything'), true);
  assert.equal(t.isVagueTitle(' New session ', 'anything'), true);
  assert.equal(t.isVagueTitle('Write a parser… ', 'write a parser for the session file'), true);
  assert.equal(t.isVagueTitle('Write a parser....', 'write a parser for the session file'), true);
  assert.equal(t.isVagueTitle('   ', 'anything'), true);
  assert.equal(t.isVagueTitle('   ', null), true);
});

test('appendTitleRecord appends exactly one valid line', () => {
  const dir = fx.tmpDir();
  const file = fx.writeTranscript(dir, 's1', [fx.userEntry('hello')]);
  t.appendTitleRecord(file, 's1', '[Test] Hello session');
  const entries = t.readEntries(file);
  assert.equal(t.currentTitle(entries), '[Test] Hello session');
  const raw = require('node:fs').readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('\n'));
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).sessionId, 's1');
});

test('appendTitleRecord recovers when the file has no trailing newline', () => {
  const fs = require('node:fs');
  const dir = fx.tmpDir();
  const file = fx.writeTranscript(dir, 's1', [fx.userEntry('hello'), fx.assistantEntry('hi')]);
  // Simulate Claude Code mid-write / a truncated file: strip the trailing newline
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n$/, ''));
  t.appendTitleRecord(file, 's1', '[Test] Recovered');
  const entries = t.readEntries(file);
  assert.equal(t.currentTitle(entries), '[Test] Recovered');
  // The prior entries must survive - nothing concatenated onto the partial line
  assert.equal(t.countUserTurns(entries), 1);
  assert.equal(entries.length, 3);
});

test('buildExcerpt includes early and late turns within cap', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) { entries.push(fx.userEntry(`user message ${i} ` + 'x'.repeat(400))); entries.push(fx.assistantEntry(`reply ${i} ` + 'y'.repeat(400))); }
  const ex = t.buildExcerpt(entries, 4000);
  assert.ok(ex.length <= 4000);
  assert.ok(ex.includes('user message 0'));
  assert.ok(ex.includes('user message 29'));
});

test('buildExcerpt keeps the latest turns even at a small cap', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) { entries.push(fx.userEntry(`user message ${i} ` + 'x'.repeat(400))); entries.push(fx.assistantEntry(`reply ${i} ` + 'y'.repeat(400))); }
  const ex = t.buildExcerpt(entries, 1500);
  assert.ok(ex.length <= 1500);
  assert.ok(ex.includes('reply 29'), 'last turn must survive a small cap');
});

// The done judgment asks whether the work stopped, which is a fact about how a session ended - so it
// takes the tail alone, where a title needs the opening turns as well.
test('buildExcerpt can take the tail alone, and only claims a cut when there was one', () => {
  const t = require('../src/transcript');
  const entries = [];
  for (let i = 0; i < 10; i++) entries.push(fx.userEntry(`turn ${i}`));
  const tail = t.buildExcerpt(entries, 4000, { headTurns: 0, tailTurns: 3 });
  assert.equal(tail, '…\nUser: turn 7\nUser: turn 8\nUser: turn 9');
  // nothing was left out, so nothing pretends anything was
  const whole = t.buildExcerpt(entries.slice(0, 2), 4000, { headTurns: 0, tailTurns: 3 });
  assert.equal(whole, 'User: turn 0\nUser: turn 1');
  // and the default shape is untouched
  assert.equal(t.buildExcerpt(entries, 4000).startsWith('User: turn 0'), true);
});
