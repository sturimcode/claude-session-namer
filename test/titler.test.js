const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
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

test('buildPrompt does not throw when prefixes and excerpt are omitted', () => {
  assert.doesNotThrow(() => titler.buildPrompt({ currentTitle: null }));
  assert.doesNotThrow(() => titler.buildPrompt({ currentTitle: 'X', usePrefix: false }));
  const p = titler.buildPrompt({ currentTitle: null });
  assert.ok(p.includes('(none yet)'));
});

test('buildPrompt only offers the KEEP-the-current-title rule when there is a current title', () => {
  const withTitle = titler.buildPrompt({ currentTitle: '[Emails] SES fix', prefixes: [], excerpt: 'x' });
  assert.ok(withTitle.includes('If the current title still accurately describes'));
  assert.ok(!withTitle.includes('There is no current title yet'));

  const without = titler.buildPrompt({ currentTitle: null, prefixes: [], excerpt: 'x' });
  assert.ok(!without.includes('If the current title still accurately describes'));
  assert.ok(without.includes('There is no current title yet - you must produce one.'));
});

// Nothing in a transcript record says whether a title is the app's own auto-title or a name the
// user typed, so the drift check itself has to spare a title that reads like a deliberate label.
test('buildPrompt protects deliberate personal labels, only when there is a current title', () => {
  const RULE = "- If the current title reads like a deliberate personal label rather than a topic description (a person's name, a date, a note like 'Revisit Monday'), output exactly: KEEP";
  for (const usePrefix of [true, false]) {
    const withTitle = titler.buildPrompt({ currentTitle: 'Revisit Monday', prefixes: [], excerpt: 'x', usePrefix });
    assert.ok(withTitle.includes(RULE), `missing in usePrefix=${usePrefix}`);
    const without = titler.buildPrompt({ currentTitle: null, prefixes: [], excerpt: 'x', usePrefix });
    assert.ok(!without.includes('deliberate personal label'), `present with no title, usePrefix=${usePrefix}`);
  }
});

test('buildPrompt bounds the prefix length only in usePrefix mode', () => {
  const on = titler.buildPrompt({ currentTitle: null, prefixes: [], excerpt: 'x' });
  assert.ok(on.includes('- Prefix: 1-2 words naming the project or workstream'));

  const off = titler.buildPrompt({ currentTitle: null, prefixes: [], excerpt: 'x', usePrefix: false });
  assert.ok(!off.includes('1-2 words naming the project'));
});

test('buildPrompt guards low-signal excerpts and forbids preamble in both modes', () => {
  for (const usePrefix of [true, false]) {
    const p = titler.buildPrompt({ currentTitle: null, prefixes: [], excerpt: 'x', usePrefix });
    assert.ok(p.includes('- If the excerpt has too little signal to describe the work, output exactly: KEEP'));
    assert.ok(p.includes('- Output ONLY the title or KEEP - no preamble, no explanation, no markdown'));
  }
});

test('buildPrompt appends an examples block matching the mode', () => {
  const on = titler.buildPrompt({ currentTitle: null, prefixes: [], excerpt: 'x' });
  assert.ok(on.includes('Examples:'));
  assert.ok(on.includes('[Emails] SES bounce rate investigation'));
  assert.ok(on.includes('[Client Controls] Cascade validation rules'));
  // Examples come after the rules, before the excerpt.
  assert.ok(on.indexOf('Examples:') > on.indexOf('Rules:'));
  assert.ok(on.indexOf('Examples:') < on.indexOf('Conversation excerpt:'));

  const off = titler.buildPrompt({ currentTitle: null, prefixes: [], excerpt: 'x', usePrefix: false });
  assert.ok(off.includes('Examples:'));
  assert.ok(off.includes('SES bounce rate investigation'));
  assert.ok(off.includes('Cascade validation rules'));
  assert.ok(!off.includes('[Emails]'));
  assert.ok(!off.includes('[Client Controls]'));
});

// The prefix setting is a format contract, so a title has to be checkable against it - that check is
// what tells the worker a title is accurate but in the wrong shape.
test('matchesFormat accepts only the prefix form when prefixes are on', () => {
  assert.equal(titler.matchesFormat('[Emails] SES bounce fix', true), true);
  assert.equal(titler.matchesFormat('[Client Controls] Cascade rules', true), true);
  assert.equal(titler.matchesFormat('SES bounce fix', true), false);
  assert.equal(titler.matchesFormat('Revisit Monday', true), false);
  // a bracket with nothing after it is not a title in the prefix form
  assert.equal(titler.matchesFormat('[Emails]', true), false);
  assert.equal(titler.matchesFormat('[Emails] ', true), false);
  // no space after the bracket, and an empty prefix
  assert.equal(titler.matchesFormat('[Emails]SES bounce fix', true), false);
  assert.equal(titler.matchesFormat('[] SES bounce fix', true), false);
  // a whole title parked in brackets is not a prefix
  assert.equal(titler.matchesFormat(`[${'a'.repeat(26)}] x`, true), false);
  assert.equal(titler.matchesFormat(`[${'a'.repeat(25)}] x`, true), true);
});

