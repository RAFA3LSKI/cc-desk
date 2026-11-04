// Edits a whitelist of keys in ~/.claude/settings.json; every other key (hooks, permission rules...) is kept as is.
const fs = require('fs'), path = require('path'), os = require('os');
const FILE = path.join(os.homedir(), '.claude/settings.json');
const DESK = path.join(os.homedir(), '.claude-desk.json');
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

const oneOf = list => v => list.includes(v);
const bool = v => typeof v === 'boolean';
const ALLOWED = {
  model: oneOf(['opus', 'sonnet', 'haiku']),
  effortLevel: oneOf(['low', 'medium', 'high', 'xhigh', 'max']),
  theme: oneOf(['dark', 'light']),
  autoCompactEnabled: bool,
  inputNeededNotifEnabled: bool,
  agentPushNotifEnabled: bool,
  'permissions.defaultMode': oneOf(['default', 'acceptEdits', 'plan', 'bypassPermissions']),
};

function get() {
  const s = read(FILE);
  return { claude: s, desk: { notify: true, tips: true, fontSize: 13, ...read(DESK) } };
}

function set(key, value) {
  if (key.startsWith('desk.')) {
    const k = key.slice(5), d = read(DESK);
    if (!((k === 'notify' || k === 'tips') && bool(value)) && !(k === 'fontSize' && Number.isInteger(value) && value >= 10 && value <= 22))
      throw new Error('bad app setting');
    d[k] = value; fs.writeFileSync(DESK, JSON.stringify(d, null, 2)); return;
  }
  const isPlugin = key.startsWith('enabledPlugins.');
  if (!(isPlugin ? bool(value) : ALLOWED[key] && ALLOWED[key](value))) throw new Error('not allowed: ' + key);
  const s = read(FILE);
  if (!Object.keys(s).length) throw new Error('settings.json unreadable, not writing');
  const backup = FILE + '.desk-backup-' + new Date().toISOString().slice(0, 10);
  if (!fs.existsSync(backup)) fs.copyFileSync(FILE, backup);
  if (isPlugin) {
    const name = key.slice('enabledPlugins.'.length);
    if (!s.enabledPlugins || !(name in s.enabledPlugins)) throw new Error('unknown plugin');
    s.enabledPlugins[name] = value;
  } else if (key === 'permissions.defaultMode') {
    s.permissions = { ...(s.permissions || {}), defaultMode: value };
  } else {
    s[key] = value;
    // per-model effort overrides would silently win over the top-level one
    if (key === 'effortLevel' && s.modelSettings) for (const m of Object.values(s.modelSettings)) if (m && 'effortLevel' in m) m.effortLevel = value;
  }
  const tmp = FILE + '.desk-tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n'); fs.renameSync(tmp, FILE);
}

module.exports = { get, set, FILE };
