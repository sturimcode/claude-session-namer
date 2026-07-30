const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const commands = require('../src/commands');
const { SIDEBAR_TASK_PROMPT, SIDEBAR_PASTE_BLOCK } = commands;

const root = path.join(__dirname, '..');
const SKILL_PATH = path.join(root, 'skills', 'setup-sidebar-sync', 'SKILL.md');
const skill = () => fs.readFileSync(SKILL_PATH, 'utf8');

async function capture(fn) {
  const orig = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try { await fn(); } finally { process.stdout.write = orig; }
  return out;
}

async function captureErr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { await fn(); } finally { process.stderr.write = orig; }
  return out;
}

// The skill is a plugin component, so its whole contract with Claude Code is the path it sits at and
// the frontmatter at the top of the file. Neither is exercised by any code here, which is exactly why
// they get a test: a rename or a stray indent turns the skill into an inert markdown file.
test('the setup skill sits where a plugin loads skills from', () => {
  assert.ok(fs.existsSync(SKILL_PATH), 'plugins load skills from <root>/skills/<name>/SKILL.md');
});

test('the setup skill opens with frontmatter naming it and saying when to use it', () => {
  const text = skill();
  assert.ok(text.startsWith('---\n'), 'frontmatter has to be the first thing in the file');
  const end = text.indexOf('\n---\n', 3);
  assert.ok(end > 0, 'the frontmatter block must be closed');
  const front = text.slice(4, end);
  // In a plugin skill the frontmatter name is the last segment of the command, so it is the one
  // field that changes what the user types.
  assert.match(front, /^name: setup-sidebar-sync$/m);
  const description = (front.match(/^description: (.+)$/m) || [])[1];
  assert.ok(description, 'without a description Claude has nothing to trigger on');
  // The phrases the user actually says. Claude picks the skill off this line alone.
  for (const phrase of ['sidebar', 'sync', 'title']) {
    assert.ok(description.toLowerCase().includes(phrase), `the description should mention "${phrase}"`);
  }
});

test('the skill hands over the same task prompt the CLI prints', () => {
  // The prompt exists in two places by necessity - the skill Claude reads and the block a user
  // pastes - and a routine created from a drifted copy is a routine nobody reviewed.
  assert.ok(skill().includes(SIDEBAR_TASK_PROMPT), 'the skill must carry the task prompt verbatim');
  assert.ok(SIDEBAR_PASTE_BLOCK.includes(SIDEBAR_TASK_PROMPT), 'the paste block must carry it too');
});

test('the task prompt keeps every rule that makes the routine safe to run unattended', () => {
  // Each of these is a line the routine cannot lose without becoming dangerous or wrong.
  assert.match(SIDEBAR_TASK_PROMPT, /claude-session-namer sync-plan/);
  assert.match(SIDEBAR_TASK_PROMPT, /do NOT pass `--all`/, 'a sync that pushes over user renames is the one unacceptable outcome');
  assert.match(SIDEBAR_TASK_PROMPT, /set_session_title/, 'the app rename tool is the only writer');
  assert.match(SIDEBAR_TASK_PROMPT, /Stop immediately on the first error/, 'no retries, no continuing past a failure');
  assert.match(SIDEBAR_TASK_PROMPT, /no-op unless the user turned done markers on/, 'the model-calling sweep must stay behind its opt-in');
  assert.match(SIDEBAR_TASK_PROMPT, /Never archive the current session/, 'cleanup must not eat the run doing the cleaning');
  assert.match(SIDEBAR_TASK_PROMPT, /Take no actions beyond these/, 'the action list is closed, not illustrative');
  assert.match(SIDEBAR_TASK_PROMPT, /Never run backfill/, 'an unscoped model-calling sweep is not what the user signed up for');
  assert.match(SIDEBAR_TASK_PROMPT, /never delete anything/, 'archive is the ceiling; deletion never');
});

