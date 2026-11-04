// Edits a whitelist of keys in ~/.claude/settings.json; every other key (hooks, permission rules...) is kept as is.
const fs = require('fs'), path = require('path'), os = require('os');
const FILE = path.join(os.homedir(), '.claude/settings.json');
const DESK = path.join(os.homedir(), '.claude-desk.json');
const read = f => {
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { return {}; }
  try { return JSON.parse(t); } catch (e) {
    const bk = f + '.corrupt-' + new Date().toISOString().slice(0, 10); // keep what the user had before anything can overwrite it
    if (f === DESK && !fs.existsSync(bk)) fs.writeFileSync(bk, t);
    return { __error: e.message };
  }
};

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
  return { claude: s, desk: { notify: true, tips: true, fontSize: 13, ...read(DESK), __error: undefined } };
}

function set(key, value) {
  if (key.startsWith('desk.')) {
    const k = key.slice(5), d = read(DESK); delete d.__error;
    if (!((k === 'notify' || k === 'tips') && bool(value)) && !(k === 'fontSize' && Number.isInteger(value) && value >= 10 && value <= 22) && !(k === 'quitSessions' && (value === 'ask' || value === 'keep')) && !(k === 'phoneAlerts' && bool(value)))
      throw new Error('bad app setting');
    d[k] = value; if (k === 'phoneAlerts' && value && !d.ntfyTopic) d.ntfyTopic = 'ccdesk-' + require('crypto').randomBytes(16).toString('hex'); fs.writeFileSync(DESK, JSON.stringify(d, null, 2)); return;
  }
  const isPlugin = key.startsWith('enabledPlugins.');
  if (!(isPlugin ? bool(value) : ALLOWED[key] && ALLOWED[key](value))) throw new Error('not allowed: ' + key);
  const s = read(FILE);
  if (!Object.keys(s).length || s.__error) throw new Error('settings.json unreadable, not writing');
  try { fs.accessSync(FILE, fs.constants.W_OK); } catch { throw new Error('settings.json is read-only, not changing it'); }
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
