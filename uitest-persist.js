// Quit/reopen test for the background helper. Run: node uitest-persist.js  (hidden, sandbox HOME, fake shell, own socket, real sessions untouched)
// The launcher runs the real main.js + index.html in several separate app launches, so "quit" is a real process exit.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const alive = p => { try { process.kill(p, 0); return true; } catch { return false; } };
if (!process.versions.electron) {
  const H = fs.mkdtempSync(path.join(os.tmpdir(), 'dkp-')), C = path.join(H, '.claude'), F = path.join(H, 'r.json'); let fails = 0;
  for (const d of ['sessions', 'projects']) fs.mkdirSync(path.join(C, d), { recursive: true });
  fs.writeFileSync(path.join(C, 'settings.json'), '{"model":"opus"}'); fs.writeFileSync(path.join(H, '.claude.json'), '{}');
  fs.writeFileSync(path.join(H, 'fakesh'), '#!/bin/sh\nexec cat\n', { mode: 0o755 });
  const phase = (name, extra = {}) => {
    const env = { ...process.env, HOME: H, SHELL: path.join(H, 'fakesh'), PHASE: name, RESULT: F }; delete env.ELECTRON_RUN_AS_NODE; delete env.DESK_SMOKE; delete env.DESK_PTYD_SOCK; Object.assign(env, extra);
    const r = cp.spawnSync(require('electron'), [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000, encoding: 'utf8' });
    const s = (r.stdout || '').split('\n').filter(l => /^(PASS|FAIL) /.test(l)); s.forEach(l => { console.log(l); if (l.startsWith('FAIL')) fails++; });
    if (!s.length || r.error) { console.log(`FAIL ${name}: no result ${r.error || ''} ${(r.stderr || '').slice(-300)}`); fails++; }
  };
  const helperProcs = () => cp.spawnSync('pgrep', ['-f', path.join(__dirname, 'ptyd.js')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).filter(p => { try { return cp.spawnSync('ps', ['eww', '-o', 'command=', '-p', p], { encoding: 'utf8' }).stdout.includes(H); } catch { return false; } });
  phase('open'); const pid = JSON.parse(fs.readFileSync(F, 'utf8')).pid;
  const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  check(alive(pid), 'session process survives a real app quit'); check(helperProcs().length === 1, 'exactly one helper running after quit');
  phase('away'); phase('back', { WANT_PID: String(pid) }); check(helperProcs().length === 1, 'reopening did not start a second helper');
  phase('ask-keep', { WANT_PID: String(pid) }); check(alive(pid), 'Keep running in the quit dialog keeps the session');
  phase('ask-cancel', { WANT_PID: String(pid) }); check(alive(pid), 'Cancel keeps the session');
  phase('ask-always', { WANT_PID: String(pid) }); check(alive(pid) && JSON.parse(fs.readFileSync(path.join(H, '.claude-desk.json'), 'utf8')).quitSessions === 'keep', 'Always keep running is saved');
  phase('close-tab', { WANT_PID: String(pid) });
  phase('stop');  const stopped = JSON.parse(fs.readFileSync(F, 'utf8')).pid; check(!alive(stopped), 'Stop them ends the session');
  phase('idle', { DESK_IDLE_MS: '1500', DESK_IDLE_TICK: '300', DESK_PTYD_SOCK: path.join(H, 'i.sock') });
  phase('phone', { DESK_NTFY_URL: 'http://127.0.0.1:47917', DESK_PHONE_AFTER: '800', DESK_PHONE_TICK: '150', DESK_PTYD_SOCK: path.join(H, 'p.sock') });
  phase('killed-helper');
  for (const p of helperProcs()) try { process.kill(+p); } catch {}
  fs.rmSync(H, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
}
const { app, BrowserWindow, dialog } = require('electron');
app.setAppPath(__dirname); app.setActivationPolicy && app.setActivationPolicy('prohibited'); app.requestSingleInstanceLock = () => true; app.setPath('userData', path.join(os.homedir(), 'ud'));
app.on('browser-window-created', (e, w) => w.hide());
const sleep = ms => new Promise(r => setTimeout(r, ms)), P = process.env.PHASE, WANT = +process.env.WANT_PID;
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m), save = o => fs.writeFileSync(process.env.RESULT, JSON.stringify(o)), prefs = path.join(os.homedir(), '.claude-desk.json');
const setPref = v => fs.writeFileSync(prefs, JSON.stringify({ quitSessions: v }));
const answer = n => { dialog.showMessageBoxSync = () => n; };
app.whenReady().then(async () => {
  if (P === 'away') { // like something happening while the app is closed: no window at all
    const c = require('./ptyd').client(() => {}); const items = await c.list(); c.write(items[0].key, 'while-away\n'); await sleep(400); ok(items.length === 1, 'helper still holds the session with no app open'); app.exit(0); return; }
  if (P === 'idle') {
    const { client } = require('./ptyd'), msgs = [], c = client(m => msgs.push(m)), open = k => c.open({ key: k, shell: process.env.SHELL, args: [], cols: 80, rows: 24, cwd: os.homedir(), env: process.env, meta: {} });
    const a = await open('busy'), b = await open('idle'); fs.writeFileSync(path.join(os.homedir(), '.claude/sessions', a + '.json'), JSON.stringify({ status: 'busy' })); await sleep(3000);
    ok(alive(a), 'a busy session is never stopped for being idle'); ok(!alive(b), 'an idle session stops after the time limit');
    fs.unlinkSync(path.join(os.homedir(), '.claude/sessions', a + '.json')); await sleep(2000); ok(!alive(a), 'the same session stops once it is no longer busy'); app.exit(0); return; }
  if (P === 'phone') { // app closed: only the helper is running. Only "waiting" past the limit may ever alert.
    const posts = []; require('http').createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { posts.push({ url: q.url, title: q.headers.title, b }); r.end('ok'); }); }).listen(47917);
    const statusF = pid => path.join(os.homedir(), '.claude/sessions', pid + '.json'), st = (pid, s) => fs.writeFileSync(statusF(pid), JSON.stringify({ status: s }));
    fs.writeFileSync(prefs, JSON.stringify({ phoneAlerts: true, ntfyTopic: 'ccdesk-test' }));
    const c = require('./ptyd').client(() => {}), pid = await c.open({ key: 'p', shell: process.env.SHELL, args: [], cols: 80, rows: 24, cwd: os.homedir(), env: process.env, meta: { title: 'Fixture title' } });
    st(pid, 'busy'); await sleep(1300); ok(posts.length === 0, 'busy never alerts the phone');
    st(pid, 'idle'); await sleep(1300); ok(posts.length === 0, 'idle or finished never alerts the phone');
    st(pid, 'waiting'); await sleep(400); ok(posts.length === 0, 'no alert before the wait limit');
    await sleep(1000); ok(posts.length === 1 && posts[0].url === '/ccdesk-test' && posts[0].title === 'Claude needs you' && posts[0].b === 'Fixture title', 'alert after the wait limit ' + JSON.stringify(posts));
    await sleep(1200); ok(posts.length === 1, 'only one alert per wait');
    st(pid, 'busy'); await sleep(400); st(pid, 'waiting'); await sleep(1400); ok(posts.length === 2, 'a new wait can alert again');
    st(pid, 'busy'); await sleep(300); fs.writeFileSync(prefs, JSON.stringify({ phoneAlerts: false, ntfyTopic: 'ccdesk-test' })); st(pid, 'waiting'); await sleep(1400); ok(posts.length === 2, 'phone alerts off sends nothing');
    fs.unlinkSync(statusF(pid)); c.kill('p'); await sleep(200); app.exit(0); return; }
  require('./main.js'); await sleep(1800);
  const win = BrowserWindow.getAllWindows()[0], R = s => win.webContents.executeJavaScript(s);
  const text = () => R(`(() => { const t = Object.values(tabs)[0]; if (!t) return ''; const b = t.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`);
  const type = async w => { await R(`ipc.send('write', Object.keys(tabs)[0], ${JSON.stringify(w + '\n')})`); await sleep(500); };
  const tabPid = () => R(`(Object.values(tabs)[0] || {}).pid`), quit = () => { app.quit(); setTimeout(() => app.exit(0), 3000); };
  const restored = async () => { for (let i = 0; i < 20 && !(await tabPid()); i++) await sleep(150); ok(await tabPid() === WANT, `${P}: session reconnects as a tab with the same process`); };
  if (P === 'open') { setPref('keep'); await R(`openTab(null, require('os').homedir(), 'Fixture')`); await sleep(900); await type('before-quit'); ok(/before-quit/.test(await text()), 'typing reaches the session'); save({ pid: await tabPid() }); quit(); }
  else if (P === 'back') { await restored(); await sleep(500); const t = await text(); ok(/before-quit/.test(t), 'screen from before quitting is replayed'); ok(/while-away/.test(t), 'output from while the app was closed is shown'); ok(await R(`$('title').textContent`) === 'Fixture', 'tab keeps its name'); await type('after-return'); ok(/after-return/.test(await text()), 'typing still works after reconnecting'); quit(); }
  else if (P === 'ask-keep') { setPref('ask'); answer(0); await restored(); quit(); }
  else if (P === 'ask-cancel') { setPref('ask'); answer(3); await restored(); app.quit(); await sleep(400); ok(!win.isDestroyed(), 'Cancel leaves the app open'); answer(0); quit(); }
  else if (P === 'ask-always') { setPref('ask'); answer(1); await restored(); quit(); }
  else if (P === 'close-tab') { await restored(); await R(`openTab(null, require('os').homedir(), 'Second')`); await sleep(900); const second = await R(`Object.values(tabs)[1].pid`); await R(`closeTab(Object.keys(tabs)[1])`); await sleep(800); ok(!alive(second), 'closing a tab stops only that session'); ok(alive(WANT), 'the other session keeps running'); quit(); }
  else if (P === 'stop') { setPref('ask'); answer(2); for (let i = 0; i < 20 && !(await tabPid()); i++) await sleep(150); const p = await tabPid(); ok(!!p, 'stop: session reconnected before stopping'); save({ pid: p }); quit(); }
  else if (P === 'killed-helper') { await R(`openTab(null, require('os').homedir(), 'Doomed')`); await sleep(900); const hp = cp.spawnSync('pgrep', ['-f', path.join(__dirname, 'ptyd.js')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).filter(p => cp.spawnSync('ps', ['eww', '-o', 'command=', '-p', p], { encoding: 'utf8' }).stdout.includes(os.homedir())); hp.forEach(p => process.kill(+p, 'SIGKILL')); await sleep(800); ok(/session ended/.test(await text()), 'a helper crash shows up in the tab instead of freezing it'); await R(`openTab(null, require('os').homedir(), 'Again')`); await sleep(1500); ok(await R(`!!Object.values(tabs)[1] && !!Object.values(tabs)[1].pid`), 'a new session starts a fresh helper'); setPref('ask'); answer(2); quit(); }
});