// ${CLAUDE_PLUGIN_ROOT} resolves in plugin components - hook and monitor commands, MCP and LSP
// configs, and the plugin's own skill content. A scheduled task's prompt is none of those: it lives
// in the app's own task store, so the placeholder would reach the Bash tool as an unset shell
// variable and run `node "/bin/cli.js"`. The bare command is what works on both install paths -
// npm puts it on the shell PATH, and an enabled plugin's bin/ is on the Bash tool's PATH.
test('the task prompt invokes the CLI by name, with no plugin-root placeholder', () => {
  assert.ok(!SIDEBAR_TASK_PROMPT.includes('CLAUDE_PLUGIN_ROOT'), 'the placeholder does not expand inside a scheduled task');
  assert.ok(!skill().includes('${CLAUDE_PLUGIN_ROOT}/bin/cli.js'), 'nor should the skill suggest it');
});

test('the skill pins the task id and the hourly schedule', () => {
  const text = skill();
  assert.ok(text.includes('session-title-sidebar-sync'), 'a fixed id is what keeps a second setup run from duplicating the task');
  assert.ok(text.includes('2 * * * *'), 'hourly, off the top of the hour');
  assert.ok(SIDEBAR_PASTE_BLOCK.includes('session-title-sidebar-sync'));
  assert.ok(SIDEBAR_PASTE_BLOCK.includes('2 * * * *'));
});

test('the skill confirms with the user, checks for an existing task, and stops where it does not apply', () => {
  const text = skill();
  assert.match(text, /confirm/i, 'nothing is created before the user says yes');
  assert.match(text, /existing scheduled tasks/i, 'an id that already exists is updated, not duplicated');
  assert.match(text, /macOS/, 'the app store this depends on is macOS-only');
  assert.match(text, /stop/i, 'no desktop app means say so and stop');
});

// The app's task registry holds the cron schedule and the permissions the user approved. We supply
// instructions and let the app write it; a file we wrote would carry neither.
test('the skill routes creation through the app rather than writing the task registry', () => {
  const text = skill();
  assert.match(text, /scheduled-task tool/, 'the app creates its own routines');
  assert.ok(!/write[^.\n]*scheduled-tasks\//i.test(text), 'never instruct a write into the app registry');
});

// Field report: the "run it once now" step led an agent to fire the task through the app's own
// scheduler with a one-time fireAt, which per the app's contract replaces the cron schedule and
// auto-disables the task once it has run. Sidebar sync was silently dead for two hours. The test is
// what the setup can never do, and both copies of the instructions have to carry it.
test('both setup paths run the test inline and forbid a scheduled one-time fire', () => {
  for (const [name, text] of [['skill', skill()], ['paste block', SIDEBAR_PASTE_BLOCK]]) {
    assert.match(text, /fireAt/, `${name}: the mechanism that broke it has to be named to be ruled out`);
    assert.match(text, /Never test it by scheduling the task to fire/, `${name}: the rule itself`);
    assert.match(text, /cron schedule/, `${name}: say what a one-time fire costs`);
    assert.match(text, /disables itself/, `${name}: and that the task does not come back on its own`);
    // The test run is the task's own steps, done here and now.
    assert.match(text, /in this session/, `${name}: inline is the only sanctioned test`);
    assert.match(text, /sweep-done/, `${name}: the inline run covers the whole prompt, not just sync-plan`);
  }
});

test('the skill tells an update never to carry a one-time fire time', () => {
  assert.match(skill(), /Never pass `fireAt` on an update/);
  assert.match(SIDEBAR_PASTE_BLOCK, /never pass `fireAt` on that update/);
});

test('sidebar-setup prints the paste block and nothing else', async () => {
  const out = await capture(() => commands['sidebar-setup']([]));
  assert.equal(out, SIDEBAR_PASTE_BLOCK);
  assert.ok(out.endsWith('\n'), 'terminal output ends on a newline');
});

test('sidebar-setup rejects an argument rather than ignoring it', async () => {
  const prevExit = process.exitCode;
  let out = '';
  const err = await captureErr(async () => { out = await capture(() => commands['sidebar-setup'](['--now'])); });
  assert.equal(out, '', 'a usage error prints no block');
  assert.match(err, /Unknown option: --now/);
  assert.equal(process.exitCode, 1);
  process.exitCode = prevExit;
});

test('the cli knows the sidebar-setup command and lists it in the help', () => {
  const cli = fs.readFileSync(path.join(root, 'bin', 'cli.js'), 'utf8');
  assert.match(cli, /'sidebar-setup'/, 'an unlisted command is rejected as unknown');
  assert.match(cli, /^ {2}sidebar-setup/m, 'and an unlisted command in the help is one nobody finds');
});
