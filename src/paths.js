const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(claudeDir(), 'projects');
const stateDir = () => path.join(claudeDir(), 'claude-session-namer');
const stateFile = () => path.join(stateDir(), 'state.json');
const configFile = () => path.join(stateDir(), 'config.json');
const settingsFile = () => path.join(claudeDir(), 'settings.json');
const hookScript = () => path.join(stateDir(), 'hook.sh');

// The desktop app's own session store, one JSON file per session, nested two directory levels deep.
// It is the app's private data, not ours - we only read it, and only for the titleSource marker.
// The env var exists so the tests can point at a fixture; nothing else sets it.
const appStoreDir = () => process.env.CLAUDE_SESSION_NAMER_APP_STORE
  || path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

// How Claude Code names the project dir a session's transcript goes into: the session's cwd with
// every non-alphanumeric character replaced by a dash. One copy of the rule, because both the sweeps'
// tmpdir exclusion and the project signal below depend on encoding a path the same way.
const encodePath = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

// Encode where a path really is: on macOS /var is a symlink to /private/var and Claude Code encodes
// the resolved path. Best-effort - a path that can't be resolved is encoded as given, which is the
// right answer whenever it isn't a link.
const encodeResolved = (p) => { try { return encodePath(fs.realpathSync(p)); } catch { return encodePath(p); } };

// No signal, which every unreadable case reads as. It is deliberately the same answer as "the home
// directory": a title with no prefix is the safe output when we cannot tell where a session ran, and
// the wrong prefix is the failure this whole signal exists to stop.
const NO_PROJECT = Object.freeze({ inProject: false, dir: null, hint: null });

// What an encoded cwd looks like: alphanumerics and dashes, with at least one dash, because the
// leading separator of an absolute path always encodes to one. A stray file at the projects root,
// a relative path, '.', or anything else is not a name we can read anything off.
const ENCODED_DIR = /^[A-Za-z0-9]*-[A-Za-z0-9-]*$/;

// How long a hint is allowed to be before the prompt boundary trims it further. A deep path can
// encode to a very long dir name, and this is one parenthetical on one line of a prompt.
const HINT_MAX = 60;

// A readable stand-in for a project directory, for a prompt to name it by. The encoding is lossy -
// '/' and '-' both became '-' - so the tail can never be turned back into a path, and this does not
// try: it reads the first segment below home as the enclosing folder and leaves the rest as one
// name, which is the shape almost every project directory has ('~/projects/claude-session-namer'
// encodes to '-Users-x-projects-claude-session-namer' and reads back as
// 'projects/claude-session-namer'). A deeper path renders flatter than it is. These are words for a
// prompt, never a path anything opens.
function dirHint(dir, opts = {}) {
  if (typeof dir !== 'string' || !dir) return null;
  const home = opts.home || os.homedir();
  let tail = dir;
  for (const h of [encodePath(home), encodeResolved(home)]) {
    if (h && dir.startsWith(h + '-')) { tail = dir.slice(h.length + 1); break; }
  }
  tail = tail.replace(/^-+|-+$/g, '');
  if (!tail) return null;
  const cut = tail.indexOf('-');
  return (cut > 0 ? `${tail.slice(0, cut)}/${tail.slice(cut + 1)}` : tail).slice(0, HINT_MAX);
}

// Which project a session belongs to, read off the one place on disk that records it: a transcript
// lives at <projectsDir>/<encoded-cwd>/<id>.jsonl, so the dir name is the session's working
// directory. That answers the question a prefix asks. A session run from the home directory belongs
// to no project - it can be about anything - so a prefix on its title could only have been borrowed
// from other work, which is exactly what was observed in the field ('[Domestique] Cat house
// comparison', where Domestique is an unrelated website project).
// Returns { inProject, dir, hint }: `dir` is the encoded name, which is what state matches on, and
// `hint` is words for a prompt. Purely a string read - no filesystem walk, no app store - so it
// costs nothing on the hook path and works the same on a machine that has only ever run the CLI.
function projectSignal(transcriptPath, opts = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return NO_PROJECT;
  const home = opts.home || os.homedir();
  const dir = path.basename(path.dirname(transcriptPath));
  if (!ENCODED_DIR.test(dir)) return NO_PROJECT;
  if ([encodePath(home), encodeResolved(home)].includes(dir)) return NO_PROJECT;
  // Our own headless calls run from the OS temp dir, so Claude Code files their transcripts under
  // the encoded tmpdir - the dir the sweeps already exclude. Nothing about those is a project
  // either, and reading one as such would put a prefix from the temp dir into the prefix list.
  const tmp = os.tmpdir();
  if ([encodePath(tmp), encodeResolved(tmp)].includes(dir)) return NO_PROJECT;
  return { inProject: true, dir, hint: dirHint(dir, { home }) };
}

module.exports = {
  claudeDir, projectsDir, stateDir, stateFile, configFile, settingsFile, hookScript, appStoreDir,
  encodePath, projectSignal, dirHint,
};
