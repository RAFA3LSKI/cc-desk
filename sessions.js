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
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.text) || '').join(' ') : '';
}
const isReal = t => (t = t.trim()) && !t.startsWith('<') && !t.startsWith('[Image') && !/^caveat/i.test(t) && !/^\/[\w:.-]+$/.test(t); // bare slash commands like /clear say nothing about the chat
const HANDOFF = /^write a handoff note so a fresh/i; // a stock instruction, so the next real prompt names the chat better

// ponytail: head/tail 256KB parsed; a mid-file /rename is found by scanning the whole file for the last custom-title line (files <= 256MB, 23MB ~ tens of ms). Bigger files: head+tail only.
const cache = new Map();
function meta(f) {
  const st = fs.statSync(f), hit = cache.get(f);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  let head = chunk(f, 0, Math.min(st.size, CHUNK));
  if (st.size > CHUNK && !head.includes('\n')) head = chunk(f, 0, Math.min(st.size, 8 * 1024 * 1024)); // huge first prompt: read to the first newline
  const rows = [...parse(head), ...(st.size > CHUNK ? parse(chunk(f, st.size - CHUNK, CHUNK)) : [])];
  if (st.size > CHUNK && st.size <= 256 * 1024 * 1024) {
    const b = fs.readFileSync(f), key = '"type":"custom-title"';
    for (let i = b.lastIndexOf(key); i >= 0; i = b.lastIndexOf(key, i - 1)) {
      const s = b.lastIndexOf('\n', i) + 1, e = b.indexOf('\n', i), l = parse(b.toString('utf8', s, e < 0 ? b.length : e))[0];
      if (l && l.type === 'custom-title') { rows.push(l); break; }
      if (i === 0) break;
    }
  }
  let custom, ai, first, cwd, handoff, auto;
  for (const l of rows) {
    if (l.type === 'custom-title' && typeof l.customTitle === 'string') custom = l.customTitle;
    if (l.type === 'ai-title' && typeof l.aiTitle === 'string') ai = l.aiTitle;
    if (!cwd && typeof l.cwd === 'string' && l.cwd) cwd = l.cwd;
    if (l.entrypoint === 'sdk-cli') auto = true; // started by a script (`claude -p`), not typed by a person
    if (!first && l.type === 'user') { const t = textOf(l); if (isReal(t)) { if (HANDOFF.test(t.trim())) handoff = true; else first = t.trim().replace(/\s+/g, ' '); } }
  }
  const m = { id: path.basename(f, '.jsonl'), file: f, cwd: cwd || HOME, mtime: st.mtimeMs, size: st.size,
              title: custom || ai || (first ? first.slice(0, 80) : handoff ? 'Handoff note' : '(empty session)'), empty: !first && !handoff, auto: !!auto };
  cache.set(f, m); return m;
}

function list(limit = 300) {
  const files = [];
  for (const d of (() => { try { return fs.readdirSync(PROJ); } catch { return []; } })()) {
    const dir = path.join(PROJ, d);
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.jsonl')) files.push(path.join(dir, n));
  }
  const pins = new Set(readJSON(CONF, {}).pins || []);
  const all = files.map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  const keep = all.filter((x, i) => i < limit || pins.has(path.basename(x.f, '.jsonl')));
  return { total: all.length, items: keep.flatMap(({ f }) => { try { const m = { ...meta(f) }; m.pinned = pins.has(m.id); return [m]; } catch { return []; } }) }; // one unreadable file is skipped
}

