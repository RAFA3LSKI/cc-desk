// "Was open before the restart" marker test (2026-11-19). Run: node uitest-wasopen.js  (hidden, sandbox HOME, fake shell, real sessions untouched)
// A Mac restart = the helper and every session die. Simulated by killing the sandbox helper between two real app launches.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const A = 'aaaaaaaa-1111-4222-8333-444455556666', B = 'bbbbbbbb-1111-4222-8333-444455556666', C = 'cccccccc-1111-4222-8333-444455556666';
if (!process.versions.electron) {
  const H = fs.mkdtempSync(path.join(os.tmpdir(), 'dkw-')), CL = path.join(H, '.claude'), F = path.join(H, 'r.json'); let fails = 0;
  for (const d of ['sessions', 'projects/-w']) fs.mkdirSync(path.join(CL, d), { recursive: true });
  for (const [id, t] of [[A, 'Alpha chat'], [B, 'Bravo chat'], [C, 'Charlie chat']])
    fs.writeFileSync(path.join(CL, 'projects/-w', id + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi ' + t }, cwd: H }) + '\n' + JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: id }) + '\n');
  fs.writeFileSync(path.join(CL, 'settings.json'), '{"model":"opus"}'); fs.writeFileSync(path.join(H, '.claude.json'), '{}');
  fs.writeFileSync(path.join(H, '.claude-desk.json'), '{"quitSessions":"keep"}');
  fs.writeFileSync(path.join(H, 'fakesh'), '#!/bin/sh\nexec cat\n', { mode: 0o755 });
  const helpers = () => cp.spawnSync('pgrep', ['-f', path.join(__dirname, 'ptyd.js')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).filter(p => { try { return cp.spawnSync('ps', ['eww', '-o', 'command=', '-p', p], { encoding: 'utf8' }).stdout.includes(H); } catch { return false; } });
  const phase = name => {
    const env = { ...process.env, HOME: H, SHELL: path.join(H, 'fakesh'), PHASE: name, RESULT: F, DESK_SNAP_MS: '400' }; delete env.ELECTRON_RUN_AS_NODE; delete env.DESK_SMOKE; delete env.DESK_PTYD_SOCK;
    const r = cp.spawnSync(require('electron'), [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000, encoding: 'utf8' });
    const s = (r.stdout || '').split('\n').filter(l => /^(PASS|FAIL) /.test(l)); s.forEach(l => { console.log(l); if (l.startsWith('FAIL')) fails++; });
    if (!s.length || r.error) { console.log(`FAIL ${name}: no result ${r.error || ''} ${(r.stderr || '').slice(-300)}`); fails++; }
  };
  const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  const snap = () => { try { return JSON.parse(fs.readFileSync(path.join(H, '.claude-desk-open.json'), 'utf8')).open || {}; } catch { return {}; } };
  phase('open'); check(!!snap()[A] && !snap()[B], 'snapshot file lists the open chat only ' + JSON.stringify(snap()));
  for (const p of helpers()) try { process.kill(+p, 'SIGKILL'); } catch {} // the "restart": helper + sessions gone
  check(helpers().length === 0, 'restart simulated: no helper left');
  phase('back');
  phase('open-c'); // C open, app quit with Keep running: C survives, so it comes back as a tab and gets no badge
  phase('back-c');
  for (const p of helpers()) try { process.kill(+p); } catch {}
  fs.rmSync(H, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
}
const { app, BrowserWindow } = require('electron');
app.setAppPath(__dirname); app.setActivationPolicy && app.setActivationPolicy('prohibited'); app.requestSingleInstanceLock = () => true; app.setPath('userData', path.join(os.homedir(), 'ud'));
app.on('browser-window-created', (e, w) => w.hide());
const sleep = ms => new Promise(r => setTimeout(r, ms)), P = process.env.PHASE, ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
const snapF = path.join(os.homedir(), '.claude-desk-open.json'), snap = () => { try { return JSON.parse(fs.readFileSync(snapF, 'utf8')).open || {}; } catch { return {}; } };
app.whenReady().then(async () => {
  require('./main.js'); await sleep(1800);
  const win = BrowserWindow.getAllWindows()[0], R = s => win.webContents.executeJavaScript(s), quit = () => { app.quit(); setTimeout(() => app.exit(0), 3000); };
  const badge = id => R(`(() => { const r = document.querySelector('#list .it[data-id="${id}"]'); return r ? (r.querySelector('.was') ? r.querySelector('.was').title : 'none') : 'norow'; })()`);
  if (P === 'open') {
    await R(`openTab(${JSON.stringify(A)}, require('os').homedir(), 'Alpha chat')`); await sleep(1500);
    ok(!!snap()[A], 'an open chat is saved within one tick');
    await R(`closeTab(Object.keys(tabs)[0])`); await sleep(1200); // like the pty exits that come first during a Mac shutdown
    ok(!!snap()[A], 'a chat that just closed stays listed for the grace time');
    quit();
  } else if (P === 'back') {
    await sleep(600); const a = await badge(A), b = await badge(B);
    ok(/^Open before the restart\. Last active /.test(a), 'the chat open before the restart has the badge: ' + a);
    ok(b === 'none', 'a chat that was not open has no badge: ' + b);
    ok(await R(`!!document.querySelector('#list .it[data-id="${A}"] .when')`), 'the row still shows its last-active time');
    await R(`openTab(${JSON.stringify(A)}, require('os').homedir(), 'Alpha chat')`); await sleep(600); await R('render()');
    ok(await badge(A) === 'none', 'the badge goes once the chat is reopened');
    await R(`closeTab(Object.keys(tabs)[0])`); await sleep(300); quit();
  } else if (P === 'open-c') {
    await R(`openTab(${JSON.stringify(C)}, require('os').homedir(), 'Charlie chat')`); await sleep(1500); ok(!!snap()[C], 'second chat saved'); quit();
  } else if (P === 'back-c') {
    for (let i = 0; i < 20 && !(await R('Object.keys(tabs).length')); i++) await sleep(150);
    await sleep(500); await R('render()');
    ok(await R('Object.keys(tabs).length') === 1, 'the chat that kept running comes back as a tab');
    ok(await badge(C) === 'none', 'a chat that kept running gets no badge (it is in Open)');
    ok(!(C in (await R(`ipc.invoke('wasOpen')`))), 'wasOpen leaves out running chats');
    await R(`closeTab(Object.keys(tabs)[0])`); await sleep(300); quit();
  }
});
