const { spawnSync } = require('node:child_process');
const os = require('node:os');

const MAX_TITLE_CHARS = 45;
// Only cut on a word boundary if the boundary is reasonably deep into the title -
// otherwise a short single-token title gets gutted down to a fragment.
const MIN_WORD_CUT_INDEX = 20;

// The prompt's opening line, exported so a sweep can recognize a transcript of one of our own
// worker calls and refuse to title it. Keep it the literal first line of buildPrompt's output.
const PROMPT_SIGNATURE = 'You title chat sessions between a developer and a coding assistant.';

const USE_PREFIX_EXAMPLES = [
  '[Emails] SES bounce rate investigation',
  '[Client Controls] Cascade validation rules',
  'KEEP',
];
const BARE_PHRASE_EXAMPLES = [
  'SES bounce rate investigation',
  'Cascade validation rules',
  'KEEP',
];

function buildPrompt({ currentTitle, prefixes = [], excerpt = '', usePrefix = true }) {
  const header = [`Current title: ${currentTitle ? currentTitle : '(none)'}`];
  if (usePrefix) {
    header.push(
      `Previously used prefixes (reuse one when it fits; coin a new one only for a genuinely different workstream): ${prefixes.length ? prefixes.join(', ') : '(none yet)'}`
    );
  }

  const rules = [
    usePrefix ? '- Output format: [Prefix] Short phrase' : '- Output format: Short phrase (no prefix, no brackets)',
  ];
  if (usePrefix) rules.push('- Prefix: 1-2 words naming the project or workstream');
  rules.push('- Max 45 characters total, sentence case phrase, no quotes, no trailing period');
  rules.push('- The title must describe what the session is mostly about NOW');
  rules.push(
    currentTitle
      ? '- If the current title still accurately describes the conversation, output exactly: KEEP'
      : '- There is no current title yet - you must produce one.'
  );
  rules.push('- If the excerpt has too little signal to describe the work, output exactly: KEEP');
  rules.push('- Output ONLY the title or KEEP - no preamble, no explanation, no markdown');

  const examples = usePrefix ? USE_PREFIX_EXAMPLES : BARE_PHRASE_EXAMPLES;

  return `${PROMPT_SIGNATURE}

${header.join('\n')}

Rules:
${rules.join('\n')}

Examples:
${examples.join('\n')}

Conversation excerpt:
${excerpt}`;
}

const stripQuotes = (s) => s.replace(/^["'`“‘]+|["'`”’]+$/g, '').trim();

function parseResponse(raw) {
  // Quote-strip per line before any detection: models wrap multi-line answers in a
  // single pair of quotes, so the closing quote can land on a later line.
  const lines = (typeof raw === 'string' ? raw : '')
    .split('\n')
    .map((l) => stripQuotes(l.trim()))
    .filter(Boolean);
  if (!lines.length) return 'KEEP';

  // KEEP wins whether the model leads with it plus an explanation, or parks a bare
  // "keep" on its own line. Always return the canonical uppercase literal.
  if (/^keep\b/i.test(lines[0]) || lines.some((l) => /^keep[.!\s]*$/i.test(l))) return 'KEEP';

  // Prefer a bracketed title that actually carries a phrase; otherwise the first line
  // that is not a preamble header like "Here is the title:".
  let s =
    lines.find((l) => /^\[[^\]]+\]\s*\S/.test(l)) ||
    lines.find((l) => !/[:：]$/.test(l)) ||
    lines[0];
  s = stripQuotes(s).replace(/[.\s]+$/, '');

  // Degenerate output - nothing, punctuation/symbols only, or a bare "[Prefix]".
  if (!s || /^[\s\p{P}\p{S}]*$/u.test(s) || /^\[[^\]]*\]$/.test(s)) return 'KEEP';

  const chars = [...s];
  if (chars.length > MAX_TITLE_CHARS) {
    let cut = chars.slice(0, MAX_TITLE_CHARS).join('');
    const sp = cut.lastIndexOf(' ');
    if (sp > MIN_WORD_CUT_INDEX) cut = cut.slice(0, sp);
    s = cut.trim();
  }
  return s || 'KEEP';
}

function runClaude(prompt, model, spawn = spawnSync) {
  const res = spawn('claude', ['-p', '--model', model], {
    input: prompt,
    encoding: 'utf8',
    cwd: os.tmpdir(),
    timeout: 90_000,
    env: { ...process.env, CLAUDE_SESSION_NAMER_WORKER: '1' },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const detail = String(res.stderr || '').trim().slice(0, 200);
    throw new Error(
      res.signal
        ? `claude killed by signal ${res.signal}: ${detail}`
        : `claude exited ${res.status}: ${detail}`
    );
  }
  return res.stdout;
}

function generateTitle({ currentTitle, prefixes, excerpt, usePrefix = true, model = 'haiku', runner = runClaude }) {
  return parseResponse(runner(buildPrompt({ currentTitle, prefixes, excerpt, usePrefix }), model));
}

module.exports = { buildPrompt, parseResponse, runClaude, generateTitle, PROMPT_SIGNATURE };
