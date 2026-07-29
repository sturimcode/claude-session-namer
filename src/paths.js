const os = require('node:os');
const path = require('node:path');

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(claudeDir(), 'projects');
const stateDir = () => path.join(claudeDir(), 'claude-session-namer');
const stateFile = () => path.join(stateDir(), 'state.json');
const configFile = () => path.join(stateDir(), 'config.json');
const settingsFile = () => path.join(claudeDir(), 'settings.json');
const hookScript = () => path.join(stateDir(), 'hook.sh');

module.exports = { claudeDir, projectsDir, stateDir, stateFile, configFile, settingsFile, hookScript };
