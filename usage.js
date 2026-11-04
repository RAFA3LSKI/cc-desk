// Usage stats from Claude Code's own session files. Writes only its cache (~/.claude-desk-usage.json), never the transcripts.
// The scan runs in a worker thread so 10 GB of history can't stall the terminals, which live in the main process.
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const HOME = os.homedir();
const ROOT = path.join(HOME, '.claude/projects');
const CACHE = path.join(HOME, '.claude-desk-usage.json');
const LIMITS = path.join(HOME, '.claude/state/rate-limits.json'); // written by the status line script
const CACHE_V = 1;

// $ per million tokens: input, 5m cache write, 1h cache write, cache read, output.
// Source: platform.claude.com/docs/en/about-claude/pricing.md, read 2026-11-04. Update when prices change.
const PRICES = {
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50], 'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20], 'claude-opus-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-8': [5, 6.25, 10, 0.5, 25], 'claude-opus-4-7': [5, 6.25, 10, 0.5, 25], 'claude-opus-4-6': [5, 6.25, 10, 0.5, 25], 'claude-opus-4-5': [5, 6.25, 10, 0.5, 25],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.1, 10], 'claude-sonnet-5': [2, 2.5, 4, 0.2, 10], 'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15], 'claude-sonnet-4-5': [3, 3.75, 6, 0.3, 15],
  'claude-haiku-5-5': [0.1, 0.125, 0.2, 0.01, 0.5], 'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
};
const HAIKU_LONG = [0.5, 0.625, 1, 0.05, 2.5]; // Haiku 5.5 when the prompt is over 100k tokens
const baseModel = m => String(m).replace(/-\d{8}$/, '');

// rec = [key, timeMs, model, input, output, write5m, write1h, read, sessionId, fast]
function cost(r) {
  const m = baseModel(r[2]); let p = PRICES[m]; if (!p) return null;
  if (m === 'claude-haiku-5-5' && r[3] + r[5] + r[6] + r[7] > 100000) p = HAIKU_LONG;
  return (r[3] * p[0] + r[5] * p[1] + r[6] * p[2] + r[7] * p[3] + r[4] * p[4]) / 1e6 * (r[9] ? 2 : 1); // fast mode = 2x
}

// One reply is written as several lines sharing a message id, and early lines carry partial output counts: keep the highest of each.
function merge(map, r) {
  const a = map.get(r[0]); if (!a) return map.set(r[0], r);
  a[1] = Math.min(a[1], r[1]); for (const i of [3, 4, 5, 6, 7]) a[i] = Math.max(a[i], r[i]); a[9] = a[9] || r[9];
}

async function parseFile(f) {
  const recs = new Map();
  const dir = path.dirname(f), fallback = path.basename(dir) === 'subagents' ? path.basename(path.dirname(dir)) : path.basename(f, '.jsonl');
  for await (const line of readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity })) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let l; try { l = JSON.parse(line); } catch { continue; } // a half-written last line is re-read on the next scan
    const m = l.message, u = m && m.usage;
    if (l.type !== 'assistant' || !u || !m.model || m.model === '<synthetic>') continue;
    const cc = u.cache_creation || {}, w1 = cc.ephemeral_1h_input_tokens || 0;
    const w5 = u.cache_creation ? cc.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
    merge(recs, [m.id || l.uuid, Date.parse(l.timestamp) || 0, m.model, u.input_tokens || 0, u.output_tokens || 0, w5, w1, u.cache_read_input_tokens || 0, l.sessionId || fallback, u.speed === 'fast' ? 1 : 0]);
  }
  return [...recs.values()];
}

function walk(d, out = []) {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.jsonl')) out.push(p); }
  return out;
}

// Only changed files are re-read. Entries for deleted files stay, so history survives Claude Code's transcript cleanup.
// ponytail: an active session's whole file is re-parsed on each scan; read only the appended bytes if files get huge.
async function scan({ root = ROOT, cacheFile = CACHE, progress = () => {} } = {}) {
  let cache = {}; try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c.v === CACHE_V) cache = c.files; } catch {}
  const files = walk(root).sort(), todo = [];
  for (const f of files) { const st = fs.statSync(f), c = cache[f]; if (!c || c.m !== st.mtimeMs || c.s !== st.size) todo.push([f, st]); }
  let done = 0;
  for (const [f, st] of todo) { cache[f] = { m: st.mtimeMs, s: st.size, r: await parseFile(f) }; if (++done % 10 === 0) progress(done, todo.length); }
  if (todo.length) { const tmp = cacheFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_V, files: cache })); fs.renameSync(tmp, cacheFile); }
  // A resumed session copies old lines into its new file, so remove repeats across files too.
  const all = new Map(); for (const f of Object.keys(cache).sort()) for (const r of cache[f].r) merge(all, r.slice());
  const rows = new Map(), unpriced = new Set();
  for (const r of all.values()) {
    const h = new Date(r[1]).setMinutes(0, 0, 0), k = h + '|' + r[8] + '|' + r[2];
    const x = rows.get(k) || rows.set(k, { h, s: r[8], m: baseModel(r[2]), i: 0, o: 0, w: 0, r: 0, c: 0 }).get(k), c = cost(r);
    if (c === null) unpriced.add(baseModel(r[2]));
    x.i += r[3]; x.o += r[4]; x.w += r[5] + r[6]; x.r += r[7]; x.c += c || 0;
  }
  return { rows: [...rows.values()], unpriced: [...unpriced] };
}

