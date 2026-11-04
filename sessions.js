// Reads Claude Code's own files. Only write: rename appends the same custom-title line /rename does.
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline');
const HOME = os.homedir();
const PROJ = path.join(HOME, '.claude/projects');
const LIVE = path.join(HOME, '.claude/sessions');
const CONF = path.join(HOME, '.claude-desk.json'); // { pins: [ids] }
const CHUNK = 256 * 1024;

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function chunk(f, start, len) {
  const fd = fs.openSync(f, 'r'), b = Buffer.alloc(len), n = fs.readSync(fd, b, 0, len, start);
  fs.closeSync(fd); return b.toString('utf8', 0, n);
}
const parse = s => s.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
function textOf(l) {
  const c = l.message && l.message.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text || '').join(' ') : '';
}
const isReal = t => (t = t.trim()) && !t.startsWith('<') && !t.startsWith('[Image') && !/^caveat/i.test(t);

// ponytail: titles read from the first+last 256KB only; a /rename buried mid-file in a huge session is missed.
const cache = new Map();
function meta(f) {
  const st = fs.statSync(f), hit = cache.get(f);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const rows = [...parse(chunk(f, 0, Math.min(st.size, CHUNK))),
                ...(st.size > CHUNK ? parse(chunk(f, st.size - CHUNK, CHUNK)) : [])];
  let custom, ai, first, cwd;
  for (const l of rows) {
    if (l.type === 'custom-title') custom = l.customTitle;
    if (l.type === 'ai-title') ai = l.aiTitle;
    if (!cwd && l.cwd) cwd = l.cwd;
    if (!first && l.type === 'user') { const t = textOf(l); if (isReal(t)) first = t.trim().replace(/\s+/g, ' '); }
  }
  const m = { id: path.basename(f, '.jsonl'), file: f, cwd: cwd || HOME, mtime: st.mtimeMs, size: st.size,
              title: custom || ai || (first ? first.slice(0, 80) : '(empty session)'), empty: !first };
  cache.set(f, m); return m;
}

function list(limit = 300) {
  const files = [];
  for (const d of fs.readdirSync(PROJ)) {
    const dir = path.join(PROJ, d);
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.jsonl')) files.push(path.join(dir, n));
  }
  const pins = new Set(readJSON(CONF, {}).pins || []);
  const all = files.map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  const keep = all.filter((x, i) => i < limit || pins.has(path.basename(x.f, '.jsonl')));
  return { total: all.length, items: keep.map(({ f }) => { const m = { ...meta(f) }; m.pinned = pins.has(m.id); return m; }) };
}

// Live status: Claude Code writes ~/.claude/sessions/<pid>.json with status busy/idle/waiting.
function live() {
  const byId = {}, byPid = {};
  for (const n of fs.readdirSync(LIVE)) {
    if (!/^\d+\.json$/.test(n)) continue;
    const s = readJSON(path.join(LIVE, n), null);
    if (!s) continue;
    try { process.kill(s.pid, 0); } catch { continue; } // dead process = stale file
    if (s.kind && s.kind !== 'interactive') continue; // skip headless/background runs
    const v = { status: s.status || 'idle', pid: s.pid, id: s.sessionId };
    byId[s.sessionId] = v; byPid[s.pid] = v;
  }
  return { byId, byPid };
}

// Token totals for one session (assistant turns, de-duplicated by message id).
async function usage(file) {
  const seen = new Set(), t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let l; try { l = JSON.parse(line); } catch { continue; }
    const m = l.message; if (l.type !== 'assistant' || !m || !m.usage || seen.has(m.id)) continue;
    seen.add(m.id); t.turns++;
    t.input += m.usage.input_tokens || 0; t.output += m.usage.output_tokens || 0;
    t.cacheRead += m.usage.cache_read_input_tokens || 0; t.cacheWrite += m.usage.cache_creation_input_tokens || 0;
  }
  return t;
}

// Same line Claude Code's /rename appends, so the terminal's /resume list shows it too.
function rename(file, id, name) {
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name || !/^[0-9a-f-]{36}$/.test(id) || !(file = path.resolve(file)).startsWith(PROJ + path.sep) || path.basename(file) !== id + '.jsonl') return;
  fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: id }) + '\n');
}

function togglePin(id) {
  const c = readJSON(CONF, {}), pins = new Set(c.pins || []);
  pins.has(id) ? pins.delete(id) : pins.add(id);
  c.pins = [...pins]; fs.writeFileSync(CONF, JSON.stringify(c, null, 2));
}

function extras() {
  const ls = (d, fn) => { try { return fs.readdirSync(d).map(fn).filter(Boolean).sort(); } catch { return []; } };
  return {
    agents: ls(path.join(HOME, '.claude/agents'), n => n.endsWith('.md') && n.slice(0, -3)),
    skills: ls(path.join(HOME, '.claude/skills'), n => fs.existsSync(path.join(HOME, '.claude/skills', n, 'SKILL.md')) && n),
  };
}

module.exports = { list, live, usage, rename, togglePin, extras, HOME };
