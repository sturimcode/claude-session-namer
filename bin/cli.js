#!/usr/bin/env node
const commands = ['install', 'uninstall', 'hook', 'worker', 'backfill', 'rename', 'list', 'search', 'config'];
const cmd = process.argv[2];

const help = `claude-session-namer - auto-title Claude Code sessions

Usage: claude-session-namer <command>

  install     Register the Stop hook in Claude Code settings
  uninstall   Remove the Stop hook
  backfill    Title all existing vague/untitled sessions (--dry-run, --model <m>, --project <path>)
  rename      Set a session title by hand: rename <session-id> "title"
  list        List sessions with titles (--project <path>)
  search      Find sessions by title or content: search <query>
  config      Show or change settings: config [prefix on|off]
`;

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') { process.stdout.write(help); return; }
  if (cmd === '--version') { process.stdout.write(require('../package.json').version + '\n'); return; }
  if (!commands.includes(cmd)) { process.stderr.write(`Unknown command: ${cmd}\n${help}`); process.exit(1); }
  if (cmd === 'hook') return require('../src/hook').run();
  if (cmd === 'worker') return require('../src/worker').runFromArgs(process.argv.slice(3));
  if (cmd === 'install') return require('../src/settings').install(process.argv.slice(3));
  if (cmd === 'uninstall') return require('../src/settings').uninstall();
  return require('../src/commands')[cmd](process.argv.slice(3));
}
main().catch((err) => { process.stderr.write(String(err && err.stack || err) + '\n'); process.exit(1); });