// Live status: Claude Code writes ~/.claude/sessions/<pid>.json with status busy/idle/waiting.
function live() {
  const byId = {}, byPid = {};
  for (const n of (() => { try { return fs.readdirSync(LIVE); } catch { return []; } })()) {
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

// Images in a session (pasted/dropped screenshots + images Claude opened with Read), read from its transcript from byte `from` on.
// Only complete lines are read; `next` is where the next call starts. ponytail: base64 goes to the renderer as-is, fine for screenshots.
const fileOf = new Map(), toolFile = new Map(); // ponytail: toolFile grows with every file-reading tool call while the app runs; small strings, fine
function fileFor(id) {
  if (!/^[0-9a-f-]{36}$/.test(id || '')) return null;
  let f = fileOf.get(id);
  if (!f || !fs.existsSync(f)) {
    f = null;
    for (const d of (() => { try { return fs.readdirSync(PROJ); } catch { return []; } })()) { const c = path.join(PROJ, d, id + '.jsonl'); if (fs.existsSync(c)) { f = c; break; } }
    if (f) fileOf.set(id, f);
  }
  return f;
}
// One session's title (same rule as the list), or null while it has none yet. Used by ptyd's phone alert.
function title(id) { try { const f = fileFor(id), m = f && meta(f); return m && !m.empty ? m.title : null; } catch { return null; } }
function images(id, from = 0) {
  const f = fileFor(id); if (!f) return { next: 0, imgs: [] };
  const size = fs.statSync(f).size; if (size < from) from = 0; // file replaced: start over
  if (size === from) return { next: from, imgs: [] };
  const b = chunk(f, from, size - from), end = b.lastIndexOf('\n') + 1, imgs = [];
  const push = (x, hint, opened) => x && x.type === 'image' && x.source && x.source.type === 'base64' && /^image\/(png|jpe?g|gif|webp)$/.test(x.source.media_type) && imgs.push({ mime: x.source.media_type, data: x.source.data, hint, opened });
  for (const line of b.slice(0, end).split('\n')) {
    if (!line.includes('"image"') && !line.includes('"tool_use"')) continue;
    let l; try { l = JSON.parse(line); } catch { continue; }
    const c = l.message && l.message.content; if (!Array.isArray(c) || l.isMeta) continue;
    if (l.type === 'assistant') { for (const x of c) if (x && x.type === 'tool_use' && x.input) { const fp = x.input.file_path || x.input.path; if (typeof fp === 'string') toolFile.set(x.id, path.basename(fp)); } continue; }
    if (l.type !== 'user') continue;
    // Pasted: "[Image #N]" in the message text, in the same order as the images. Opened: the file name Claude Code prints on the Read line.
    const tags = c.map(x => (x && x.type === 'text' && x.text) || '').join(' ').match(/\[Image #\d+\]/g) || []; let n = 0;
    for (const x of c) { if (x && x.type === 'tool_result') { const ims = Array.isArray(x.content) ? x.content : []; for (const y of ims) push(y, toolFile.get(x.tool_use_id) || null, true); }
      else if (x && x.type === 'image') push(x, tags[n++] || null, false); }
  }
  return { next: from + Buffer.byteLength(b.slice(0, end)), imgs };
}

// The conversation as chat items, read from byte `from` on (same incremental rule as images). Main thread only (no subagents).
// Items: {k:'user', text, imgs} {k:'bot', text} {k:'tool', id, name, desc, detail} {k:'done', id, err} {k:'cmd', text}
const short = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function toolDesc(name, i = {}) {
  const fp = i.file_path || i.notebook_path || i.path;
  if (name === 'Bash') return short(i.description || i.command);
  if (fp && /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return path.basename(fp);
  if (name === 'Grep' || name === 'Glob') return short(i.pattern);
  if (name === 'Task' || name === 'Agent') return short(i.description || i.prompt);
  if (name === 'WebFetch') return short(i.url); if (name === 'WebSearch') return short(i.query);
  if (name === 'TodoWrite' && Array.isArray(i.todos)) return i.todos.filter(t => t.status === 'completed').length + '/' + i.todos.length + ' done';
  if (name === 'Skill') return short(i.skill);
  return short(fp || i.description || i.query || i.command || '');
}
function toolDetail(name, i = {}) {
  if (name === 'Bash') return i.command || '';
  if (name === 'Edit') return (i.old_string || '').split('\n').map(l => '- ' + l).join('\n') + '\n' + (i.new_string || '').split('\n').map(l => '+ ' + l).join('\n');
  if (name === 'Write') return String(i.content || '').slice(0, 4000);
  if (name === 'TodoWrite' && Array.isArray(i.todos)) return i.todos.map(t => (t.status === 'completed' ? '✓ ' : t.status === 'in_progress' ? '● ' : '○ ') + t.content).join('\n');
  try { return JSON.stringify(i, null, 2).slice(0, 4000); } catch { return ''; }
}
function chat(id, from = 0) {
  const f = fileFor(id); if (!f) return { next: 0, items: [] };
  const size = fs.statSync(f).size; if (size < from) from = 0;
  if (size === from) return { next: from, items: [] };
  const b = chunk(f, from, size - from), end = b.lastIndexOf('\n') + 1, items = [];
  for (const line of b.slice(0, end).split('\n')) {
    if (!line.startsWith('{"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
    let l; try { l = JSON.parse(line); } catch { continue; }
    if (l.isSidechain || l.isMeta || !l.message || (l.type !== 'user' && l.type !== 'assistant')) continue;
    const c = l.message.content;
    if (l.type === 'user') {
      if (typeof c === 'string') {
        const cmd = c.match(/<command-name>([^<]*)<\/command-name>/); if (cmd) { items.push({ k: 'cmd', text: cmd[1] }); continue; }
        if (/^<(local-command|bash-|system-reminder|command-)/.test(c.trim())) continue;
        items.push({ k: 'user', text: c, imgs: [] }); continue;
      }
      if (!Array.isArray(c)) continue;
      let text = '', imgs = [];
      for (const x of c) {
        if (!x) continue;
        if (x.type === 'tool_result') items.push({ k: 'done', id: x.tool_use_id, err: !!x.is_error });
        else if (x.type === 'text' && !/^\s*<(system-reminder|local-command|command-)/.test(x.text || '') && !/^\[Request interrupted/.test(x.text || '')) text += (text ? '\n' : '') + x.text;
        else if (x.type === 'image' && x.source && x.source.type === 'base64' && /^image\/(png|jpe?g|gif|webp)$/.test(x.source.media_type)) imgs.push(`data:${x.source.media_type};base64,${x.source.data}`);
      }
      if (text.trim() || imgs.length) items.push({ k: 'user', text, imgs });
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (!x) continue;
      if (x.type === 'text' && x.text && x.text.trim()) items.push({ k: 'bot', text: x.text });
      else if (x.type === 'tool_use') items.push({ k: 'tool', id: x.id, name: String(x.name || '').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ''), desc: toolDesc(x.name, x.input), detail: toolDetail(x.name, x.input) });
    }
  }
  return { next: from + Buffer.byteLength(b.slice(0, end)), items };
}

module.exports = { list, live, usage, rename, togglePin, extras, images, chat, title, HOME };
