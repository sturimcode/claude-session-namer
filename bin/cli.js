#!/usr/bin/env node
const commands = ['install', 'uninstall', 'hook', 'worker', 'backfill', 'rename', 'protect', 'unprotect', 'list', 'search', 'config', 'sync-plan', 'sidebar-setup'];
const cmd = process.argv[2];

const help = `claude-session-namer - auto-title Claude Code sessions

Usage: claude-session-namer <command>

  install     Register the Stop hook in Claude Code settings
  uninstall   Remove the Stop hook
  backfill    Title existing vague/untitled sessions - by default the 50 newest from
              the last 30 days (--since <days>, --limit <n>, --all for full history,
              --dry-run, --model <m>, --project <path>)
              (--dry-run still calls the model per session)
  rename      Set a session title by hand: rename <session-id> "title"
  protect     Keep a session's current title as it is: protect <session-id>
  unprotect   Allow re-titling again: unprotect <session-id>
  list        List sessions with titles (--project <path>)
  search      Find sessions by title or content: search <query>
  config      Show or change settings: config [prefix on|off] [model haiku|sonnet]
  sync-plan   Print the titles the desktop app's sidebar is missing, as JSON
              lines for an agent to push through the app (--all)
  sidebar-setup
              Print the prompt that sets up hourly sidebar syncing, to paste
              into a Claude Code desktop session
`;

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') { process.stdout.write(help); return; }
  if (cmd === '--version') { process.stdout.write(require('../package.json').version + '\n'); return; }
  if (!commands.includes(cmd)) { process.stderr.write(`Unknown command: ${cmd}\n${help}`); process.exitCode = 1; return; }
  if (cmd === 'hook') return require('../src/hook').run();
  if (cmd === 'worker') return require('../src/worker').runFromArgs(process.argv.slice(3));
  if (cmd === 'install') return require('../src/settings').install(process.argv.slice(3));
  if (cmd === 'uninstall') return require('../src/settings').uninstall();
  return require('../src/commands')[cmd](process.argv.slice(3));
}
// Errors we raise on purpose (a corrupt settings.json, a hooks block we refuse to edit) are
// instructions to the user, so they print as a plain message. Anything else is a bug and keeps its
// stack. Either way the exit code is 1 - set, not forced, because process.exit() can truncate a
// message still buffered on a piped stderr.
main().catch((err) => {
  process.stderr.write((err && err.expected ? err.message : String(err && err.stack || err)) + '\n');
  process.exitCode = 1;
});
