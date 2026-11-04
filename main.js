const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const pty = require('node-pty');
const S = require('./sessions');
const ST = require('./settings');

let win; const ptys = {};
// Window name = the .app bundle's name ("CC Desk" by default), so a renamed copy shows its own name.
const NAME = (app.getPath('exe').match(/([^/]+)\.app\//) || [, 'CC Desk'])[1].replace(/^Electron$/, 'CC Desk');
// DESK_SMOKE=1: hidden run that loads the UI, reports errors + sidebar count, then quits.
const SMOKE = process.env.DESK_SMOKE; if (SMOKE) app.setActivationPolicy('prohibited');
// One window only: opening the app again just brings it to the front.
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
(app.isReady() ? Promise.resolve() : app.whenReady()).then(() => {
  win = new BrowserWindow({
    width: 1440, height: 900, title: NAME, backgroundColor: '#1f1e1d',
    // ponytail: nodeIntegration on, fine because the window only ever loads our local index.html.
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  if (SMOKE) { win.hide();
    win.webContents.on('console-message', (e, lvl, msg) => lvl >= 2 && console.log('JSERR', msg));
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      console.log('SMOKE', await win.webContents.executeJavaScript(
        `JSON.stringify({ popupBlocked: window.open('http://example.invalid') === null, app: require('electron').ipcRenderer ? 'ok' : 'x', items: document.querySelectorAll('.it').length, pinned: !!document.querySelector('.pin'), more: !!document.getElementById('more'), notif: typeof Notification })`));
      app.quit(); }, 3000)); }
  // Security: this window has Node access, so it must never show anything but our own page.
  // Links (incl. OSC 8 links in terminal output) open in the real browser, https only; navigation is blocked.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
// Quitting ends every session running inside the app, so ask first.
let quitOK = false;
app.on('before-quit', e => {
  const n = Object.keys(ptys).length;
  if (!quitOK && n && !SMOKE) {
    const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `${n} session${n > 1 ? 's are' : ' is'} open in ${NAME}.`, detail: 'Quitting stops them. Their chats stay saved, and you can resume them later.' });
    if (r !== 0) return e.preventDefault();
  }
  quitOK = true; Object.values(ptys).forEach(p => p.kill());
});

ipcMain.handle('list', (e, limit) => S.list(limit));
ipcMain.handle('live', () => S.live());
ipcMain.handle('usage', (e, f) => S.usage(f));
ipcMain.handle('extras', () => S.extras());
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
  const n = Object.keys(ptys).length;
  if (n && dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Update & restart', 'Later'], defaultId: 0, cancelId: 1,
      message: 'Install the update now?', detail: `The app restarts, which stops the ${n} open session${n > 1 ? 's' : ''}. Their chats stay saved.` }) !== 0) return 'later';
  const bundle = (app.getPath('exe').match(/^(.*?\.app)\//) || [])[1];
  return new Promise(res => execFile(process.env.SHELL || '/bin/zsh', ['-ilc', './install.sh --update'],
    { cwd: __dirname, timeout: 600000, env: { ...process.env, ...(bundle ? { CC_DESK_APP: bundle } : {}) } }, (err, out, errOut) => {
      if (err) return res('failed: ' + String(errOut || err.message).trim().split('\n').pop());
      quitOK = true; app.relaunch(); app.exit(0);
    }));
});
// Connections = `claude mcp list` (same health check the terminal runs, ~15s).
ipcMain.handle('mcp', () => new Promise(res => require('child_process').execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'unset CLAUDE_CODE_OAUTH_TOKEN; claude mcp list'],
  { cwd: S.HOME, timeout: 60000 }, (err, out) => res((out || '').split('\n').map(l => l.match(/^(.+?): .* - (.+)$/)).filter(Boolean)
    .map(m => ({ name: m[1].replace(/^claude\.ai /, ''), state: m[2].trim() }))))));
ipcMain.handle('setSetting', (e, k, v) => ST.set(k, v));
ipcMain.handle('pin', (e, id) => S.togglePin(id));
ipcMain.on('focus', () => { win.show(); win.focus(); });

// Runs the real installed `claude` through a login shell, so PATH, hooks and settings are exactly the terminal's.
ipcMain.handle('open', (e, key, cwd, resumeId, cols, rows) => {
  if (resumeId && !/^[0-9a-f-]{36}$/.test(resumeId)) throw new Error('bad session id');
  // unset: a CLAUDE_CODE_OAUTH_TOKEN exported in the shell profile (long-lived token for scripts) hides the claude.ai connectors; use the normal login instead.
  const cmd = 'unset CLAUDE_CODE_OAUTH_TOKEN; exec claude' + (resumeId ? ' --resume ' + resumeId : '');
  const p = pty.spawn(process.env.SHELL || '/bin/zsh', ['-ilc', cmd], {
    name: 'xterm-256color', cols, rows, cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  ptys[key] = p;
  p.onData(d => !win.isDestroyed() && win.webContents.send('data', key, d));
  p.onExit(() => { delete ptys[key]; !win.isDestroyed() && win.webContents.send('exit', key); });
  return p.pid;
});
ipcMain.on('write', (e, k, d) => ptys[k] && ptys[k].write(d));
ipcMain.on('resize', (e, k, c, r) => ptys[k] && ptys[k].resize(c, r));
ipcMain.on('kill', (e, k) => ptys[k] && ptys[k].kill());
