const { test } = require('node:test');
const assert = require('node:assert');
const titler = require('../src/titler');

test('buildPrompt includes title, prefixes, excerpt, and rules', () => {
  const p = titler.buildPrompt({ currentTitle: '[Emails] SES fix', prefixes: ['Emails', 'CSA'], excerpt: 'User: hello' });
  assert.ok(p.includes('[Emails] SES fix'));
  assert.ok(p.includes('Emails, CSA'));
  assert.ok(p.includes('User: hello'));
  assert.ok(p.includes('45'));
  assert.ok(p.includes('KEEP'));
});

test('buildPrompt handles no current title and no prefixes', () => {
  const p = titler.buildPrompt({ currentTitle: null, prefixes: [], excerpt: 'User: hi' });
  assert.ok(p.includes('(none)'));
});

test('buildPrompt with usePrefix false asks for bare phrase, no prefix list', () => {
  const p = titler.buildPrompt({ currentTitle: null, prefixes: ['Emails'], excerpt: 'User: hi', usePrefix: false });
  assert.ok(!p.includes('[Prefix]'));
  assert.ok(!p.includes('Emails'));
});

test('parseResponse handles KEEP, quotes, whitespace, overlength', () => {
  assert.equal(titler.parseResponse('KEEP'), 'KEEP');
  assert.equal(titler.parseResponse('  KEEP \n'), 'KEEP');
  assert.equal(titler.parseResponse('"[Emails] SES bounce fix"'), '[Emails] SES bounce fix');
  assert.equal(titler.parseResponse(''), 'KEEP');
  const long = titler.parseResponse('[Emails] ' + 'word '.repeat(20));
  assert.ok(long.length <= 45);
  assert.ok(!long.endsWith(' '));
});

test('generateTitle uses injected runner', () => {
  const runner = (prompt, model) => { assert.equal(model, 'haiku'); return '[Test] A generated title'; };
  const out = titler.generateTitle({ currentTitle: null, prefixes: [], excerpt: 'User: x', runner });
  assert.equal(out, '[Test] A generated title');
});
