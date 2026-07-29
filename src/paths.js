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

module.exports = { claudeDir, projectsDir, stateDir, stateFile, configFile, settingsFile, hookScript, appStoreDir };
