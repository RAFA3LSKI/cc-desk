// Advanced-use UI test. Run: node uitest-advanced.js   (hidden, sandbox HOME, fake shell, never touches the real app, real settings or real sessions)
// Launcher (plain node): sandbox HOME + fake shell, runs this file under Electron, then compares the real files before/after.
// Driver (inside Electron): drives the real index.html + main.js in a hidden window. Zero real `claude` sessions are started (all fakes).
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');

if (!process.versions.electron) {
  const REAL = os.homedir(), sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return 'ABSENT'; } };
  const realFiles = [path.join(REAL, '.claude/settings.json'), path.join(REAL, '.claude-desk.json')];
  const alive = p => { try { process.kill(p, 0); return true; } catch { return false; } };
  // sessions that a real claude is writing right now are expected to change; everything else must not
  const liveIds = new Set(); try { for (const n of fs.readdirSync(path.join(REAL, '.claude/sessions'))) { try { const s = JSON.parse(fs.readFileSync(path.join(REAL, '.claude/sessions', n), 'utf8')); if (alive(s.pid)) liveIds.add(s.sessionId); } catch {} } } catch {}
  const newest = () => { const out = []; try { for (const n of fs.readdirSync(path.join(REAL, '.claude/projects'), { recursive: true })) if (n.endsWith('.jsonl')) { const f = path.join(REAL, '.claude/projects', n); try { out.push([f, fs.statSync(f).mtimeMs]); } catch {} } } catch {}
    return new Map(out.sort((a, b) => b[1] - a[1]).slice(0, 50)); };
  const before = realFiles.map(sha), pBefore = newest();
  const H = fs.mkdtempSync(path.join(os.tmpdir(), 'deskadv-')), C = path.join(H, '.claude');
  for (const d of ['sessions', 'agents', 'skills', 'projects']) fs.mkdirSync(path.join(C, d), { recursive: true });
  fs.writeFileSync(path.join(C, 'settings.json'), JSON.stringify({ model: 'opus', theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] }, enabledPlugins: { 'a@b': true } }, null, 2));
  fs.writeFileSync(path.join(H, '.claude.json'), '{}'); // logged out
  // fake login shell. FAKE_MODE (read at spawn time from the driver's env) picks the behaviour. Every call is logged: cwd|args|CC_DESK_APP
  fs.writeFileSync(path.join(H, 'fakesh'), `#!/bin/sh
echo "$PWD|$*|\${CC_DESK_APP:-}" >> "$HOME/shlog"
case "\${FAKE_MODE:-idle}" in
  exit) echo "claude: boom"; exit 3;;
  loggedout) echo "Not logged in · Please run /login"; exec sleep 600;;
  cat) exec cat;;
  update_fail) cd "$FAKE_CLONE" && PATH=/usr/bin:/bin CC_DESK_APP="$FAKE_CLONE/Fake.app" exec /bin/bash ./install.sh --update;;
  update_ok) exit 0;;
  *) case "$*" in *mcp*) echo "claude.ai Fake: https://x - Connected";; esac; exec sleep 600;;
esac
`, { mode: 0o755 });
  console.log('command: node uitest-advanced.js | sandbox HOME:', H);
  const env = { ...process.env, HOME: H, DESK_PTYD_EXIT_WITH_CLIENT: '1', SHELL: path.join(H, 'fakesh'), DESK_UITEST_ADV: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.DESK_SMOKE;
  const r = cp.spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 420000 });
  const after = realFiles.map(sha), pAfter = newest();
  const changed = [...pBefore].filter(([f, t]) => pAfter.get(f) !== t && !liveIds.has(path.basename(f, '.jsonl'))).map(([f]) => path.basename(f));
  const same = before.every((h, i) => h === after[i]);
  console.log(`REAL FILES UNCHANGED: ${same ? 'PASS' : 'FAIL'} (settings.json ${before[0].slice(0, 12)} -> ${after[0].slice(0, 12)}, .claude-desk.json ${before[1].slice(0, 12)} -> ${after[1].slice(0, 12)})`);
  console.log(`REAL PROJECTS (newest 50 jsonl mtimes): ${changed.length ? 'FAIL ' + changed : 'PASS'} (${liveIds.size} live real session(s) excluded as expected writers)`);
  process.exit(r.status || (same && !changed.length ? 0 : 1));
}

// ---------------- driver (Electron) ----------------
const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
app.setActivationPolicy && app.setActivationPolicy('prohibited');
app.setPath('userData', path.join(os.homedir(), 'ud')); // sandbox userData: the REAL single-instance lock logic runs, but on a lock nobody else holds
app.on('browser-window-created', (e, w) => w.hide());
shell.openExternal = async () => {};
const H = os.homedir(), C = path.join(H, '.claude'), PROJ = path.join(C, 'projects'), LIVE = path.join(C, 'sessions'), LOG = path.join(H, 'shlog');
const SETF = path.join(C, 'settings.json'), DESKF = path.join(H, '.claude-desk.json'), REPO = __dirname, FAKESH = path.join(H, 'fakesh');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
const U = (text, cwd, sid) => ({ type: 'user', cwd, sessionId: sid, message: { role: 'user', content: text } });
let mid = 0; const A = (id, out = 5) => ({ type: 'assistant', message: { id: id || 'msg_' + (++mid), role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } });
function mk(proj, id, lines, ageSec = 0, raw) {
  const d = path.join(PROJ, proj); fs.mkdirSync(d, { recursive: true }); const f = path.join(d, id + '.jsonl');
  fs.writeFileSync(f, raw !== undefined ? raw : lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');
  const t = Date.now() / 1000 - ageSec; fs.utimesSync(f, t, t); return f;
}
// 5 synthetic fixture sessions (F0 has an ai-title, all have a real prompt, cwd exists)
const CWD = path.join(H, 'proj-a'); fs.mkdirSync(CWD);
const F = [['Alpha prompt one', 'Alpha titled session', 2], ['Beta prompt two', null, 1], ['Gamma prompt three', null, 1], ['Delta prompt four', null, 0], ['Epsilon prompt five', null, 0]].map(([p, ai, turns], i) => {
  const id = crypto.randomUUID(), lines = [U(p, CWD, id)]; for (let k = 0; k < turns; k++) lines.push(A());
  if (ai) lines.push({ type: 'ai-title', aiTitle: ai, sessionId: id });
  return { id, cwd: CWD, title: ai || p, file: mk('-proj-a', id, lines, 10 + i * 5) };
});
fs.writeFileSync(LOG, '');

const results = []; let fails, infos;
const ok = (c, msg) => { if (!c) fails.push(msg); }, info = s => infos.push(s);
const rj = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const descendants = () => { const rows = cp.execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString().split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
  const out = [], q = [process.pid]; while (q.length) { const p = q.shift(); for (const r of rows) if (r.ppid === p && !/^ps /.test(r.cmd)) { out.push(r); q.push(r.pid); } } return out; };
const ptyProcs = () => descendants().filter(d => /sleep 600|fakesh|\/cat$/.test(d.cmd));
const shlog = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => { const [pwd, args, app] = l.split('|'); return { pwd, args, app }; });
const claudeLogs = () => shlog().filter(l => /exec claude/.test(l.args));
const liveFile = (pid, sid, status, kind = 'interactive') => fs.writeFileSync(path.join(LIVE, pid + '.json'), JSON.stringify({ pid, sessionId: sid, status, kind }));
const waitFor = async (fn, ms = 5000, step = 100) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(step); } return false; };

