// Background helper: holds the terminal sessions so they outlive the CC Desk window. Quit the app and they keep working;
// reopen it and it reconnects. Runs on its own under Electron's Node (ELECTRON_RUN_AS_NODE), so node-pty's build matches.
// Only reachable through a socket only this user can open. Newline-delimited JSON both ways.
const net = require('net'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), http = require('http'), https = require('https');
const HOME = os.homedir();
const SOCK = process.env.DESK_PTYD_SOCK || path.join(HOME, '.claude-desk-ptyd.sock');
const LOG = SOCK.replace(/\.sock$/, '') + '.log';
const PROTO = 1;

// Phone alert through ntfy (free app, no account). Anyone who knows the long random topic could read these, so they carry only a short status and the session name.
function ntfy(topic, title, body) {
  const url = new URL(encodeURIComponent(topic), (process.env.DESK_NTFY_URL || 'https://ntfy.sh') + '/');
  return new Promise((res, rej) => {
    const r = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', timeout: 10000, headers: { Title: title, Priority: 'high', 'Content-Type': 'text/plain; charset=utf-8' } },
      x => { x.resume(); x.statusCode < 300 ? res() : rej(new Error('ntfy answered ' + x.statusCode)); });
    r.on('error', rej); r.on('timeout', () => r.destroy(new Error('ntfy timed out'))); r.end(body);
  });
}

const lines = (sock, onMsg) => {
  let buf = ''; sock.setEncoding('utf8');
  sock.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; } onMsg(m); } });
};

function server() {
  const pty = require('node-pty');
  const IDLE_MS = +process.env.DESK_IDLE_MS || 24 * 3600 * 1000, TICK = +process.env.DESK_IDLE_TICK || 60000, KEEP = 4 * 1024 * 1024;
  const WITH_CLIENT = process.env.DESK_PTYD_EXIT_WITH_CLIENT; // tests only: everything ends when the app does
  const log = m => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };
  process.on('uncaughtException', e => log('uncaught ' + (e && e.stack))); // one bad message must not take every session down
  process.umask(0o077);
  const S = new Map(), clients = new Set();
  const out = (m, only) => { const l = JSON.stringify(m) + '\n'; for (const c of only ? [only] : clients) if (!c.destroyed) c.write(l); };
  const bye = () => { for (const s of S.values()) try { s.p.kill(); } catch {} try { fs.unlinkSync(SOCK); } catch {} process.exit(0); };
  let emptySince = Date.now();
  const handle = (m, c) => {
    const s = S.get(m.key);
    if (m.t === 'hello') out({ t: 'hello', proto: PROTO, count: S.size }, c);
    else if (m.t === 'list') out({ t: 'list', items: [...S].map(([key, x]) => ({ key, pid: x.p.pid, meta: x.meta })) }, c);
    else if (m.t === 'open') {
      try {
        const p = pty.spawn(m.shell, m.args, { name: 'xterm-256color', cols: m.cols, rows: m.rows, cwd: m.cwd, env: m.env });
        const x = { p, meta: m.meta, buf: [], size: 0, last: Date.now(), cols: m.cols, rows: m.rows };
        S.set(m.key, x);
        p.onData(d => { x.last = Date.now(); x.buf.push(d); x.size += d.length; while (x.size > KEEP && x.buf.length > 1) x.size -= x.buf.shift().length; out({ t: 'data', key: m.key, d }); });
        p.onExit(() => { S.delete(m.key); out({ t: 'exit', key: m.key }); if (!S.size) emptySince = Date.now(); });
        out({ t: 'opened', key: m.key, pid: p.pid }, c);
      } catch (e) { log('open failed ' + e.message); out({ t: 'opened', key: m.key, error: e.message }, c); }
    }
    else if (m.t === 'attach' && s) { // replay what was on screen, then a size change makes the program redraw itself cleanly
      out({ t: 'data', key: m.key, d: s.buf.join('') }, c);
      const cols = m.cols || s.cols, rows = m.rows || s.rows; s.cols = cols; s.rows = rows;
      try { s.p.resize(Math.max(cols - 1, 2), rows); setTimeout(() => { try { S.has(m.key) && s.p.resize(cols, rows); } catch {} }, 80); } catch {}
    }
    else if (m.t === 'write' && s) { s.last = Date.now(); s.p.write(m.d); }
    else if (m.t === 'resize' && s) { s.cols = m.cols; s.rows = m.rows; try { s.p.resize(m.cols, m.rows); } catch {} }
    else if (m.t === 'kill' && s) s.p.kill();
    else if (m.t === 'stopAll') { for (const x of S.values()) x.p.kill(); out({ t: 'stopped' }, c); }
    else if (m.t === 'shutdown') bye();
  };
  const srv = net.createServer(c => {
    clients.add(c); c.on('error', () => {}); c.on('close', () => { clients.delete(c); emptySince = Date.now(); if (WITH_CLIENT && !clients.size) bye(); });
    lines(c, m => handle(m, c));
  });
  // Stops sessions nobody has touched for a day, unless Claude is mid-task. The chat stays saved and can be reopened.
  setInterval(() => {
    for (const [key, x] of S) {
      if (Date.now() - x.last < IDLE_MS) continue;
      let busy = false; try { busy = JSON.parse(fs.readFileSync(path.join(HOME, '.claude/sessions', x.p.pid + '.json'), 'utf8')).status === 'busy'; } catch {}
      if (!busy) { log(`idle stop ${key} pid ${x.p.pid}`); x.p.kill(); }
    }
    if (!S.size && !clients.size && Date.now() - emptySince > 10000) bye(); // nothing to hold, go away
  }, TICK);
  // Phone alert: once per wait, when Claude has been waiting on an answer or permission this long. Runs here so it still works with the app closed.
  const PHONE_AFTER = +process.env.DESK_PHONE_AFTER || 90000, liveOf = pid => { try { return JSON.parse(fs.readFileSync(path.join(HOME, '.claude/sessions', pid + '.json'), 'utf8')); } catch { return {}; } };
  setInterval(() => {
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude-desk.json'), 'utf8')); } catch {}
    for (const [key, x] of S) {
      const lv = liveOf(x.p.pid);
      if (lv.status !== 'waiting') { x.waitSince = 0; x.pinged = false; continue; }
      x.waitSince = x.waitSince || Date.now();
      if (x.pinged || !cfg.phoneAlerts || !cfg.ntfyTopic || Date.now() - x.waitSince < PHONE_AFTER) continue;
      x.pinged = true; // a failed send clears this, so it retries on the next check
      // meta.title is the name the tab had when it opened ("New session" for new ones); the transcript has the real one by now.
      ntfy(cfg.ntfyTopic, 'Claude needs you', require('./sessions').title(lv.sessionId) || (x.meta && x.meta.title) || 'A session is waiting for an answer or permission').then(() => log('phone alert ' + key), e => { x.pinged = false; log('phone alert failed ' + e.message); });
    }
  }, +process.env.DESK_PHONE_TICK || 15000);
  const listen = () => srv.listen(SOCK, () => log('started ' + process.pid));
  srv.on('error', e => { // a dead helper leaves its socket behind; a live one means this copy isn't needed
    if (e.code !== 'EADDRINUSE') { log('listen ' + e.message); process.exit(1); }
    const t = net.connect(SOCK); t.on('connect', () => process.exit(0)); t.on('error', () => { try { fs.unlinkSync(SOCK); } catch {} listen(); });
  });
  listen();
}

