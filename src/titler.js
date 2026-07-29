const { spawnSync } = require('node:child_process');
const os = require('node:os');

function buildPrompt({ currentTitle, prefixes, excerpt, usePrefix = true }) {
  const prefixLine = usePrefix
    ? `Previously used prefixes (reuse one when it fits; coin a new one only for a genuinely different workstream): ${prefixes.length ? prefixes.join(', ') : '(none yet)'}\n`
    : '';
  const formatRule = usePrefix ? '- Output format: [Prefix] Short phrase' : '- Output format: Short phrase (no prefix, no brackets)';
  return `You title chat sessions between a developer and a coding assistant.

Current title: ${currentTitle ? currentTitle : '(none)'}
${prefixLine}
Rules:
${formatRule}
- Max 45 characters total, sentence case phrase, no quotes, no trailing period
- The title must describe what the session is mostly about NOW
- If the current title still accurately describes the conversation, output exactly: KEEP
- Output ONLY the title or KEEP - nothing else

Conversation excerpt:
${excerpt}`;
}

function parseResponse(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s || /^keep$/i.test(s)) return 'KEEP';
  s = s.split('\n')[0].trim();
  if (s.length > 45) {
    s = s.slice(0, 45);
    const cut = s.lastIndexOf(' ');
    if (cut > 20) s = s.slice(0, cut);
    s = s.trim();
  }
  return s || 'KEEP';
}

function runClaude(prompt, model) {
  const res = spawnSync('claude', ['-p', '--model', model], {
    input: prompt,
    encoding: 'utf8',
    cwd: os.tmpdir(),
    timeout: 90_000,
    env: { ...process.env, CLAUDE_SESSION_NAMER_WORKER: '1' },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`claude exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

function generateTitle({ currentTitle, prefixes, excerpt, usePrefix = true, model = 'haiku', runner = runClaude }) {
  return parseResponse(runner(buildPrompt({ currentTitle, prefixes, excerpt, usePrefix }), model));
}

module.exports = { buildPrompt, parseResponse, runClaude, generateTitle };