app.whenReady().then(() => { require('./main.js'); setTimeout(run, 500); });
async function run() {
  const win = BrowserWindow.getAllWindows()[0], wc = win.webContents, jserr = [];
  wc.on('console-message', (e, lvl, msg) => lvl >= 3 && jserr.push(msg));
  const R = js => wc.executeJavaScript(js);
  const flow = async (name, fn) => { fails = []; infos = []; try { await fn(); } catch (e) { fails.push('EXC ' + (e.stack || e.message).split('\n').slice(0, 2).join(' ')); } results.push([name, fails.length ? 'FAIL' : 'PASS', fails.join(' | '), infos.join(' ; ')]); };
  const note = (name, why) => results.push([name, 'NOT_TESTED_' + why, '', '']);
  await new Promise(r => wc.isLoading() ? wc.once('did-finish-load', r) : r()); await sleep(2000);
  await R(`window.__rej = []; addEventListener('unhandledrejection', e => __rej.push(String((e.reason && e.reason.message) || e.reason)));
    window.__notes = []; window.Notification = class { constructor(t, o) { this.title = t; this.opts = o; __notes.push(this); } };
    window.__tt = k => { const b = tabs[k].term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; }; 0`);
  // stubs so nothing can show/focus the window or quit the sandbox process by accident
  const calls = { show: 0, focus: 0, relaunch: 0, exit: [] , dialogs: [] }; let dialogAnswer = 1;
  win.show = () => { calls.show++; }; win.focus = () => { calls.focus++; };
  dialog.showMessageBoxSync = (w, o) => { calls.dialogs.push(o); return dialogAnswer; };
  const realExit = app.exit.bind(app), realRelaunch = app.relaunch.bind(app);
  const tabsInfo = async () => JSON.parse(await R(`JSON.stringify(Object.entries(tabs).map(([k, t]) => ({ k, pid: t.pid, sid: t.sessionId, title: t.title })))`));
  const rows = () => R(`[...document.querySelectorAll('#list .it[data-id]')].length`);
  const titles = () => R(`[...document.querySelectorAll('#list .it[data-id]')].map(e => e.querySelector('.t').textContent)`);
  const openRow = id => R(`document.querySelector('#list .it[data-id="${id}"]').click()`);
  const closeAll = async () => { for (let i = 0; i < 30 && await R(`!!document.querySelector('[data-close]')`); i++) { await R(`document.querySelector('[data-close]').click()`); await sleep(40); } await sleep(500); };
  const text = k => R(`__tt('${k}')`);
  const safeRefresh = fn => R(`(async () => { try { await ${fn}(); return 'ok'; } catch (e) { return 'THROW ' + e.message; } })()`);
  const lat = () => R(`(async () => { const t = performance.now(); await ipc.invoke('name'); return performance.now() - t; })()`);
  process.env.FAKE_MODE = 'idle';

  // ---- 01 resume an old session
  await flow('01 resume old session: command, cwd, title', async () => {
    fs.writeFileSync(LOG, ''); await openRow(F[0].id); await sleep(900);
    let l = claudeLogs(); ok(l.length === 1, 'spawns after one click: ' + l.length);
    ok(l[0] && l[0].args.endsWith(`exec claude --resume ${F[0].id}`), 'args: ' + (l[0] && l[0].args)); ok(l[0] && /unset CLAUDE_CODE_OAUTH_TOKEN;/.test(l[0].args), 'token unset missing'); ok(l[0] && /^-ilc /.test(l[0].args), 'not a login interactive shell');
    ok(l[0] && real(l[0].pwd) === real(F[0].cwd), `cwd ${l[0] && l[0].pwd} vs ${F[0].cwd}`); ok(await R(`$('title').textContent`) === F[0].title, 'title bar ' + await R(`$('title').textContent`));
    ok((await tabsInfo())[0].title === F[0].title, 'tab title lost'); ok(/^2 turns/.test(await R(`$('use').textContent`)), 'usage line "' + await R(`$('use').textContent`) + '"');
    await openRow(F[0].id); await sleep(400); ok(claudeLogs().length === 1, 're-click spawned a second claude');
    await R(`$('new').click()`); await sleep(700); l = claudeLogs(); ok(l.length === 2 && l[1].args.endsWith('exec claude'), 'new session args ' + (l[1] && l[1].args)); ok(l[1] && real(l[1].pwd) === real(F[0].cwd), 'new session cwd');
    let bad = 'no-throw'; try { await R(`ipc.invoke('open', 'kx', '${H}', '../../etc/passwd', 80, 24)`); } catch (e) { bad = 'rejected'; } ok(bad === 'rejected', 'bad resume id accepted'); await closeAll();
  });

  // ---- 02 several live sessions, dots, notification
  await flow('02 several live sessions: dots + notification once + click focuses tab', async () => {
    for (const f of F.slice(0, 3)) { await openRow(f.id); await sleep(800); }
    const T = await tabsInfo(); ok(T.length === 3 && T.every(t => t.pid), 'tabs/pids ' + JSON.stringify(T)); const [t0, t1, t2] = T;
    const dots = async () => JSON.parse(await R(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('#list .it[data-key]')].map(e => [e.dataset.key, e.querySelector('.dot').className + '|' + getComputedStyle(e.querySelector('.dot')).backgroundColor])))`));
    liveFile(t0.pid, t0.sid, 'busy'); liveFile(t1.pid, t1.sid, 'busy'); liveFile(t2.pid, t2.sid, 'idle'); await R(`refreshLive()`); await sleep(200);
    let d = await dots(); ok(d[t0.k].startsWith('dot busy') && d[t1.k].startsWith('dot busy') && d[t2.k].startsWith('dot idle'), 'dots ' + JSON.stringify(d));
    const col = new Set(Object.values(d).map(x => x.split('|')[1])); ok(col.size === 2 && ![...col].some(c => /rgba\(0, 0, 0, 0\)/.test(c)), 'busy/idle colours not distinct+visible: ' + [...col]);
    await R(`__notes.length = 0`); liveFile(t0.pid, t0.sid, 'idle'); liveFile(t1.pid, t1.sid, 'waiting'); await R(`refreshLive()`); await sleep(200);
    const ns = JSON.parse(await R(`JSON.stringify(__notes.map(n => [n.title, n.opts.body]))`));
    ok(ns.length === 2 && ns.some(n => n[0] === 'Finished' && n[1] === t0.title) && ns.some(n => n[0] === 'Needs you' && n[1] === t1.title), 'notifications ' + JSON.stringify(ns));
    d = await dots(); ok(d[t1.k].startsWith('dot waiting') && d[t0.k].startsWith('dot idle') && d[t1.k].split('|')[1] !== d[t0.k].split('|')[1], 'dots after flip ' + JSON.stringify(d));
    await R(`refreshLive()`); await R(`refreshLive()`); await sleep(2300); ok(await R(`__notes.length`) === 2, 'notification repeated for unchanged status: ' + await R(`__notes.length`));
    const focus = await R(`document.hasFocus()`); info('hasFocus=' + focus);
    liveFile(t2.pid, t2.sid, 'waiting'); await R(`refreshLive()`); await sleep(200); ok(await R(`__notes.length`) === (focus ? 2 : 3), 'active-tab waiting notification count ' + await R(`__notes.length`));
    const n1 = await R(`__notes.findIndex(n => n.opts.body === ${JSON.stringify(t1.title)})`); ok(await R(`active`) === t2.k, 'precondition: active is last tab');
    await R(`__notes[${n1}].onclick()`); await sleep(300);
    ok(calls.show === 1 && calls.focus === 1, `show/focus calls ${calls.show}/${calls.focus}`); ok(await R(`active`) === t1.k, 'click did not switch to the notified tab'); ok(await R(`document.querySelector('.it.on').dataset.key`) === t1.k && await R(`$('title').textContent`) === t1.title, 'highlight/title did not follow');
    await R(`deskPrefs.notify = false`); await R(`__notes.length = 0`); liveFile(t0.pid, t0.sid, 'busy'); await R(`refreshLive()`); liveFile(t0.pid, t0.sid, 'idle'); await R(`refreshLive()`); ok(await R(`__notes.length`) === 0, 'notified while Mac notifications are off'); await R(`deskPrefs.notify = true`);
    liveFile(999999, F[3].id, 'busy'); liveFile(process.pid, F[3].id, 'busy', 'headless'); await R(`refreshLive()`); await sleep(100);
    ok(await R(`document.querySelector('#list .it[data-id="${F[3].id}"] .dot').className`) === 'dot ', 'stale-pid / headless file shows a dot: ' + await R(`document.querySelector('#list .it[data-id="${F[3].id}"] .dot').className`));
    fs.unlinkSync(path.join(LIVE, '999999.json')); fs.unlinkSync(path.join(LIVE, process.pid + '.json'));
    liveFile(t2.pid, t2.sid, 'busy'); await sleep(2800); ok((await dots())[t2.k].startsWith('dot busy'), 'dot did not update by itself within the 2s poll: ' + (await dots())[t2.k]);
    for (const n of fs.readdirSync(LIVE)) fs.unlinkSync(path.join(LIVE, n)); await closeAll(); await R(`refreshLive()`);
  });

  await flow('03 notification for a session that is NOT open resumes it', async () => {
    const child = cp.spawn('sleep', ['300']); await sleep(100); fs.writeFileSync(LOG, '');
    try { liveFile(child.pid, F[3].id, 'busy'); await R(`refreshLive()`); await R(`__notes.length = 0`); liveFile(child.pid, F[3].id, 'waiting'); await R(`refreshLive()`); await sleep(200);
      ok(await R(`__notes.length`) === 1 && await R(`__notes[0].title`) === 'Needs you' && await R(`__notes[0].opts.body`) === F[3].title, 'notification: ' + await R(`JSON.stringify(__notes.map(n => [n.title, n.opts.body]))`));
      await R(`__notes[0].onclick()`); await sleep(900); const T = await tabsInfo(); ok(T.length === 1 && T[0].sid === F[3].id, 'no tab for the session'); ok(claudeLogs().some(l => l.args.endsWith('--resume ' + F[3].id)), 'not resumed with its id: ' + JSON.stringify(claudeLogs().map(l => l.args)));
      ok(await R(`$('title').textContent`) === F[3].title, 'title');
    } finally { child.kill(); for (const n of fs.readdirSync(LIVE)) fs.unlinkSync(path.join(LIVE, n)); await closeAll(); await R(`refreshLive()`); }
  });

  await flow('04 transcript grows (appended lines): title + usage update, dedupe, half-written tail', async () => {
    await openRow(F[2].id); await sleep(700); ok(/^1 turn/.test(await R(`$('use').textContent`)), 'start usage "' + await R(`$('use').textContent`) + '"');
    fs.appendFileSync(F[2].file, [A('m1'), A('m2'), A('m1')].map(x => JSON.stringify(x)).join('\n') + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Gamma renamed live' }) + '\n');
    fs.appendFileSync(F[2].file, '{"type":"assistant","message":{"id":"half","usa'); // half-written tail
    await R(`refresh()`); ok((await titles()).includes('Gamma renamed live'), 'new title not in sidebar: ' + JSON.stringify(await titles()));
    const key = (await tabsInfo())[0].k; await R(`show('${key}')`); await sleep(700); const u = await R(`$('use').textContent`); ok(/^3 turns/.test(u), 'usage after growth "' + u + '" (want 3 turns, duplicate id counted once, half line ignored)');
    ok((await R(`document.querySelector('#list .it[data-key] .t').textContent`)) === F[2].title, 'open-tab row title is stale: the Open group keeps "' + await R(`document.querySelector('#list .it[data-key] .t').textContent`) + '" after the title changed');
    await closeAll(); F[2].title = 'Gamma renamed live';
  });

  await flow('05 >300 sessions: Load more appears, loads the rest, stays responsive', async () => {
    const N = 700, base = fs.readdirSync(PROJ).length; for (let i = 0; i < N; i++) mk('-bulk', crypto.randomUUID(), [U('Bulk prompt ' + i, CWD, 'x')], 86400 * 30 + i);
    const cold = await R(`(async () => { const t = performance.now(); await refresh(); return performance.now() - t; })()`); info(`cold refresh ${Math.round(cold)}ms`);
    const total = await R(`total`); ok(total === N + 5, 'total ' + total); ok(await rows() === 300, 'rows ' + await rows());
    const more = await R(`$('more') && $('more').textContent`); ok(more === `Load more (${N + 5 - 300} older)`, 'more button: ' + more);
    const warm = await R(`(async () => { const t = performance.now(); const p = refresh(); const t1 = performance.now(); await ipc.invoke('name'); const ping = performance.now() - t1; await p; return [performance.now() - t, ping]; })()`); info(`warm refresh ${Math.round(warm[0])}ms (main-thread ping during it ${Math.round(warm[1])}ms)`);
    ok(cold < 3000, 'cold refresh ' + Math.round(cold) + 'ms'); ok(warm[0] < 500, 'warm refresh ' + Math.round(warm[0]) + 'ms');
    let t = Date.now(); await R(`$('more').click()`); ok(await waitFor(async () => await rows() === 600), 'after Load more rows ' + await rows()); info(`Load more #1 ${Date.now() - t}ms`);
    ok(await R(`$('more').textContent`) === `Load more (${N + 5 - 600} older)`, 'second more label: ' + await R(`$('more').textContent`));
    t = Date.now(); await R(`$('more').click()`); ok(await waitFor(async () => await rows() === N + 5), 'after 2nd Load more rows ' + await rows()); info(`Load more #2 ${Date.now() - t}ms`); ok(await R(`!$('more')`), 'Load more still shown with everything loaded');
    const rd = await R(`(() => { const t = performance.now(); render(); const a = performance.now() - t; $('q').value = 'bulk prompt 69'; const t2 = performance.now(); $('q').dispatchEvent(new Event('input')); const b = performance.now() - t2; const n = document.querySelectorAll('#list .it[data-id]').length; $('q').value = ''; render(); return [a, b, n]; })()`);
    info(`render ${N + 5} rows ${Math.round(rd[0])}ms, search ${Math.round(rd[1])}ms`); ok(rd[0] < 500 && rd[1] < 500, 'sidebar slow: ' + rd); ok(rd[2] === 11, 'search "bulk prompt 69" rows ' + rd[2] + ' (want 11)');
    fs.rmSync(path.join(PROJ, '-bulk'), { recursive: true }); await R(`limit = 300; refresh()`); await sleep(400); ok(await rows() === 5, 'rows after cleanup ' + await rows());
  });

  const LONG = { id: crypto.randomUUID(), n: 40000, uniq: 0, out: 0 };
  await flow('06 multi-MB transcript: usage parses off the UI thread, ms measured', async () => {
    const lines = [JSON.stringify(U('Long session first prompt', CWD, LONG.id)), JSON.stringify({ type: 'ai-title', aiTitle: 'Long AI title' })]; let f = path.join(PROJ, '-long'); fs.mkdirSync(f); f = path.join(f, LONG.id + '.jsonl'); fs.writeFileSync(f, lines.join('\n') + '\n');
    const pad = 'x'.repeat(400), seen = new Set(); let buf = [];
    for (let i = 0; i < LONG.n; i++) { const id = 'm' + (i % 39900); const a = A(id, i % 7 + 1); a.message.content[0].text = pad; buf.push(JSON.stringify(a)); if (!seen.has(id)) { seen.add(id); LONG.out += i % 7 + 1; }
      if (i === LONG.n / 2) buf.push(JSON.stringify({ type: 'custom-title', customTitle: 'Long custom renamed', sessionId: LONG.id })); if (buf.length > 2000) { fs.appendFileSync(f, buf.join('\n') + '\n'); buf = []; } }
    fs.appendFileSync(f, buf.join('\n') + '\n'); LONG.uniq = seen.size; LONG.file = f; const t = new Date(Date.now() - 3000); fs.utimesSync(f, t, t);
    const mb = fs.statSync(f).size / 1048576; info(`file ${mb.toFixed(1)}MB, ${LONG.n} lines`);
    const lm = await R(`(async () => { const t = performance.now(); await refresh(); return performance.now() - t; })()`); info(`list incl. the new file ${Math.round(lm)}ms`); ok(lm < 1500, 'list with big file ' + Math.round(lm) + 'ms');
    const u = await R(`(async () => { let max = 0, stop = false; const t0 = performance.now(); const p = ipc.invoke('usage', ${JSON.stringify(f)}).then(r => { stop = true; return r; });
      while (!stop) { const t = performance.now(); await ipc.invoke('name'); max = Math.max(max, performance.now() - t); await new Promise(r => setTimeout(r, 20)); } return { max, total: performance.now() - t0, r: await p }; })()`);
    info(`usage ${Math.round(u.total)}ms, worst main-thread ping during it ${Math.round(u.max)}ms`); ok(u.total < 5000, 'usage took ' + Math.round(u.total) + 'ms'); ok(u.max < 500, 'main thread blocked ' + Math.round(u.max) + 'ms');
    ok(u.r.turns === LONG.uniq && u.r.output === LONG.out, `usage ${u.r.turns}/${u.r.output} vs expected ${LONG.uniq}/${LONG.out}`);
    const t2 = Date.now(); await openRow(LONG.id); ok(await waitFor(async () => /turns/.test(await R(`$('use').textContent`)), 8000), 'usage line never appeared'); info(`UI usage line after ${Date.now() - t2}ms: ${await R(`$('use').textContent`)}`); await closeAll();
  });
  await flow('06b long session: /rename buried mid-file is kept as the title', async () => {
    const t = await titles(); ok(t.includes('Long custom renamed'), 'sidebar shows ' + JSON.stringify(t.filter(x => /^Long/.test(x))) + ' (custom-title is 12MB from either end; only first+last 256KB are read)');
  });
  await flow('06c session whose first prompt is >256KB (big paste) still listed with a title', async () => {
    const id = crypto.randomUUID(); mk('-bigpaste', id, [], 1, JSON.stringify(U('BigPaste ' + 'y'.repeat(400000), CWD, id)) + '\n' + [1, 2, 3].map(() => JSON.stringify(A())).join('\n') + '\n' + 'z'.repeat(300000) + '\n');
    await R(`refresh()`); const t = await titles(); ok(t.some(x => x.startsWith('BigPaste')), 'session missing from sidebar (parsed as "(empty session)" and hidden): ' + JSON.stringify(t.filter(x => !/^(Alpha|Beta|Gamma|Delta|Epsilon|Long)/.test(x))));
    fs.rmSync(path.join(PROJ, '-bigpaste'), { recursive: true });
  });
  fs.rmSync(path.join(PROJ, '-long'), { recursive: true }); await R(`refresh()`);

  await flow('07 corrupt / half-written jsonl: no crash, sensible rows', async () => {
    const dir = '-corrupt', id = () => crypto.randomUUID(); const ids = [id(), id(), id(), id()];
    mk(dir, ids[0], [], 1, JSON.stringify(U('Truncated session prompt', CWD, ids[0])) + '\n{"type":"assistant","message":{"id":"x","usa');
    mk(dir, ids[1], [], 1, crypto.randomBytes(4096).toString('latin1')); mk(dir, ids[2], [], 1, ''); mk(dir, ids[3], [], 1, '{"type":"custom-ti\n' + JSON.stringify(U('After garbage prompt', CWD, ids[3])) + '\n');
    await R(`window.__rej.length = 0`); ok(await safeRefresh('refresh') === 'ok', 'refresh threw'); const t = await titles();
    ok(t.includes('Truncated session prompt') && t.includes('After garbage prompt'), 'titles ' + JSON.stringify(t)); ok(F.every(f => t.includes(f.title)), 'fixtures vanished: ' + JSON.stringify(t));
    await R(`$('showEmpty').click()`); const all = await titles(); ok(all.length === 5 + 4 && all.filter(x => x === '(empty session)').length === 2, 'with Show empty: ' + JSON.stringify(all)); await R(`$('showEmpty').click()`);
    const u = await R(`ipc.invoke('usage', ${JSON.stringify(path.join(PROJ, dir, ids[0] + '.jsonl'))}).then(r => r.turns, e => 'THROW ' + e.message)`); ok(u === 0, 'usage of truncated file: ' + u);
    await sleep(100); ok(!(await R(`__rej.length`)), 'unhandled rejections: ' + await R(`JSON.stringify(__rej)`)); fs.rmSync(path.join(PROJ, dir), { recursive: true });
  });
  await flow('07b type-confused fields in one bad file do not blank the whole sidebar', async () => {
    const bad = { 'content:[null]': JSON.stringify({ type: 'user', cwd: CWD, message: { content: [null] } }), 'customTitle:42': JSON.stringify({ type: 'custom-title', customTitle: 42 }), 'cwd:123': JSON.stringify({ type: 'user', cwd: 123, message: { content: 'hi' } }) };
    for (const [k, line] of Object.entries(bad)) { const id = crypto.randomUUID(), f = mk('-confused', id, [], 0, line + '\n'); await R(`window.__rej.length = 0`); const r = await safeRefresh('refresh'); await sleep(100);
      const t = await titles(); ok(r === 'ok' && F.every(x => t.includes(x.title)), `${k}: refresh=${r}; sidebar rows ${t.length}; ${await R(`JSON.stringify(__rej).slice(0, 160)`)}`); fs.unlinkSync(f); await R(`refresh().catch(() => 0)`); await sleep(100); }
    fs.rmSync(path.join(PROJ, '-confused'), { recursive: true }); await R(`refresh()`);
  });

  await flow('08 missing / empty projects + sessions folders', async () => {
    const off = PROJ + '.off', loff = LIVE + '.off'; await R(`window.__rej.length = 0`);
    try { fs.renameSync(PROJ, off); fs.mkdirSync(PROJ);
      ok(await safeRefresh('refresh') === 'ok', 'empty projects dir: refresh threw'); const txt = await R(`$('list').textContent`); info('empty projects dir shows: "' + txt + '"'); ok(!/match/i.test(txt), `fresh install (no sessions, no search) says "${txt}"`);
      fs.rmdirSync(PROJ); const r = await safeRefresh('refresh'); ok(r === 'ok', 'missing projects dir: ' + r); info('after missing-projects refresh the sidebar shows: ' + (await R(`$('list').textContent`)).slice(0, 60));
      fs.renameSync(LIVE, loff); const r2 = await safeRefresh('refreshLive'); ok(r2 === 'ok', 'missing sessions dir: ' + r2); await sleep(2500);
    } finally { try { fs.rmdirSync(PROJ); } catch {} if (!fs.existsSync(PROJ)) fs.renameSync(off, PROJ); if (!fs.existsSync(LIVE)) fs.renameSync(loff, LIVE); }
    ok(!(await R(`__rej.length`)), 'unhandled rejections in the renderer: ' + await R(`JSON.stringify([...new Set(__rej)]).slice(0, 220)`) + ' (x' + await R(`__rej.length`) + ')');
    await R(`refresh()`); await R(`refreshLive()`); await sleep(300); ok(F.every(f => true) && (await rows()) === 5, 'did not recover after folders came back: rows ' + await rows());
  });

  await flow('09 session whose cwd no longer exists: tab says why', async () => {
    const id = crypto.randomUUID(), gone = path.join(H, 'deleted-project'); mk('-gone', id, [U('Orphan prompt', gone, id)], 0); await R(`refresh()`); await R(`window.__rej.length = 0`); fs.writeFileSync(LOG, '');
    await openRow(id); await sleep(1800); const T = await tabsInfo(); ok(T.length === 1, 'tabs ' + T.length); const txt = T[0] ? (await text(T[0].k)).trim() : '';
    info('terminal shows: ' + JSON.stringify(txt.slice(0, 100)) + '; pid=' + (T[0] && T[0].pid) + '; spawns=' + claudeLogs().length + '; rejections=' + JSON.stringify(await R(`__rej`)).slice(0, 120));
    ok(/no such|not exist|missing|not found|folder|directory|cwd/i.test(txt), 'user sees no explanation (terminal blank or only "session ended")'); ok(!(await R(`__rej.length`)), 'unhandled rejection: ' + await R(`JSON.stringify(__rej)`).then(s => s.slice(0, 160)));
    await closeAll(); fs.rmSync(path.join(PROJ, '-gone'), { recursive: true });
  });

  await flow('10 claude missing from PATH / exits at once: clear message, app responsive', async () => {
    const savedPath = process.env.PATH, savedShell = process.env.SHELL;
    try { process.env.SHELL = '/bin/zsh'; process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'; await R(`$('new').click()`);
      const ended = await waitFor(async () => /session ended/.test(await text((await tabsInfo())[0].k)), 8000); const txt = (await text((await tabsInfo())[0].k)).trim(); info('PATH without claude -> terminal: ' + JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 140)));
      ok(ended, 'no "session ended" within 8s (hang?)'); ok(/command not found: claude/.test(txt), 'no "command not found"'); ok(await lat() < 500, 'app unresponsive'); await closeAll();
      process.env.SHELL = FAKESH; process.env.FAKE_MODE = 'exit'; await R(`$('new').click()`); const k = (await tabsInfo())[0].k; ok(await waitFor(async () => /session ended/.test(await text(k)), 4000), 'immediate exit: no ended message'); ok(/claude: boom/.test(await text(k)), 'its output was lost');
      info('exit code is not shown to the user'); await closeAll();
    } finally { process.env.PATH = savedPath; process.env.SHELL = savedShell; process.env.FAKE_MODE = 'idle'; }
  });

  await flow('11 logged-out claude: what the user sees; account label after /login', async () => {
    process.env.FAKE_MODE = 'loggedout'; await R(`$('new').click()`); await sleep(900); const k = (await tabsInfo())[0].k; ok(/Not logged in/.test(await text(k)), 'claude output not shown'); process.env.FAKE_MODE = 'idle';
    ok(await R(`$('acctMail').textContent`) === 'Account', 'logged-out label ' + await R(`$('acctMail').textContent`)); await R(`$('acct').click()`); info('menu mail line while logged out: "' + await R(`$('menuMail').textContent`) + '"'); await R(`document.body.click()`);
    fs.writeFileSync(path.join(H, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'test@example.com', planDisplayName: 'Max' } })); await sleep(3500);
    ok(await R(`$('acctMail').textContent`) === 'test@example.com', `after /login the account label still says "${await R(`$('acctMail').textContent`)}" (read once at startup)`); await closeAll();
  });

  await flow('12 drag-drop a file onto the terminal: path pasted shell-quoted', async () => {
    process.env.FAKE_MODE = 'cat'; await R(`$('new').click()`); await sleep(800); process.env.FAKE_MODE = 'idle'; const k = (await tabsInfo())[0].k, writes = []; ipcMain.on('write', (e, kk, d) => writes.push(d));
    const paths = ['/tmp/plain.txt', `/tmp/it's a "q" $HOME \`x\` ;rm.txt`, '/tmp/new\nline.txt'];
    const patched = await R(`(() => { try { const w = require('electron').webUtils; const m = ${JSON.stringify(Object.fromEntries(paths.map((p, i) => ['f' + i + '.txt', p])))}; w.getPathForFile = f => m[f.name]; return w.getPathForFile({ name: 'f0.txt' }) === m['f0.txt']; } catch (e) { return String(e); } })()`);
    if (patched !== true) { note('12 drag-drop', 'cannot stub webUtils.getPathForFile: ' + patched); await closeAll(); return; }
    const prevented = await R(`(() => { const dt = new DataTransfer(); for (let i = 0; i < 3; i++) dt.items.add(new File(['x'], 'f' + i + '.txt')); const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }); $('terms').dispatchEvent(ev); return ev.defaultPrevented; })()`); await sleep(500);
    const w = writes.filter(d => d.includes('/tmp/')); ok(prevented, 'default not prevented (browser would navigate)'); ok(w.length === 1, 'writes ' + JSON.stringify(writes)); const pasted = w[0] || '';
    ok(!/\n/.test(pasted) && !pasted.includes('new'), 'path with a newline was pasted: ' + JSON.stringify(pasted)); ok(pasted.endsWith(' '), 'no trailing space');
    const rt = cp.spawnSync('/bin/sh', ['-c', 'printf "%s\\n" ' + pasted]).stdout.toString().split('\n').filter(Boolean); ok(JSON.stringify(rt) === JSON.stringify(paths.slice(0, 2)), 'shell round-trip ' + JSON.stringify(rt));
    ok((await text(k)).includes('plain.txt'), 'pasted text not visible in terminal'); await closeAll(); writes.length = 0;
    await R(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'f0.txt')); $('terms').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`); await sleep(200); ok(!writes.length, 'drop with no open tab wrote to a pty');
  });

  // clone of the repo for install.sh tests (cheap: no node_modules; the CURRENT install.sh is copied over HEAD's)
  const CLONE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deskclone-')), 'cc-desk'); cp.execFileSync('git', ['clone', '-q', REPO, CLONE]); fs.copyFileSync(path.join(REPO, 'install.sh'), path.join(CLONE, 'install.sh'));

  await flow('13 Update & restart: confirm with open sessions, failure message, success path', async () => {
    const click = async () => { wc.send('update', 3); await sleep(200); await R(`document.querySelector('#upd').click()`); };
    // (a) a session is open -> asks first; "Later" runs nothing
    await R(`$('new').click()`); await sleep(700); fs.writeFileSync(LOG, ''); calls.dialogs.length = 0; dialogAnswer = 1; await click(); await sleep(700);
    ok(calls.dialogs.length === 1 && /1 open session keeps running/.test(calls.dialogs[0].detail) && calls.dialogs[0].buttons.join() === 'Update & restart,Later' && calls.dialogs[0].defaultId === 0, 'dialog ' + JSON.stringify(calls.dialogs[0]));
    ok(/Install & restart/.test(await R(`$('tip').textContent`)) && !shlog().some(l => /install.sh/.test(l.args)), 'Later still ran the update or left the link stuck: ' + await R(`$('tip').textContent`)); await closeAll(); await sleep(500);
    // (b) update command fails (fake shell runs install.sh --update from a temp clone with node off PATH)
    process.env.FAKE_MODE = 'update_fail'; process.env.FAKE_CLONE = CLONE; fs.writeFileSync(LOG, ''); await click(); await sleep(2500); const tip = await R(`$('tip').textContent`); info('failure line shown: "' + tip + '"');
    const u = shlog().find(l => /install.sh/.test(l.args)); ok(u && u.args === '-ilc ./install.sh --update', 'command: ' + (u && u.args)); ok(u && real(u.pwd) === real(REPO), 'cwd ' + (u && u.pwd) + ' (should be the app folder)');
    ok(u && /\.app$/.test(u.app) && !u.app.startsWith(path.join(os.homedir(), 'Applications')), 'CC_DESK_APP=' + (u && u.app)); ok(/^Update failed/.test(tip), 'tip ' + tip); ok(/Needs Node/.test(tip), 'the reason ("Needs Node.js 20+") is not shown: install.sh echoes to stdout, main.js only reads stderr');
    // (c) success -> relaunch + exit(0) (stubbed)
    process.env.FAKE_MODE = 'update_ok'; app.relaunch = () => { calls.relaunch++; }; app.exit = c => { calls.exit.push(c); }; await click(); await sleep(1500); app.relaunch = realRelaunch; app.exit = realExit; process.env.FAKE_MODE = 'idle';
    ok(calls.relaunch === 1 && calls.exit.join() === '0', `relaunch ${calls.relaunch}, exit ${calls.exit}`);
  });
  note('13b full install.sh --update run', 'npm ci + Electron download/rebuild is >200MB (node_modules is ~300MB); only the pre-check path and the button wiring are run');

  await flow('14 fresh Mac: install.sh pre-checks with node/claude/xcode missing', async () => {
    const mkbin = (extra = {}) => { const b = fs.mkdtempSync(path.join(os.tmpdir(), 'deskbin-')); for (const t of ['uname', 'dirname']) fs.symlinkSync('/usr/bin/' + t, path.join(b, t));
      for (const [n, body] of Object.entries(extra)) fs.writeFileSync(path.join(b, n), '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); return b; };
    const run = b => { const r = cp.spawnSync('/bin/bash', ['install.sh'], { cwd: CLONE, env: { HOME: H, PATH: b }, timeout: 20000 }); return { code: r.status, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }; };
    let r = run(mkbin()); ok(r.code === 1 && /Needs Node\.js 20\+/.test(r.out), 'no node: ' + JSON.stringify(r)); info('no node -> "' + r.out + '"' + (r.err ? ' (stderr: ' + r.err + ')' : ' (printed on stdout)'));
    r = run(mkbin({ node: 'echo v22.1.0' })); ok(r.code === 1 && /Needs Claude Code installed first/.test(r.out), 'no claude: ' + JSON.stringify(r));
    r = run(mkbin({ node: 'echo v22.1.0', claude: 'true', 'xcode-select': 'exit 2' })); ok(r.code === 1 && /command line tools/.test(r.out), 'no xcode: ' + JSON.stringify(r));
    r = run(mkbin({ node: 'echo v14.0.0', claude: 'true', 'xcode-select': 'exit 0', npm: 'echo REACHED_NPM; exit 99' })); ok(!/REACHED_NPM/.test(r.out) && r.code === 1, 'Node v14 passes the "Needs Node.js 20+" check and goes on to npm ci (only `command -v node` is tested): ' + JSON.stringify(r).slice(0, 120));
  });

  const good = fs.readFileSync(SETF, 'utf8'), mkroSettings = () => { fs.chmodSync(SETF, 0o644); fs.writeFileSync(SETF, good); };
  const pick = async (page, key, val) => { await R(`openSettings('${page}')`); await sleep(300); await R(`(() => { const e = document.querySelector('[data-k="${key}"]'); e.value = '${val}'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`); };
  await flow('15a settings.json invalid JSON: error shown, file kept', async () => {
    const bad = '{"model": "opus", "theme": '; fs.writeFileSync(SETF, bad); await R(`openSettings('general')`); await sleep(400); const pg = await R(`$('setPage').textContent`);
    ok(/error|invalid|unreadable|could not|broken|corrupt/i.test(await R(`$('setBody').textContent`)), 'Settings opens on silent defaults, no warning that the file is unreadable: "' + pg.slice(0, 80) + '..."');
    await pick('model', 'model', 'haiku'); await sleep(60); const early = await R(`$('setMsg').textContent`); await sleep(700); const late = await R(`$('setMsg').textContent`); info(`message at 60ms "${early}", at 760ms "${late}"`);
    ok(/Not saved/.test(late), `error message vanishes (60ms: "${early}", 760ms: "${late}"): saveSetting's catch calls openSettings(), which clears #setMsg`);
    ok(fs.readFileSync(SETF, 'utf8') === bad, 'invalid file was modified'); ok(!fs.existsSync(SETF + '.desk-tmp') && !fs.readdirSync(C).some(f => /desk-backup/.test(f)), 'stray tmp/backup files'); mkroSettings();
  });
  await flow('15b settings.json read-only: not overwritten', async () => {
    fs.chmodSync(SETF, 0o444); try { await pick('model', 'model', 'haiku'); await sleep(800); const now = fs.readFileSync(SETF, 'utf8'), msg = await R(`$('setMsg').textContent`), mode = (fs.statSync(SETF).mode & 0o777).toString(8);
      info(`after change: message "${msg}", model in file ${JSON.parse(now).model}, mode ${mode}`); ok(now === good, `read-only file was replaced (rename over it ignores the 0444 bit): message "${msg}", mode now ${mode}`); } finally { mkroSettings(); }
  });
  await flow('15c ~/.claude-desk.json corrupt: not silently wiped', async () => {
    const bad = '{"pins": ["keep-me"], "fontSize": 1'; fs.writeFileSync(DESKF, bad); await pick('app', 'desk.fontSize', '16'); await sleep(700); const now = fs.readFileSync(DESKF, 'utf8');
    ok(now === bad || fs.readdirSync(H).some(f => /^\.claude-desk\.json\./.test(f)), `corrupt prefs file overwritten by {fontSize} with no backup (pins lost): ${now.replace(/\s+/g, ' ')}`); fs.writeFileSync(DESKF, '{}');
    await R(`openSettings('app')`); await R(`$('setClose').click()`);
  });

  await flow('16 two app instances: single-instance lock (real main.js, probe on the same lock)', async () => {
    ok(app.hasSingleInstanceLock(), 'driver does not hold the lock'); let second = 0; app.on('second-instance', () => second++); calls.show = calls.focus = 0;
    const probe = path.join(H, 'probe.js'); fs.writeFileSync(probe, `const { app } = require('electron'); app.setActivationPolicy('prohibited'); app.setPath('userData', process.env.PROBE_UD);
      const orig = app.requestSingleInstanceLock.bind(app); app.requestSingleInstanceLock = () => { const l = orig(); console.log('LOCK=' + l); return l; };
      let wins = 0, quit = 0; app.on('browser-window-created', (e, w) => { wins++; w.hide(); }); app.on('before-quit', () => quit++);
      require(${JSON.stringify(path.join(REPO, 'main.js'))}); setTimeout(() => { console.log('WINDOWS=' + wins + ' QUIT=' + quit); app.exit(0); }, 4000);`);
    const env = { ...process.env, PROBE_UD: app.getPath('userData') }; delete env.ELECTRON_RUN_AS_NODE; delete env.DESK_UITEST_ADV; let out = '';
    await new Promise(res => { const c = cp.spawn(process.execPath, [probe], { env }); c.stdout.on('data', d => out += d); c.stderr.on('data', () => {}); c.on('exit', res); setTimeout(() => { c.kill(); res(); }, 20000); }); await sleep(300);
    info('second instance printed: ' + out.trim().replace(/\n/g, ' '));
    ok(/LOCK=false/.test(out), 'second instance got the lock'); ok(second === 1 && calls.show === 1 && calls.focus === 1, `first instance: second-instance events ${second}, show ${calls.show}, focus ${calls.focus}`);
    ok(!/WINDOWS=[1-9]/.test(out), 'second instance created a window: ' + out); ok(!/WINDOWS=/.test(out), 'second instance did not exit by itself within 4s');
  });

  await flow('17 10 quick open/close cycles + burst: no leaked pty processes', async () => {
    await closeAll(); await sleep(600); const before = ptyProcs().length;
    for (let i = 0; i < 10; i++) { await R(`$('new').click()`); await sleep(250); ok(ptyProcs().length === before + 1, `cycle ${i}: live ptys ${ptyProcs().length}`); await R(`document.querySelector('.it.on [data-close]').click()`); await sleep(250); }
    await sleep(1200); const after = ptyProcs().length; ok(after === before && await R(`Object.keys(tabs).length + document.querySelectorAll('.term').length`) === 0, `ptys ${before} -> ${after}; leftover ${JSON.stringify(ptyProcs().map(p => p.cmd))}`); info(`cycles: ptys ${before} -> ${after}`);
    await R(`for (let i = 0; i < 10; i++) $('new').click()`); await sleep(1500); const n = await R(`Object.keys(tabs).length`), terms = await R(`document.querySelectorAll('.term').length`), procs = ptyProcs().length; info(`burst of 10 in one tick: tabs ${n}, terms in DOM ${terms}, ptys ${procs}`);
    await closeAll(); await sleep(1500); const left = ptyProcs().length; ok(n === 10 && terms === 10 && procs === 10 && left === 0, `burst: tabs ${n}, DOM terms ${terms}, ptys ${procs}, leaked after close ${left} (key 'k'+Date.now() collides inside one millisecond)`);
  });

  console.log('\n=== ADVANCED UITEST RESULTS ===');
  for (const [n, s, e, i] of results) console.log(`${s.padEnd(10)} ${n}${i ? '\n           info: ' + i : ''}${e ? '\n           ' + e : ''}`);
  const bad = results.filter(r => r[1] === 'FAIL').length, nt = results.filter(r => r[1].startsWith('NOT_TESTED')).length;
  console.log(`\n${results.length - bad - nt} pass, ${bad} fail, ${nt} not tested; renderer console errors: ${jserr.length}${jserr.length ? ' e.g. ' + jserr[0].slice(0, 150) : ''}`);
  for (const d of descendants()) if (/sleep|fakesh|cat/.test(d.cmd)) try { process.kill(d.pid, 'SIGKILL'); } catch {}
  dialog.showMessageBoxSync = () => 0; setTimeout(() => realExit(0), 100);
}