// Main process side: one scan at a time, callers share it.
let running = null;
function get(onProgress) {
  return running || (running = new Promise((res, rej) => {
    const w = new Worker(__filename, { workerData: 'usage-scan' });
    w.on('message', m => m.progress ? onProgress && onProgress(m.progress) : res(m.result));
    w.on('error', rej);
    w.on('exit', c => c && rej(new Error('usage scan stopped, code ' + c)));
  }).then(data => {
    let limits = null; try { limits = JSON.parse(fs.readFileSync(LIMITS, 'utf8')); } catch {}
    return { ...data, limits };
  }).finally(() => { running = null; }));
}

async function selfcheck() {
  const assert = require('assert'), d = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), root = path.join(d, 'p'), sid = 'aaaaaaaa-0000-4000-8000-000000000000';
  const line = (id, model, u, s = sid) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T10:00:00Z', sessionId: s, message: { id, model, usage: u } }) + '\n';
  fs.mkdirSync(path.join(root, 'x', sid, 'subagents'), { recursive: true });
  const main = path.join(root, 'x', sid + '.jsonl');
  fs.writeFileSync(main,
    line('m1', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 10 }) + line('m1', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) + // same reply twice: $2 in + $10 out, once
    line('m2', 'claude-opus-5-5', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 1e6 }, cache_read_input_tokens: 1e6 }) + // $8 + $5 + $0.20
    line('m3', 'claude-opus-5-5', { input_tokens: 1e6, output_tokens: 0, speed: 'fast' }) + // $8
    line('m4', 'claude-haiku-5-5', { input_tokens: 2e5, output_tokens: 0 }) + // long prompt: $0.10
    line('m5', '<synthetic>', { input_tokens: 9e9, output_tokens: 9e9 }) + 'not json "usage" "assistant"\n');
  fs.writeFileSync(path.join(root, 'x', sid, 'subagents', 'agent-1.jsonl'), line('m6', 'claude-mystery', { input_tokens: 5, output_tokens: 5 }, undefined));
  fs.writeFileSync(path.join(root, 'x', 'bbbbbbbb.jsonl'), line('m1', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 })); // resumed copy of m1
  const opts = { root, cacheFile: path.join(d, 'c.json') };
  const total = rows => rows.reduce((t, x) => t + x.c, 0);
  const a = await scan(opts);
  assert(Math.abs(total(a.rows) - 33.3) < 1e-9, 'cost ' + total(a.rows));
  assert.deepStrictEqual(a.unpriced, ['claude-mystery']);
  assert(a.rows.every(r => r.s === sid), 'all usage belongs to the parent session: ' + a.rows.map(r => r.s));
  assert.strictEqual(a.rows.reduce((t, x) => t + x.o, 0), 1e6 + 5, 'partial output counts must not add up');
  const b = await scan(opts); assert.deepStrictEqual(b, a, 'cached scan differs');
  fs.appendFileSync(main, line('m7', 'claude-sonnet-5-5', { input_tokens: 0, output_tokens: 1e6 }));
  assert(Math.abs(total((await scan(opts)).rows) - 43.3) < 1e-9, 'changed file was not re-read');
  fs.rmSync(d, { recursive: true });
  return 'usage selfcheck OK';
}

if (!isMainThread && workerData === 'usage-scan') {
  scan({ progress: (done, total) => parentPort.postMessage({ progress: { done, total } }) }).then(data => {
    const titles = {}; try { for (const s of require('./sessions').list(1e9).items) titles[s.id] = s.title; } catch {}
    parentPort.postMessage({ result: { ...data, titles } });
  }).catch(e => { throw e; });
}
if (isMainThread && require.main === module) selfcheck().then(console.log, e => { console.error('FAIL:', e.message); process.exit(1); });
module.exports = { get, selfcheck };