test('matchesFormat accepts only the bare form when prefixes are off', () => {
  assert.equal(titler.matchesFormat('SES bounce fix', false), true);
  assert.equal(titler.matchesFormat('Revisit Monday', false), true);
  assert.equal(titler.matchesFormat('[Emails] SES bounce fix', false), false);
  assert.equal(titler.matchesFormat('[Emails]', false), false);
  assert.equal(titler.matchesFormat('[] anything', false), false);
});

test('matchesFormat tolerates a missing or non-string title', () => {
  assert.equal(titler.matchesFormat(null, true), false);
  assert.equal(titler.matchesFormat(undefined, true), false);
  assert.equal(titler.matchesFormat(42, true), false);
  assert.equal(titler.matchesFormat('', true), false);
});

// Restyle mode is not a re-title: the title is right about the work, it just isn't in the shape the
// user asked for. So the meaning is preserved and KEEP stops being an available answer - keeping the
// title is the one thing that cannot fix its format.
test('buildPrompt in restyle mode asks for a reformat and drops every KEEP rule', () => {
  for (const usePrefix of [true, false]) {
    const p = titler.buildPrompt({ currentTitle: 'SES bounce fix', prefixes: ['Emails'], excerpt: 'User: hi', usePrefix, restyle: true });
    assert.ok(p.includes('The current title is accurate but in the wrong format - rewrite it into the required format, preserving its meaning'), `missing reformat rule, usePrefix=${usePrefix}`);
    assert.ok(p.includes('- Never output KEEP - always output a title'), `missing never-KEEP rule, usePrefix=${usePrefix}`);
    assert.ok(!p.includes('If the current title still accurately describes'), `drift KEEP rule present, usePrefix=${usePrefix}`);
    assert.ok(!p.includes('deliberate personal label'), `personal-label KEEP rule present, usePrefix=${usePrefix}`);
    assert.ok(!p.includes('output exactly: KEEP'), `a KEEP instruction survived, usePrefix=${usePrefix}`);
    assert.ok(!p.includes('There is no current title yet'), `no-title rule present, usePrefix=${usePrefix}`);
    // KEEP can't stand as an example of an answer it can't give
    assert.ok(!/^KEEP$/m.test(p), `KEEP example present, usePrefix=${usePrefix}`);
    // the title, the excerpt, and the length cap still carry
    assert.ok(p.includes('SES bounce fix'));
    assert.ok(p.includes('User: hi'));
    assert.ok(p.includes('45'));
  }
});

test('buildPrompt in restyle mode points the excerpt at the format, per mode', () => {
  const on = titler.buildPrompt({ currentTitle: 'SES bounce fix', prefixes: ['Emails'], excerpt: 'x', restyle: true });
  assert.ok(on.includes('- Output format: [Prefix] Short phrase'));
  assert.ok(on.includes('- Use the conversation excerpt only to choose the right prefix - do not re-describe the work'));
  assert.ok(on.includes('Emails')); // the learned prefixes are what it picks from

  const off = titler.buildPrompt({ currentTitle: '[Emails] SES bounce fix', prefixes: ['Emails'], excerpt: 'x', usePrefix: false, restyle: true });
  assert.ok(off.includes('- Output format: Short phrase (no prefix, no brackets)'));
  assert.ok(off.includes('drop the prefix'));
});

