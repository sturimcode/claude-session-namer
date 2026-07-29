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
});

test('currentTitle returns last custom-title, null when absent', () => {
  assert.equal(t.currentTitle([fx.userEntry('x')]), null);
  const entries = [fx.titleEntry('First'), fx.userEntry('x'), fx.titleEntry('Second')];
  assert.equal(t.currentTitle(entries), 'Second');
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

test('buildExcerpt includes early and late turns within cap', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) { entries.push(fx.userEntry(`user message ${i} ` + 'x'.repeat(400))); entries.push(fx.assistantEntry(`reply ${i} ` + 'y'.repeat(400))); }
  const ex = t.buildExcerpt(entries, 4000);
  assert.ok(ex.length <= 4000);
  assert.ok(ex.includes('user message 0'));
  assert.ok(ex.includes('user message 29'));
});