// App side. onMsg gets { t: 'data' | 'exit', key, d }. Starts the helper only when a session needs it.
function client(onMsg, onClose) {
  let sock = null, connecting = null; const waiting = [];
  const reply = t => new Promise(res => waiting.push({ t, res }));
  const attachSock = s => {
    sock = s; lines(s, m => {
      const i = waiting.findIndex(w => w.t === m.t && (!w.key || w.key === m.key));
      if (i >= 0 && m.t !== 'data' && m.t !== 'exit') return waiting.splice(i, 1)[0].res(m);
      onMsg(m);
    });
    s.on('close', () => { if (sock === s) { sock = null; onClose && onClose(); } }); s.on('error', () => {});
  };
  const tryConnect = () => new Promise((res, rej) => { const s = net.connect(SOCK); s.once('connect', () => { s.removeAllListeners('error'); res(s); }); s.once('error', rej); });
  const start = () => {
    const logFd = fs.openSync(LOG, 'a');
    cp.spawn(process.execPath, [__filename], { detached: true, stdio: ['ignore', logFd, logFd], cwd: HOME, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref();
    fs.closeSync(logFd);
  };
  async function ensure(spawnIt) {
    if (sock) return true;
    return connecting || (connecting = (async () => {
      let s; try { s = await tryConnect(); } catch {
        if (!spawnIt) return false;
        start();
        for (let i = 0; i < 100 && !s; i++) { await new Promise(r => setTimeout(r, 50)); try { s = await tryConnect(); } catch {} }
        if (!s) throw new Error('the background helper did not start (see ' + LOG + ')');
      }
      attachSock(s); const send = m => s.write(JSON.stringify(m) + '\n');
      const p = reply('hello'); send({ t: 'hello' }); const h = await p;
      if (h.proto !== PROTO && !h.count) { // an old helper with nothing in it: replace it. With sessions in it, keep using it so nothing is interrupted.
        sock = null; send({ t: 'shutdown' }); await new Promise(r => setTimeout(r, 200)); connecting = null; return ensure(spawnIt);
      }
      return true;
    })().finally(() => { connecting = null; }));
  }
  const send = m => { if (sock) sock.write(JSON.stringify(m) + '\n'); };
  return {
    async open(o) { await ensure(true); const p = new Promise(res => waiting.push({ t: 'opened', key: o.key, res })); send({ t: 'open', ...o }); const r = await p; if (r.error) throw new Error(r.error); return r.pid; },
    async list() { if (!(await ensure(false))) return []; const p = reply('list'); send({ t: 'list' }); return (await p).items; },
    attach: (key, cols, rows) => send({ t: 'attach', key, cols, rows }), write: (key, d) => send({ t: 'write', key, d }),
    resize: (key, cols, rows) => send({ t: 'resize', key, cols, rows }), kill: key => send({ t: 'kill', key }),
    async stopAll() { if (!sock) return; const p = reply('stopped'); send({ t: 'stopAll' }); await Promise.race([p, new Promise(r => setTimeout(r, 2000))]); },
    connected: () => !!sock,
  };
}

if (require.main === module) server();
module.exports = { client, ntfy, SOCK };
