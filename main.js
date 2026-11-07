const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const ptyd = require('./ptyd');
const S = require('./sessions');
const ST = require('./settings');

let win; const live = new Set(); // keys of the sessions the background helper is holding
const toWin = (...a) => { if (win && !win.isDestroyed()) win.webContents.send(...a); };
const D = ptyd.client(m => {
  if (m.t === 'data') toWin('data', m.key, m.d);
  if (m.t === 'exit') { live.delete(m.key); toWin('exit', m.key); }
}, () => { for (const k of live) toWin('exit', k); live.clear(); }); // helper gone: tell the tabs instead of leaving them frozen
// Window name = the .app bundle's name ("CC Desk" by default), so a renamed copy shows its own name.
const NAME = (app.getPath('exe').match(/([^/]+)\.app\//) || [, 'CC Desk'])[1].replace(/^Electron$/, 'CC Desk');
// DESK_SMOKE=1: hidden run that loads the UI, reports errors + sidebar count, then quits.
const SMOKE = process.env.DESK_SMOKE; if (SMOKE) app.setActivationPolicy('prohibited');
// One window only: opening the app again just brings it to the front.
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
(app.isReady() ? Promise.resolve() : app.whenReady()).then(() => {
  win = new BrowserWindow({
    ...screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, title: NAME, // opens filling the screen (minus menu bar/Dock), Raf 2026-11-07 backgroundColor: '#1f1e1d',
    // ponytail: nodeIntegration on, fine because the window only ever loads our local index.html.
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  if (SMOKE) { win.hide();
    win.webContents.on('console-message', (e, lvl, msg) => lvl >= 2 && console.log('JSERR', msg));
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      console.log('SMOKE', await win.webContents.executeJavaScript(
        `(async () => JSON.stringify({ popupBlocked: window.open('http://example.invalid') === null, app: require('electron').ipcRenderer ? 'ok' : 'x', items: document.querySelectorAll('.it').length, pinned: !!document.querySelector('.pin'), more: !!document.getElementById('more'), notif: typeof Notification,
          fillsScreen: ${JSON.stringify((() => { const b = win.getBounds(), w = screen.getDisplayMatching(b).workArea; return b.x === w.x && b.y === w.y && b.width === w.width && b.height === w.height; })())}, hiddenLeaks: [...document.querySelectorAll('[hidden]')].filter(el => getComputedStyle(el).display !== 'none').map(el => el.id || el.tagName),
          settingsClosable: await (async () => { await openSettings(); const opened = getComputedStyle($('set')).display !== 'none';
            $('setClose').click(); return opened && getComputedStyle($('set')).display === 'none'; })() }))()`));
      app.quit(); }, 3000)); }
  // Security: this window has Node access, so it must never show anything but our own page.
  // Links (incl. OSC 8 links in terminal output) open in the real browser, https only; navigation is blocked.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
// Sessions live in the background helper, so quitting doesn't have to stop them. Ask, unless Settings says always keep running.
let quitOK = false;
app.on('before-quit', e => {
  if (quitOK || SMOKE || !live.size) return;
  if (ST.get().desk.quitSessions === 'keep') return;
  const n = live.size, r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep running', 'Always keep running', 'Stop them', 'Cancel'], defaultId: 0, cancelId: 3,
    message: `${n} session${n > 1 ? 's are' : ' is'} open in ${NAME}.`, detail: 'Keep running: they carry on in the background and come back when you reopen the app, still using your plan. Stop them: their chats stay saved, and you can resume them later.' });
  if (r === 3) return e.preventDefault();
  if (r === 1) ST.set('desk.quitSessions', 'keep');
  if (r === 2) { e.preventDefault(); quitOK = true; D.stopAll().finally(() => app.quit()); }
});

ipcMain.handle('list', (e, limit) => S.list(limit));
ipcMain.handle('live', () => S.live());
ipcMain.handle('usage', (e, f) => S.usage(f));
ipcMain.handle('usageData', () => require('./usage').get(p => win && !win.isDestroyed() && win.webContents.send('usageProgress', p)));
ipcMain.handle('tabUsage', (e, f) => require('./usage').session(f));
ipcMain.handle('extras', () => S.extras());
ipcMain.handle('images', (e, id, from) => S.images(id, from));
ipcMain.handle('rename', (e, file, id, n) => S.rename(file, id, n));
ipcMain.handle('account', () => { try { const a = JSON.parse(require('fs').readFileSync(require('path').join(S.HOME, '.claude.json'), 'utf8')).oauthAccount || {};
  return { email: a.emailAddress || '', plan: a.planDisplayName || '' }; } catch { return {}; } });
ipcMain.on('url', (e, u) => /^https:\/\//.test(u) && shell.openExternal(u));
ipcMain.handle('settings', () => ST.get());
ipcMain.handle('name', () => NAME);

// Updates: if this folder is a git clone, check the remote every 6h; the renderer shows an "Update available" line.
const { execFile } = require('child_process');
const git = (args, cb) => execFile('git', ['-C', __dirname, ...args], { timeout: 30000 }, cb);
function checkUpdate() {
  if (SMOKE || !require('fs').existsSync(require('path').join(__dirname, '.git'))) return;
  git(['fetch', '-q'], err => !err && git(['rev-list', '--count', 'HEAD..@{u}'], (e, out) =>
    !e && +out > 0 && win && !win.isDestroyed() && win.webContents.send('update', +out)));
}
setTimeout(checkUpdate, 10000); setInterval(checkUpdate, 6 * 3600 * 1000);
ipcMain.handle('doUpdate', async () => {
  const n = live.size;
  if (n && dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Update & restart', 'Later'], defaultId: 0, cancelId: 1,
      message: 'Install the update now?', detail: `The app restarts. Your ${n} open session${n > 1 ? 's' : ''} keep${n > 1 ? '' : 's'} running and reconnect${n > 1 ? '' : 's'} afterwards.` }) !== 0) return 'later';
  const bundle = (app.getPath('exe').match(/^(.*?\.app)\//) || [])[1];
  return new Promise(res => execFile(process.env.SHELL || '/bin/zsh', ['-ilc', './install.sh --update'],
    { cwd: __dirname, timeout: 600000, env: { ...process.env, ...(bundle ? { CC_DESK_APP: bundle } : {}) } }, (err, out, errOut) => {
      if (err) return res('failed: ' + String(errOut || out || err.message).trim().split('\n').filter(Boolean).pop());
      quitOK = true; app.relaunch(); app.exit(0);
    }));
});
// Connections = `claude mcp list` (same health check the terminal runs, ~15s).
// desk.unsetOauthToken (opt-in, ~/.claude-desk.json): drop a CLAUDE_CODE_OAUTH_TOKEN exported in the shell profile (a long-lived script token hides the
// claude.ai connectors) so the normal login is used. Off by default: for people who log in WITH that token, unsetting it would log them out.
const noTok = () => ST.get().desk.unsetOauthToken ? 'unset CLAUDE_CODE_OAUTH_TOKEN; ' : '';
ipcMain.handle('mcp', () => new Promise(res => require('child_process').execFile(process.env.SHELL || '/bin/zsh', ['-ilc', noTok() + 'claude mcp list'],
  { cwd: S.HOME, timeout: 60000 }, (err, out) => res((out || '').split('\n').map(l => l.match(/^(.+?): .* - (.+)$/)).filter(Boolean)
    .map(m => ({ name: m[1].replace(/^claude\.ai /, ''), state: m[2].trim() }))))));
ipcMain.handle('phoneTest', async () => { const t = ST.get().desk.ntfyTopic; if (!t) throw new Error('turn phone alerts on first'); await ptyd.ntfy(t, 'Claude needs you', 'Test from CC Desk. Phone alerts are working.'); });
ipcMain.handle('setSetting', (e, k, v) => ST.set(k, v));
ipcMain.handle('pin', (e, id) => S.togglePin(id));
ipcMain.on('focus', () => { win.show(); win.focus(); });

// Runs the real installed `claude` through a login shell, so PATH, hooks and settings are exactly the terminal's.
ipcMain.handle('open', async (e, key, cwd, resumeId, cols, rows, title) => {
  if (resumeId && !/^[0-9a-f-]{36}$/.test(resumeId)) throw new Error('bad session id');
  // --remote-control: every tab can be picked up from the Claude phone app (Raf 2026-11-06).
  const cmd = noTok() + 'exec claude --remote-control' + (resumeId ? ' --resume ' + resumeId : '');
  const missing = !require('fs').existsSync(cwd) && cwd; if (missing) cwd = S.HOME;
  const pid = await D.open({ key, shell: process.env.SHELL || '/bin/zsh', args: ['-ilc', cmd], cols, rows, cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, meta: { cwd, resumeId, title } });
  live.add(key);
  if (missing) toWin('data', key, `This session's folder no longer exists: ${missing}. Starting in your home folder instead.\r\n`);
  return pid;
});
// What the helper kept running while the app was closed. Never starts the helper; the smoke test must not touch real sessions.
ipcMain.handle('running', async () => { if (SMOKE) return []; const items = await D.list(); items.forEach(x => live.add(x.key)); return items; });
ipcMain.on('attach', (e, k, c, r) => D.attach(k, c, r));
ipcMain.on('write', (e, k, d) => live.has(k) && D.write(k, d));
ipcMain.on('resize', (e, k, c, r) => live.has(k) && D.resize(k, c, r));
ipcMain.on('kill', (e, k) => live.has(k) && D.kill(k));