test('buildPrompt without restyle is unchanged - the KEEP rules stand', () => {
  const p = titler.buildPrompt({ currentTitle: 'SES bounce fix', prefixes: [], excerpt: 'x' });
  assert.ok(p.includes('If the current title still accurately describes'));
  assert.ok(!p.includes('rewrite it into the required format'));
  assert.ok(/^KEEP$/m.test(p));
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

test('parseResponse skips a preamble line and picks the bracketed title', () => {
  assert.equal(titler.parseResponse('Here is the title:\n[Emails] Fix'), '[Emails] Fix');
  assert.equal(titler.parseResponse('Sure! Here you go:\n\n[Client Controls] Cascade rules\n'), '[Client Controls] Cascade rules');
});

test('parseResponse falls back to the first non-colon line when nothing is bracketed', () => {
  assert.equal(titler.parseResponse('Here is the title:\nSES bounce rate fix'), 'SES bounce rate fix');
  // Every line ends in a colon - fall back to the first line.
  assert.equal(titler.parseResponse('Title:\nSummary:'), 'Title:');
});

test('parseResponse canonicalizes KEEP plus an explanation', () => {
  assert.equal(titler.parseResponse('KEEP - explanation'), 'KEEP');
  assert.equal(titler.parseResponse('Keep, the title is still accurate'), 'KEEP');
  assert.equal(titler.parseResponse('keep.'), 'KEEP');
});

test('parseResponse canonicalizes lowercase keep followed by chatter', () => {
  assert.equal(titler.parseResponse('keep\nthe current title still fits'), 'KEEP');
  assert.equal(titler.parseResponse('The title is fine.\nkeep'), 'KEEP');
  assert.equal(titler.parseResponse('The title is fine.\nKEEP!'), 'KEEP');
});

test('parseResponse rejects a bare prefix with no phrase', () => {
  assert.equal(titler.parseResponse('[Emails]'), 'KEEP');
  assert.equal(titler.parseResponse('  "[Emails]"  '), 'KEEP');
  assert.equal(titler.parseResponse('[]'), 'KEEP');
});

test('parseResponse rejects punctuation- and symbol-only output', () => {
  assert.equal(titler.parseResponse('.'), 'KEEP');
  assert.equal(titler.parseResponse('...'), 'KEEP');
  assert.equal(titler.parseResponse('---'), 'KEEP');
  assert.equal(titler.parseResponse('***'), 'KEEP');
});

test('parseResponse passes an exactly-45-character title through untouched', () => {
  const exact = '[Emails] ' + 'a'.repeat(36);
  assert.equal(exact.length, 45);
  assert.equal(titler.parseResponse(exact), exact);
});

test('parseResponse clamps unicode by codepoint without splitting surrogate pairs', () => {
  const out = titler.parseResponse('[Emails] ' + '\u{1F680}'.repeat(40));
  assert.ok([...out].length <= 45);
  // A lone surrogate would not survive a codepoint round-trip.
  assert.equal(out, [...out].join(''));
  assert.ok(!/[\uD800-\uDFFF]/.test(out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')));
});

test('parseResponse strips quotes per line, including a trailing quote on a later line', () => {
  assert.equal(titler.parseResponse('"Here is the title:\n[Emails] SES bounce fix"'), '[Emails] SES bounce fix');
  assert.equal(titler.parseResponse('“[Emails] SES bounce fix”'), '[Emails] SES bounce fix');
  assert.equal(titler.parseResponse('‘SES bounce fix’'), 'SES bounce fix');
});

test('parseResponse strips trailing periods and whitespace', () => {
  assert.equal(titler.parseResponse('[Emails] SES bounce fix.'), '[Emails] SES bounce fix');
  assert.equal(titler.parseResponse('SES bounce fix ...  '), 'SES bounce fix');
});

test('parseResponse tolerates non-string input', () => {
  assert.equal(titler.parseResponse(null), 'KEEP');
  assert.equal(titler.parseResponse(undefined), 'KEEP');
  assert.equal(titler.parseResponse(42), 'KEEP');
});

function fakeSpawn(result) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  fn.calls = calls;
  return fn;
}

test('runClaude spawns claude with the worker env, tmpdir cwd, timeout and piped prompt', () => {
  const spawn = fakeSpawn({ status: 0, stdout: '[Emails] SES fix', stderr: '' });
  const out = titler.runClaude('the prompt', 'haiku', spawn);
  assert.equal(out, '[Emails] SES fix');
  assert.equal(spawn.calls.length, 1);
  const { cmd, args, opts } = spawn.calls[0];
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, ['-p', '--model', 'haiku']);
  assert.equal(opts.env.CLAUDE_SESSION_NAMER_WORKER, '1');
  assert.equal(opts.cwd, os.tmpdir());
  assert.equal(opts.timeout, 90000);
  assert.equal(opts.input, 'the prompt');
  assert.equal(opts.encoding, 'utf8');
});

test('runClaude throws on a non-zero exit status', () => {
  const spawn = fakeSpawn({ status: 2, stdout: '', stderr: 'boom' });
  assert.throws(() => titler.runClaude('p', 'haiku', spawn), /exited 2/);
});

test('runClaude throws the spawn error when the child fails to start', () => {
  const err = new Error('ENOENT');
  const spawn = fakeSpawn({ error: err });
  assert.throws(() => titler.runClaude('p', 'haiku', spawn), /ENOENT/);
});

test('runClaude reports a signal-killed child and truncates stderr', () => {
  const spawn = fakeSpawn({ status: null, signal: 'SIGTERM', stdout: '', stderr: 'x'.repeat(5000) });
  let message = '';
  assert.throws(() => titler.runClaude('p', 'haiku', spawn), (e) => { message = e.message; return true; });
  assert.ok(message.includes('SIGTERM'));
  assert.ok(message.length < 400, `message was ${message.length} chars`);
});

test('generateTitle uses injected runner', () => {
  const runner = (prompt, model) => { assert.equal(model, 'haiku'); return '[Test] A generated title'; };
  const out = titler.generateTitle({ currentTitle: null, prefixes: [], excerpt: 'User: x', runner });
  assert.equal(out, '[Test] A generated title');
});
