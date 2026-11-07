// Everyday-use UI test. Run: node uitest.js   (hidden, sandbox HOME, never touches the real app or real settings files)
// Launcher (plain node): builds a sandbox HOME + fixtures, runs this file under Electron, compares hashes of the real files.
// Driver (inside Electron, DESK_UITEST=1): drives the real index.html in a hidden window and asserts VISIBLE state.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');

if (!process.versions.electron) {
  const REAL = os.homedir(), sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return 'ABSENT'; } };
  const realFiles = [path.join(REAL, '.claude/settings.json'), path.join(REAL, '.claude-desk.json')];
  const before = realFiles.map(sha);
  const H = fs.mkdtempSync(path.join(os.tmpdir(), 'deskui-')), C = path.join(H, '.claude');
  fs.mkdirSync(path.join(C, 'sessions'), { recursive: true }); fs.mkdirSync(path.join(C, 'agents'), { recursive: true }); fs.mkdirSync(path.join(C, 'skills'), { recursive: true });
  fs.copyFileSync(realFiles[0], path.join(C, 'settings.json'));
  if (fs.existsSync(realFiles[1])) fs.copyFileSync(realFiles[1], path.join(H, '.claude-desk.json'));
  fs.writeFileSync(path.join(H, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'test@example.com', planDisplayName: 'Max' } }));
  // fixtures: 4 small real session files (top-level uuid.jsonl, real user prompt, cwd that exists)
  const PROJ = path.join(REAL, '.claude/projects'), picked = [];
  for (const d of fs.readdirSync(PROJ)) { if (picked.length >= 4) break;
    for (const n of fs.readdirSync(path.join(PROJ, d))) { const f = path.join(PROJ, d, n);
      if (picked.length >= 4 || !/^[0-9a-f-]{36}\.jsonl$/.test(n)) continue;
      const st = fs.statSync(f); if (st.size < 1000 || st.size > 150000) continue;
      const rows = fs.readFileSync(f, 'utf8').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const cwd = (rows.find(r => r.cwd) || {}).cwd;
      if (!cwd || !fs.existsSync(cwd) || !rows.some(r => r.type === 'user')) continue;
      fs.mkdirSync(path.join(C, 'projects', d), { recursive: true }); fs.writeFileSync(path.join(C, 'projects', d, n), fs.readFileSync(f, 'utf8').replaceAll('"entrypoint":"sdk-cli"', '"entrypoint":"cli"')); /* scripted runs count as normal chats here */ picked.push(f); } }
  // fake login shell: no real claude. "mcp" call answers a fixed list, anything else just idles like a terminal session.
  fs.writeFileSync(path.join(H, 'fakesh'), '#!/bin/sh\ncase "$*" in *mcp*) echo "claude.ai Fake: https://x - Connected";; *) exec sleep 600;; esac\n', { mode: 0o755 });
  console.log('sandbox HOME:', H, '| fixtures:', picked.length);
  const env = { ...process.env, HOME: H, SHELL: path.join(H, 'fakesh'), DESK_UITEST: '1', DESK_PTYD_EXIT_WITH_CLIENT: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.DESK_SMOKE;
  const r = cp.spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 180000 });
  const after = realFiles.map(sha), same = before.every((h, i) => h === after[i]);
  console.log(`REAL FILES UNCHANGED: ${same ? 'PASS' : 'FAIL'} (settings.json ${before[0].slice(0, 12)} -> ${after[0].slice(0, 12)}, .claude-desk.json ${before[1].slice(0, 12)} -> ${after[1].slice(0, 12)})`);
  process.exit(r.status || (same ? 0 : 1));
}

// ---------------- driver (Electron) ----------------
const { app, BrowserWindow, dialog, shell } = require('electron');
app.setActivationPolicy && app.setActivationPolicy('prohibited');
app.requestSingleInstanceLock = () => true;           // sandbox instance must not collide with the real app's lock
app.setPath('userData', path.join(os.homedir(), 'ud'));
app.on('browser-window-created', (e, w) => w.hide()); // never visible, never focused
const opened = []; shell.openExternal = async u => { opened.push(u); };
const SETF = path.join(os.homedir(), '.claude/settings.json'), DESKF = path.join(os.homedir(), '.claude-desk.json');
const rj = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [], jserr = []; let fails;
const ok = (c, msg) => { if (!c) fails.push(msg); };

app.whenReady().then(() => { require('./main.js'); setTimeout(run, 500); });
async function run() {
  const win = BrowserWindow.getAllWindows()[0], wc = win.webContents;
  wc.on('console-message', (e, lvl, msg) => lvl >= 3 && jserr.push(msg));
  const R = js => wc.executeJavaScript(js);
  const flow = async (name, fn) => { fails = []; try { await fn(); } catch (e) { fails.push('EXC ' + e.message); } results.push([name, fails.length ? 'FAIL' : 'PASS', fails.join(' | ')]); if (process.env.UI_VERBOSE) console.log(name, fails.length ? 'FAIL ' + fails.join(' | ') : 'PASS'); };
  const note = (name, why) => results.push([name, 'NOT_TESTED', why]);
  await new Promise(r => wc.isLoading() ? wc.once('did-finish-load', r) : r()); await sleep(2000);
  const vis = id => R(`getComputedStyle($('${id}')).display !== 'none'`);
  const S = require('./sessions'); const fixtures = S.list().items;
  const settingsFile0 = fs.readFileSync(SETF, 'utf8');
  const get = k => { const s = rj(SETF);
    return k.startsWith('desk.') ? rj(DESKF)[k.slice(5)] : k.startsWith('enabledPlugins.') ? (s.enabledPlugins || {})[k.slice(15)] : k === 'permissions.defaultMode' ? (s.permissions || {}).defaultMode : s[k]; };
  const items = () => R(`[...document.querySelectorAll('#list .it[data-id]')].map(e => e.querySelector('.t').textContent)`);
  const nonEmpty = fixtures.filter(s => !s.empty);

  await flow('01 load: nothing open/visible by default', async () => {
    const r = JSON.parse(await R(`JSON.stringify({ leaks: [...document.querySelectorAll('[hidden]')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.id || e.tagName),
      overlays: ['set','menu','panel','rewind'].filter(id => getComputedStyle($(id)).display !== 'none'), empty: getComputedStyle($('empty')).display, terms: document.querySelectorAll('.term').length,
      title: $('title').textContent, acct: $('acctMail').textContent, tip: $('tip').textContent.length })`));
    ok(!r.leaks.length, 'hidden elements displayed: ' + r.leaks); ok(!r.overlays.length, 'visible on launch: ' + r.overlays);
    ok(r.empty !== 'none', 'empty state not shown'); ok(r.terms === 0, 'terms on launch ' + r.terms); ok(r.title === 'CC Desk', 'title ' + r.title);
    ok(r.acct === 'test@example.com', 'account label ' + r.acct); ok(r.tip > 5, 'tip bar empty');
  });
  await flow('02 sidebar lists fixture sessions with titles', async () => {
    const t = await items(); ok(fixtures.length >= 3, 'only ' + fixtures.length + ' fixtures');
    ok(t.length === nonEmpty.length, `rows ${t.length} vs expected ${nonEmpty.length}`);
    ok(nonEmpty.every(s => t.includes(s.title)), 'titles missing: ' + JSON.stringify(nonEmpty.map(s => s.title).filter(x => !t.includes(x))));
    ok(t.every(x => x.trim()), 'blank title row');
  });
  await flow('03 Show empty toggle', async () => {
    await R(`$('showEmpty').click()`); const a = await R(`[$('showEmpty').textContent, document.querySelectorAll('#list .it[data-id]').length]`);
    ok(a[0] === 'Show less', 'label ' + a[0]); ok(a[1] === fixtures.length, `rows ${a[1]} vs ${fixtures.length}`);
    await R(`$('showEmpty').click()`); ok(await R(`$('showEmpty').textContent`) === 'Show all', 'label did not revert');
  });
  const S1 = nonEmpty[0], S2 = nonEmpty[1];
  await flow('04 click session opens a tab, empty state hides', async () => {
    await R(`document.querySelector('#list .it[data-id="${S1.id}"]').click()`); await sleep(600);
    const r = JSON.parse(await R(`JSON.stringify({ empty: getComputedStyle($('empty')).display, terms: document.querySelectorAll('.term').length, vis: getComputedStyle(document.querySelector('.term')).visibility,
      title: $('title').textContent, open: [...document.querySelectorAll('#list .it[data-key]')].map(e => e.textContent), on: document.querySelectorAll('.it.on').length,
      rewind: getComputedStyle($('rewind')).display, use: $('use').textContent, xterm: !!document.querySelector('.term .xterm-screen') })`));
    ok(r.empty === 'none', 'empty state still visible'); ok(r.terms === 1 && r.vis === 'visible', JSON.stringify(r)); ok(r.title === S1.title, 'bar title ' + r.title);
    ok(r.open.length === 1, 'Open group ' + r.open.length); ok(r.on === 1, '.on count ' + r.on); ok(r.rewind !== 'none', 'rewind hidden with a tab open'); ok(r.xterm, 'no xterm');
    ok(/turns/.test(r.use), 'usage line: "' + r.use + '"');
    await R(`document.querySelector('#list .it[data-id="${S1.id}"]').click()`); ok(await R(`Object.keys(tabs).length`) === 1, 're-click opened a duplicate tab');
  });
  await flow('05 new session + switching tabs shows only the active terminal', async () => {
    await R(`$('new').click()`); await sleep(300);
    const k = JSON.parse(await R(`JSON.stringify(Object.keys(tabs))`)); ok(k.length === 2, 'tabs ' + k.length);
    let v = JSON.parse(await R(`JSON.stringify(Object.values(tabs).map(t => getComputedStyle(t.el).visibility))`)); ok(v.filter(x => x === 'visible').length === 1 && v[1] === 'visible', 'visibility after new ' + v);
    ok(await R(`$('title').textContent`) === 'New session', 'new session title');
    await R(`document.querySelector('#list .it[data-key="${k[0]}"]').click()`);
    v = JSON.parse(await R(`JSON.stringify(Object.values(tabs).map(t => getComputedStyle(t.el).visibility))`)); ok(v[0] === 'visible' && v[1] === 'hidden', 'after switch ' + v);
    ok(await R(`$('title').textContent`) === S1.title, 'title after switch'); ok(await R(`document.querySelector('.it.on').dataset.key`) === k[0], 'highlight did not follow');
  });
  await flow('06 PTY data shows in the terminal; exit message', async () => {
    const k = await R(`active`); wc.send('data', k, 'HELLO-UITEST\r\n'); await sleep(300);
    ok(await R(`(() => { const b = tabs['${k}'].term.buffer.active; let s=''; for (let i=0;i<b.length;i++) s+=b.getLine(i).translateToString(true); return s.includes('HELLO-UITEST'); })()`), 'data not rendered');
    wc.send('exit', k); await sleep(300); ok(await R(`(() => { const b = tabs['${k}'].term.buffer.active; let s=''; for (let i=0;i<b.length;i++) s+=b.getLine(i).translateToString(true); return s.includes('session ended'); })()`), 'no session-ended message');
  });
  await flow('07 close a tab (x), then last tab -> empty state back', async () => {
    const k = JSON.parse(await R(`JSON.stringify(Object.keys(tabs))`));
    await R(`document.querySelector('[data-close="${k[1]}"]').click()`); await sleep(300);
    ok(await R(`Object.keys(tabs).length`) === 1 && await R(`document.querySelectorAll('.term').length`) === 1, 'tab not removed from DOM/tabs');
    ok(await R(`getComputedStyle(Object.values(tabs)[0].el).visibility`) === 'visible', 'remaining tab not shown'); ok(await vis('empty') === false, 'empty state visible with a tab');
    await R(`document.querySelector('[data-close="${k[0]}"]').click()`); await sleep(300);
    ok(await vis('empty'), 'empty state not back'); ok(await R(`getComputedStyle($('rewind')).display`) === 'none', 'rewind still visible'); ok(await R(`$('title').textContent`) === 'CC Desk', 'title not reset');
    ok(await R(`document.querySelectorAll('#list .it[data-key]').length`) === 0, 'Open rows remain');
  });
  await flow('08 rename (dblclick, Enter) writes custom-title to sandbox file; Esc cancels', async () => {
    const sel = `#list .it[data-id="${S2.id}"]`, name = 'Renamed by uitest';
    await R(`document.querySelector('${sel}').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`);
    ok(await R(`!!document.querySelector('${sel} input')`), 'no rename input');
    await R(`(() => { const i = document.querySelector('${sel} input'); i.value = 'SHOULD NOT SAVE'; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); })()`); await sleep(500);
    ok(!(await items()).includes('SHOULD NOT SAVE'), 'Esc saved the rename');
    await R(`document.querySelector('${sel}').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`);
    await R(`(() => { const i = document.querySelector('${sel} input'); i.value = '${name}'; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'})); })()`); await sleep(800);
    ok((await items()).includes(name), 'title not updated in sidebar: ' + JSON.stringify(await items()));
    const last = fs.readFileSync(S2.file, 'utf8').trim().split('\n').pop(); ok(/"custom-title"/.test(last) && last.includes(name), 'file tail: ' + last.slice(0, 120));
    ok(S2.file.startsWith(os.homedir()), 'rename target outside sandbox!');
  });
  await flow('09 pin / unpin', async () => {
    const sel = `#list .it[data-id="${S1.id}"] .pin`; await R(`document.querySelector('${sel}').click()`); await sleep(600);
    const g = await R(`[...document.querySelectorAll('#list .grp')].map(e => e.textContent)`); ok(g[0] === 'Pinned', 'groups ' + g);
    ok(await R(`document.querySelector('${sel}').textContent`) === '★', 'star not filled'); ok((rj(DESKF).pins || []).includes(S1.id), 'pins not saved: ' + JSON.stringify(rj(DESKF)));
    ok(await R(`document.querySelector('#list .it[data-id]').dataset.id`) === S1.id, 'pinned not first');
    await R(`document.querySelector('${sel}').click()`); await sleep(600);
    ok(!(await R(`[...document.querySelectorAll('#list .grp')].map(e => e.textContent)`)).includes('Pinned'), 'Pinned group remains'); ok(!(rj(DESKF).pins || []).includes(S1.id), 'pin not removed');
  });
  await flow('10 search filters and "No sessions match"', async () => {
    const q = async v => { await R(`$('q').value = ${JSON.stringify(v)}; $('q').dispatchEvent(new Event('input'))`); return items(); };
    const word = S1.title.split(/\s+/).find(w => w.length > 3) || S1.title; const a = await q(word.toLowerCase());
    ok(a.length >= 1 && a.length <= nonEmpty.length && a.every((_, i) => true), 'filter result ' + a.length); ok(a.some(t => t === S1.title), 'matching session missing for "' + word + '"');
    await q('zzzz-no-such-thing'); ok(await R(`$('list').textContent`) === 'No sessions match', 'no-match text: ' + await R(`$('list').textContent`));
    ok((await q('')).length === nonEmpty.length, 'clearing search did not restore list');
  });
  await flow('11 account menu opens, stays on inside click, closes on outside click / toggle', async () => {
    await R(`$('acct').click()`); ok(await vis('menu'), 'menu did not open'); ok(await R(`$('menuMail').textContent`) === 'test@example.com', 'menu mail');
    await R(`$('menuMail').click()`); ok(await vis('menu'), 'closed on inside click');
    await R(`document.body.click()`); ok(!(await vis('menu')), 'outside click did not close');
    await R(`$('acct').click()`); await R(`$('acct').click()`); ok(!(await vis('menu')), 'second click on account did not close');
    const off = await R(`(() => { const b = $('optBtn').getBoundingClientRect(), r = document.createRange(); r.selectNodeContents($('optBtn')); const t = r.getBoundingClientRect(); return [t.left + t.width / 2 - b.left - b.width / 2, t.top + t.height / 2 - b.top - b.height / 2]; })()`); ok(Math.abs(off[0]) <= 1 && Math.abs(off[1]) <= 1, 'options icon off-centre by ' + off);
    await R(`$('optBtn').click()`); ok(await vis('menu'), 'options button did not open menu'); await R(`$('optBtn').click()`); ok(!(await vis('menu')), 'second click on options did not close');
    await R(`$('acct').click(); document.querySelector('#menu [data-confirm]').click()`); ok(await R(`document.querySelector('#menu [data-confirm] span').textContent`) === 'Click again to log out', 'logout needs 2nd click');
    await R(`$('acct').click()`); await R(`document.body.click()`);
    await R(`$('acct').click(); document.querySelector('#menu [data-url]').click()`); ok(!(await vis('menu')), 'menu open after link'); ok(opened.length === 1 && /^https:/.test(opened[0]), 'openExternal ' + opened);
    ok(await R(`window.open('http://example.invalid') === null`), 'window.open not blocked');
  });
  await flow('12 Agents & skills panel toggles', async () => {
    await R(`$('extrasBtn').click()`); await sleep(400); ok(await vis('panel'), 'panel not shown'); ok((await R(`$('panel').textContent`)).includes('Agents ('), 'panel empty');
    await R(`$('extrasBtn').click()`); ok(!(await vis('panel')), 'panel not closed');
  });
  await flow('13 Cmd+, opens Settings on General with content', async () => {
    await R(`window.dispatchEvent(new KeyboardEvent('keydown', {key:',', metaKey:true, bubbles:true}))`); await sleep(500);
    ok(await vis('set'), 'settings not visible'); ok(await R(`document.querySelector('#setNav .nv.on').textContent`) === 'General', 'not on General');
    const r = await R(`[$('setPage').textContent.length, $('setPage').querySelectorAll('.row').length, $('setBody').getBoundingClientRect().height]`); ok(r[0] > 80 && r[1] >= 3 && r[2] > 100, 'blank? ' + r);
  });
  await flow('14 every Settings page renders non-empty', async () => {
    for (const [p, h] of [['general', 'General'], ['model', 'Model'], ['notif', 'Notifications'], ['conn', 'Connections'], ['plugins', 'Plugins'], ['app', 'This app']]) {
      await R(`document.querySelector('#setNav [data-p="${p}"]').click()`); await sleep(500);
      const r = await R(`[$('setPage').querySelector('h2').textContent, $('setPage').textContent.length, document.querySelector('#setNav .nv.on').dataset.p, $('setPage').querySelectorAll('.row').length]`);
      ok(r[0] === h && r[2] === p && r[1] > 40, `${p}: ${r}`);
      if (p === 'plugins') ok(r[3] === Object.keys(rj(SETF).enabledPlugins || {}).length && r[3] > 0, 'plugin rows ' + r[3] + ' vs settings ' + Object.keys(rj(SETF).enabledPlugins || {}).length);
      if (p === 'conn') { await sleep(1500); ok(/Fake/.test(await R(`$('connList').textContent`)), 'connections list: ' + await R(`$('connList').textContent`)); }
    }
    const n0 = opened.length; await R(`$('kofi').click()`); await sleep(300);
    ok(opened.length === n0 + 1 && opened[n0] === 'https://ko-fi.com/ralski', 'Ko-fi link: ' + opened.slice(n0)); ok(await R(`document.querySelector('#setNav .nv.on').dataset.p`) === 'app', 'Ko-fi click changed the Settings page');
  });
  // open a tab so font-size can be observed, then exercise every control
  await R(`document.querySelector('#list .it[data-id="${S1.id}"]').click()`);
  for (const p of ['general', 'model', 'notif', 'app', 'plugins']) await flow(`15 ${p}: every control saves, "Saved ✓" shows, file changes`, async () => {
    await R(`openSettings('${p}')`); await sleep(300);
    const ctl = JSON.parse(await R(`JSON.stringify([...document.querySelectorAll('#setPage [data-k]')].map(e => ({ k: e.dataset.k, sel: e.tagName === 'SELECT' })))`));
    ok(ctl.length > 0, 'no controls'); const keysBefore = Object.keys(rj(SETF)).sort().join();
    for (let i = 0; i < ctl.length; i++) { const c = ctl[i], was = get(c.k);
      await R(`$('setMsg').textContent = ''`);
      const want = await R(`(() => { const e = document.querySelectorAll('#setPage [data-k]')[${i}];
        if (e.tagName === 'SELECT') { const o = [...e.options].find(o => o.value !== e.value); e.value = o.value; e.dispatchEvent(new Event('change', {bubbles:true})); return e.value; }
        e.click(); return e.classList.contains('on'); })()`); await sleep(400);
      const msg = await R(`[$('setMsg').textContent, getComputedStyle($('setMsg')).display]`), now = get(c.k);
      ok(msg[0] === 'Saved ✓' && msg[1] !== 'none', `${c.k}: message "${msg[0]}"`);
      ok(String(now) === String(want) && String(now) !== String(was), `${c.k}: file has ${now}, wanted ${want} (was ${was})`);
    }
    if (p !== 'app' && p !== 'notif' || true) { const b = fs.readdirSync(path.dirname(SETF)).filter(f => f.startsWith('settings.json.desk-backup-'));
      if (p !== 'app') ok(b.length === 1 && fs.readFileSync(path.join(path.dirname(SETF), b[0]), 'utf8') === settingsFile0, 'backup missing or not equal to original: ' + b); }
    ok(Object.keys(rj(SETF)).sort().join() === keysBefore, 'top-level keys changed');
  });
  await flow('16 text size applies to open and new terminals', async () => {
    await R(`openSettings('app')`); await sleep(300);
    await R(`(() => { const e = document.querySelector('[data-k="desk.fontSize"]'); e.value = '18'; e.dispatchEvent(new Event('change', {bubbles:true})); })()`); await sleep(500);
    ok(await R(`Object.values(tabs)[0].term.options.fontSize`) === 18, 'open tab fontSize ' + await R(`Object.values(tabs)[0].term.options.fontSize`)); ok(rj(DESKF).fontSize === 18, 'not saved');
    await R(`$('new').click()`); await sleep(200); ok(await R(`tabs[active].term.options.fontSize`) === 18, 'new tab ignores size');
  });
  await flow('17 Tips line off hides the tip bar, on brings it back', async () => {
    await R(`openSettings('app')`); await sleep(300); const click = () => R(`document.querySelector('[data-k="desk.tips"]').click()`);
    const on = await R(`document.querySelector('[data-k="desk.tips"]').classList.contains('on')`);
    if (on) await click(); await sleep(400); ok(!(await vis('tip')), 'tip still displayed after turning off'); ok(rj(DESKF).tips === false, 'tips not saved');
    await click(); await sleep(400); ok(await vis('tip') && (await R(`$('tip').textContent.length`)) > 5, 'tip not back'); ok(rj(DESKF).tips === true, 'tips not saved on');
  });
  await flow('18 notifications toggles persist across reopen', async () => {
    await R(`openSettings('notif')`); await sleep(300);
    const a = await R(`[...document.querySelectorAll('#setPage .sw')].map(e => e.dataset.k + ':' + e.classList.contains('on'))`);
    const want = { 'desk.notify': get('desk.notify'), 'desk.phoneAlerts': !!get('desk.phoneAlerts'), inputNeededNotifEnabled: !!get('inputNeededNotifEnabled'), agentPushNotifEnabled: !!get('agentPushNotifEnabled') };
    ok(a.length === 4 && a.every(x => { const [k, v] = x.split(':'); return String(want[k]) === v; }), `switch state ${a} vs file ${JSON.stringify(want)}`);
    ok(await R(`deskPrefs.notify`) === want['desk.notify'], 'deskPrefs.notify not applied');
  });
  await flow('19 update banner shows in tip bar', async () => {
    wc.send('update', 2); await sleep(300); ok(/Update available/.test(await R(`$('tip').textContent`)) && await vis('tip'), 'banner: ' + await R(`$('tip').textContent`));
  });
  await flow('20 Settings closes via X, Esc, backdrop (and not on inside click)', async () => {
    const open = async () => { await R(`openSettings('general')`); await sleep(250); ok(await vis('set'), 'did not open'); };
    await open(); await R(`$('setBox').click()`); ok(await vis('set'), 'closed on click inside box');
    await R(`$('setClose').click()`); ok(!(await vis('set')), 'X did not close');
    await open(); await R(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`); ok(!(await vis('set')), 'Esc did not close');
    await open(); await R(`$('set').click()`); ok(!(await vis('set')), 'backdrop did not close');
    await R(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`); ok(!(await vis('set')), 'Esc with settings closed opened something');
    await open(); await R(`document.querySelector('#setNav [data-p="model"]').click()`); await sleep(300); await R(`$('setClose').click()`);
    await R(`window.dispatchEvent(new KeyboardEvent('keydown', {key:',', metaKey:true, bubbles:true}))`); await sleep(300); ok(await vis('set'), 'reopen failed'); await R(`$('setClose').click()`);
    await R(`$('acct').click(); document.querySelector('#menu [data-set]').click()`); await sleep(300); ok(await vis('set') && !(await vis('menu')), 'menu > Settings'); await R(`$('setClose').click()`);
  });
  await flow('21 window resize keeps terminal fitted', async () => {
    win.setPosition(-4000, -4000); win.setOpacity(0.01); win.showInactive(); await sleep(400); // macOS sends no resize to a hidden window; off-screen and takes no focus
    for (const [w, h] of [[900, 600], [1300, 850], [1000, 700]]) { win.setSize(w, h); await sleep(600);
      const r = JSON.parse(await R(`JSON.stringify((() => { const t = tabs[active], d = t.fit.proposeDimensions(), a = t.el.getBoundingClientRect(), b = $('terms').getBoundingClientRect();
        return { cols: t.term.cols, rows: t.term.rows, pc: d.cols, pr: d.rows, inside: a.right <= b.right + 1 && a.bottom <= b.bottom + 1, w: innerWidth }; })())`));
      ok(r.cols === r.pc && r.rows === r.pr && r.inside, `${w}x${h}: ${JSON.stringify(r)}`); }
    win.hide();
  });
  await flow('27 Usage: real numbers, tabs, pills, session detail, limits', async () => {
    const SID = '11111111-1111-4111-8111-111111111111', dir = path.join(os.homedir(), '.claude/projects/-usagefix'), now = new Date().toISOString();
    const L = (id, model, u) => JSON.stringify({ type: 'assistant', timestamp: now, sessionId: SID, cwd: os.homedir(), message: { id, model, usage: u } });
    fs.mkdirSync(path.join(dir, SID, 'subagents'), { recursive: true }); fs.mkdirSync(path.join(os.homedir(), '.claude/state'), { recursive: true });
    fs.writeFileSync(path.join(dir, SID + '.jsonl'), [JSON.stringify({ type: 'custom-title', customTitle: 'Usage fixture', sessionId: SID }), JSON.stringify({ type: 'user', cwd: os.homedir(), sessionId: SID, message: { content: 'hi' } }),
      L('msg_u1', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 10 }), L('msg_u1', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 })].join('\n') + '\n'); // same reply twice: $12 once
    fs.writeFileSync(path.join(dir, SID, 'subagents', 'agent-x.jsonl'), L('msg_u2', 'claude-opus-5-5', { input_tokens: 1e6, output_tokens: 0 }) + '\n'); // agent: $4 counts toward the parent
    const reset = Math.round(Date.now() / 1000) + 3600;
    fs.writeFileSync(path.join(os.homedir(), '.claude/state/rate-limits.json'), JSON.stringify({ seven_day: { used_percentage: 62, resets_at: reset }, at: Date.now() }));
    const text = () => R(`$('setPage').textContent`), click = async (u, v) => { await R(`document.querySelector('[data-u="${u}"]${v === undefined ? '' : `[data-v="${v}"]`}').click()`); await sleep(150); };
    const shown = async sel => R(`(() => { const e = document.querySelector('${sel}'); return !!e && e.getBoundingClientRect().height > 0; })()`);
    await R(`$('acct').click(); document.querySelector('#menu [data-usage]').click()`); await sleep(300);
    ok(await vis('set') && await R(`document.querySelector('#setNav .nv.on').dataset.p`) === 'usage', 'menu Usage did not open the Usage page');
    for (let i = 0; i < 80 && !(await R(`!!US.data`)); i++) await sleep(250);
    ok(await R(`!!US.data`), 'data never loaded: ' + await text());
    let t = await text(); ok(/This week/.test(t) && /62% used/.test(t), 'weekly bar missing: ' + t.slice(0, 200)); ok(!/5-hour window/.test(t), 'a limit the plan does not report must stay hidden');
    ok(await shown('.uChart') && await shown('.uTiles'), 'overview chart or tiles not visible');
    await click('tab', 'sessions'); t = await text(); ok(/Usage fixture/.test(t) && /\$16\.00/.test(t), 'session row wrong (dedupe or agent rollup): ' + t.slice(0, 300));
    await click('session', SID); t = await text(); ok(/\$16\.00/.test(t) && /Sonnet 5\.5/.test(t) && /Opus 5\.5/.test(t), 'session detail: ' + t.slice(0, 300)); ok(await shown('.uChart'), 'session chart not visible');
    await click('back'); ok(!/All sessions/.test(await text()), 'back did not leave the detail');
    await click('tab', 'time'); ok(await R(`document.querySelectorAll('.uCol').length`) === 7, '7-day chart should have 7 bars');
    await click('gran', 'hour'); ok(await R(`document.querySelectorAll('.uCol').length`) === 24, 'time-of-day chart should have 24 bars');
    const hour = new Date().getHours(); await click('pick', hour); ok(/Usage fixture/.test(await text()), 'clicking a bar did not list its session');
    await click('metric', 'output'); ok(await R(`document.querySelector('.uPills [data-u="metric"].on').textContent`) === 'Output', 'metric pill');
    await click('tab', 'models'); t = await text(); ok(/Sonnet 5\.5/.test(t) && /Opus 5\.5/.test(t), 'models tab: ' + t.slice(0, 200));
    await click('range', 'today'); ok(/Sonnet 5\.5/.test(await text()), 'today range lost today\'s usage');
    ok(await R(`$('setBody').scrollHeight <= $('setBody').clientHeight + 1`), 'models tab needs scrolling');
    const before = await R(`US.at`); await R(`US.at = 0`); await sleep(5500); ok(await R(`US.at`) >= before, 'page did not refresh itself');
    await R(`$('setClose').click()`); await sleep(100); ok(!(await vis('set')), 'Usage page did not close');
  });
  await flow('28 split view: layouts, focus, divider, closing', async () => {
    await R(`$('setClose').click()`); while (await R(`Object.keys(tabs).length`) < 4) { await R(`$('new').click()`); await sleep(300); }
    const L = async l => { await R(`document.querySelector('#layouts [data-l="${l}"]').click()`); await sleep(200); };
    const rects = () => R(`[...document.querySelectorAll('.term')].filter(e => getComputedStyle(e).visibility === 'visible').map(e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })`);
    const apart = (a, b) => a.r <= b.l + 1 || b.r <= a.l + 1 || a.b <= b.t + 1 || b.b <= a.t + 1;
    await L('cols2'); let r = await rects(); ok(r.length === 2 && apart(r[0], r[1]) && Math.abs(r[0].t - r[1].t) < 2 && r[0].w > 100, 'side by side ' + JSON.stringify(r));
    await L('rows2'); r = await rects(); ok(r.length === 2 && apart(r[0], r[1]) && Math.abs(r[0].l - r[1].l) < 2 && r[0].h > 50, 'top and bottom ' + JSON.stringify(r));
    await L('cols3'); r = await rects(); ok(r.length === 3 && apart(r[0], r[1]) && apart(r[1], r[2]) && Math.abs(r[0].t - r[2].t) < 2, 'three across ' + JSON.stringify(r));
    await L('top1'); r = await rects(); ok(r.length === 3, 'top1 count ' + r.length); { const s = [...r].sort((a, b) => a.t - b.t); ok(s[0].w > s[1].w * 1.5 && Math.abs(s[1].t - s[2].t) < 2 && apart(s[1], s[2]) && apart(s[0], s[1]), 'one above two ' + JSON.stringify(s)); }
    await L('bottom1'); r = await rects(); ok(r.length === 3, 'bottom1 count ' + r.length); { const s = [...r].sort((a, b) => b.t - a.t); ok(s[0].w > s[1].w * 1.5 && Math.abs(s[1].t - s[2].t) < 2 && apart(s[1], s[2]), 'one below two ' + JSON.stringify(s)); }
    await L('grid4'); r = await rects(); ok(r.length === 4 && r.every((x, i) => r.every((y, j) => i === j || apart(x, y))) && r.every(x => x.w > 100 && x.h > 50), 'two by two ' + JSON.stringify(r));
    await L('bottom1');
    ok(await R(`document.querySelectorAll('.paneHead').length`) === 3, 'each pane has a name strip');
    const fitted = await R(`panes.every(k => { const t = tabs[k], d = t.fit.proposeDimensions(); return d.cols === t.term.cols && d.rows === t.term.rows; })`); ok(fitted, 'a pane terminal is not fitted to its pane');
    await L('cols2'); const keys = await R(`Object.keys(tabs)`), out = await R(`Object.keys(tabs).find(k => !panes.includes(k))`), kept = await R(`panes.find(k => k !== active)`);
    await R(`show(${JSON.stringify(out)})`); await sleep(150); ok(await R(`panes.includes(${JSON.stringify(out)}) && panes.includes(${JSON.stringify(kept)}) && active === ${JSON.stringify(out)}`), 'opening a session did not replace only the focused pane');
    await R(`tabs[${JSON.stringify(kept)}].el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`); await sleep(100); ok(await R(`active`) === kept, 'clicking a pane did not focus it');
    const w0 = (await rects())[0].w; await R(`(() => { const d = document.querySelector('.divider'), b = $('terms').getBoundingClientRect(); d.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: b.left + b.width / 2 })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: b.left + b.width * 0.3 })); window.dispatchEvent(new MouseEvent('mouseup', {})); })()`); await sleep(200);
    const w1 = (await rects())[0].w; ok(Math.abs(w1 - w0) > 40, `divider drag ${w0} -> ${w1}`);
    const n0 = await R(`Object.keys(tabs).length`), victim = await R(`panes[0]`); await R(`closeTab(${JSON.stringify(victim)})`); await sleep(300); ok(await R(`Object.keys(tabs).length`) === n0 - 1 && !(await R(`panes.includes(${JSON.stringify(victim)})`)) && (await rects()).length === 2, 'closing a pane should keep the split filled');
    await L('one'); r = await rects(); ok(r.length === 1 && !(await R(`document.querySelector('.paneHead')`)), 'back to one');
    await L('grid4'); const g0 = (await rects())[0].w; await R(`$('sideBtn').click()`); await sleep(250);
    const g1 = (await rects())[0].w; ok(await R(`getComputedStyle($('side')).display`) === 'none' && g1 > g0 + 100, `sidebar hide should widen panes ${g0} -> ${g1}`);
    ok(await R(`panes.every(k => { const t = tabs[k], d = t.fit.proposeDimensions(); return d.cols === t.term.cols && d.rows === t.term.rows; })`), 'panes not refitted after hiding sidebar');
    await R(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }))`); await sleep(250);
    ok(await R(`getComputedStyle($('side')).display`) !== 'none' && Math.abs((await rects())[0].w - g0) < 2, 'Cmd+B should bring the sidebar back');
    const dots = await R(`(() => { const it = document.createElement('div'); it.className = 'it'; it.innerHTML = '<span class="dot busy"></span><span class="dot waiting"></span><span class="t">x</span>'; $('list').appendChild(it);
      const [b, w] = it.querySelectorAll('.dot'), r = { busy: getComputedStyle(b).backgroundColor, wait: getComputedStyle(w).backgroundColor, waitAnim: getComputedStyle(w).animationName, rowAnim: getComputedStyle(it.querySelector('.t')).animationName }; it.remove(); return r; })()`);
    ok(dots.busy === 'rgb(224, 108, 117)' && dots.wait === 'rgb(255, 255, 255)' && dots.waitAnim === 'flash' && dots.rowAnim === 'flash', 'status colours ' + JSON.stringify(dots));
    await L('one');
  });
  await flow('29 phone alerts setting: makes a private channel, shows setup, off hides it', async () => {
    await R(`ipc.invoke('setSetting', 'desk.phoneAlerts', false)`); await sleep(100); // flow 15 toggles every switch
    await R(`openSettings('notif')`); await sleep(300); ok(!(await R(`!!$('phoneTest')`)), 'setup visible while off');
    await R(`document.querySelector('.sw[data-k="desk.phoneAlerts"]').click()`); await sleep(500);
    const t = rj(DESKF).ntfyTopic; ok(rj(DESKF).phoneAlerts === true && /^ccdesk-[0-9a-f]{32}$/.test(t || ''), 'topic ' + t); ok((await R(`$('setPage').textContent`)).includes(t), 'channel name not shown');
    await R(`document.querySelector('.sw[data-k="desk.phoneAlerts"]').click()`); await sleep(500); ok(!(await R(`!!$('phoneTest')`)) && rj(DESKF).ntfyTopic === t, 'off should hide setup and keep the channel');
    await R(`$('setClose').click()`);
  });
  await flow('30 session names: tab takes the real title, scripted runs hidden, stock prompts and /clear never name a chat', async () => {
    const dir = path.join(os.homedir(), '.claude/projects/-namefix'); fs.mkdirSync(dir, { recursive: true }); const id = n => `22222222-2222-4222-8222-00000000000${n}`;
    const U = (t, extra = {}) => JSON.stringify({ type: 'user', cwd: os.homedir(), message: { content: t }, ...extra });
    fs.writeFileSync(path.join(dir, id(1) + '.jsonl'), [U('/clear'), U('Fix the login page')].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, id(2) + '.jsonl'), [U('You are an autonomous worker', { entrypoint: 'sdk-cli' })].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, id(3) + '.jsonl'), [U('Write a handoff note so a fresh session can continue'), U('Build the sushi game')].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, id(4) + '.jsonl'), [U('Write a handoff note so a fresh session can continue')].join('\n') + '\n');
    await R(`refresh()`); await sleep(500); let it = await items();
    ok(it.includes('Fix the login page'), '/clear named a chat: ' + it.slice(0, 6)); ok(it.includes('Build the sushi game'), 'stock handoff prompt named a chat'); ok(it.includes('Handoff note'), 'handoff-only chat name'); ok(!it.includes('You are an autonomous worker'), 'scripted run should be hidden');
    await R(`$('showEmpty').click()`); await sleep(300); ok((await items()).includes('You are an autonomous worker'), 'Show all should reveal scripted runs'); await R(`$('showEmpty').click()`); await sleep(200);
    await R(`$('new').click()`); await sleep(400); const k = await R(`active`); ok(await R(`$('title').textContent`) === 'New session', 'starts as New session');
    await R(`tabs[${JSON.stringify(k)}].sessionId = ${JSON.stringify(id(1))}; syncTabTitles()`); await sleep(150); ok(await R(`tabs[${JSON.stringify(k)}].title`) === 'Fix the login page' && await R(`$('title').textContent`) === 'Fix the login page', 'open tab did not take the real title');
    await R(`closeTab(${JSON.stringify(k)})`);
  });
  await flow('Cmd+A selects the prompt, Backspace clears it', async () => {
    await R(`$('new').click()`); await sleep(400);
    const T = `tabs[active].term`, key = (k, c, meta) => R(`${T}.textarea.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(k)}, keyCode:${c}, metaKey:${!!meta}, bubbles:true, cancelable:true}))`);
    const screen = t => R(`new Promise(r => { ${T}.reset(); ${T}.write(${JSON.stringify(t)}, r); })`);
    await R(`window.__w = []; { const o = ipc.send.bind(ipc); ipc.send = (c, k, d) => { if (c === 'write') __w.push(d); else o(c, k, d); }; window.__o = o; } 0`);
    const box = 'earlier output\r\n> old line\r\n' + '─'.repeat(40) + '\r\n❯ hello big prompt\r\n  second line\r\n' + '─'.repeat(40) + '\r\n  ? for shortcuts';
    await screen(box); await key('a', 65, true);
    const sel = await R(`${T}.getSelection()`); ok(sel.includes('hello big prompt') && sel.includes('second line') && !sel.includes('old line') && !sel.includes('shortcuts'), 'selection: ' + sel);
    await key('Shift', 16); ok(await R(`${T}.hasSelection()`), 'holding Shift dropped the selection');
    const wipe = '\x7f'.repeat(sel.length) + '\x1b[3~'.repeat(sel.length);
    await key('Backspace', 8); ok((await R(`__w.join('')`)) === wipe, 'Backspace sent ' + JSON.stringify(await R(`__w`))); ok(!(await R(`${T}.hasSelection()`)), 'selection stayed after clearing');
    await R(`__w.length = 0`); await key('Backspace', 8); ok((await R(`__w.join('')`)) === '\x7f', 'second Backspace should be normal: ' + JSON.stringify(await R(`__w`)));
    await screen(box); await key('a', 65, true); await R(`__w.length = 0`); await key('x', 88); ok((await R(`__w[0]`)) === wipe, 'typing over should clear first: ' + JSON.stringify(await R(`__w`)));
    await screen(box); await key('a', 65, true); await R(`${T}.select(0, 0, 5); __w.length = 0`); await key('Backspace', 8); ok((await R(`__w.join('')`)) === '\x7f', 'a mouse selection must not arm clearing: ' + JSON.stringify(await R(`__w`)));
    await screen('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No'); await key('a', 65, true); ok(!(await R(`${T}.hasSelection()`)), 'menu picked up as a prompt');
    await R(`ipc.send = __o; 0`);
  });
  await flow('31 images: thumbnails sit on their own chat line inside the terminal, click enlarges, survive a redraw, never on the prompt box', async () => {
    const dir = path.join(os.homedir(), '.claude/projects/-imgs'); fs.mkdirSync(dir, { recursive: true }); const id = '33333333-3333-4333-8333-000000000001', f = path.join(dir, id + '.jsonl');
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
    const J = o => JSON.stringify(o) + '\n';
    fs.writeFileSync(f, J({ type: 'user', cwd: os.homedir(), message: { content: 'hi' } }) + J({ type: 'user', message: { content: [{ type: 'text', text: 'look [Image #1]' }, img] } })
      + J({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/Users/x/Downloads/shot one.png' } }] } })
      + J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [img] }] } })
      + J({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/Users/x/Downloads/two.png' } }] } })
      + J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: [img] }] } }));
    wc.setBackgroundThrottling(false); // hidden test window: no animation frames otherwise, so xterm never draws decorations
    await R(`$('new').click()`); await sleep(400); const k = JSON.stringify(await R(`active`)), T = `tabs[${k}]`;
    const w0 = await R(`${T}.el.getBoundingClientRect().width`);
    const SCREEN = '\x1b[2J\x1b[3J\x1b[H❯ look [Image #1]\r\n\r\n⏺ Reading 1 file\r\n  ⎿  Downloads/shot one.png\r\n\r\n⏺ Here is what it shows.\r\n\r\n⏺ Read 1 file, listed 1 directory (ctrl+o to expand)\r\n\r\n⏺ I opened two.png for you.\r\n' + 'reply line\r\n'.repeat(6) + '──────────\r\n❯ [Image #1] typing\r\n──────────\r\n';
    await R(`${T}.term.write(${JSON.stringify(SCREEN)}); ${T}.sessionId = '${id}'; pollImages()`); await sleep(900);
    const state = async () => JSON.parse(await R(`JSON.stringify((() => { const t = ${T}, b = t.term.buffer.active, txt = i => b.getLine(i).translateToString(true);
      const ims = [...t.el.querySelectorAll('.ximg')].map(i => { const r = i.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, ok: i.complete && i.naturalWidth === 1, tip: i.title }; });
      return { lines: (t.decos || []).filter(d => !d.isDisposed).map(d => txt(d.marker.line).trim()), ims, el: t.el.getBoundingClientRect().toJSON() }; })())`));
    let r = await state();
    ok(JSON.stringify(r.lines) === JSON.stringify(['❯ look [Image #1]', '⎿  Downloads/shot one.png', '⏺ Read 1 file, listed 1 directory (ctrl+o to expand)']), 'thumbnails on wrong lines: ' + JSON.stringify(r.lines));
    ok(r.ims.length === 3 && r.ims.every(i => i.ok && i.w <= 161 && i.h <= 73 && i.x > r.el.left && i.x < r.el.right && i.y > r.el.top && i.y < r.el.bottom), 'thumbnails not small/inside the terminal ' + JSON.stringify(r.ims));
    ok(r.ims[0] && r.ims[0].tip.startsWith('Sent by you') && r.ims[1].tip.startsWith('Opened by Claude'), 'tips');
    ok(Math.abs(await R(`${T}.el.getBoundingClientRect().width`) - w0) < 1, 'terminal lost width');
    // real mouse click on the thumbnail (hit-testing through xterm), then close
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(r.ims[1].x), y: Math.round(r.ims[1].y), button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: Math.round(r.ims[1].x), y: Math.round(r.ims[1].y), button: 'left', clickCount: 1 }); await sleep(200);
    ok(await R(`getComputedStyle($('lb')).display`) === 'flex', 'clicking the thumbnail did not enlarge it'); await R(`$('lb').click()`); ok(await R(`getComputedStyle($('lb')).display`) === 'none', 'enlarged image did not close');
    // Claude redraws the whole screen (resize, /clear of the screen): thumbnails come back on the new lines
    await R(`${T}.term.write(${JSON.stringify(SCREEN)})`); await sleep(700); r = await state();
    ok(r.lines.length === 3 && r.ims.length === 3, 'thumbnails lost after a redraw: ' + JSON.stringify(r.lines));
    await R(`${T}.sessionId = '33333333-3333-4333-8333-000000000002'; pollImages()`); await sleep(400); ok((await state()).ims.length === 0, '/clear kept the old images');
    await R(`closeTab(${k})`);
  });
  await flow('22 JS console errors', async () => { ok(!jserr.length, jserr.join(' | ')); });
  note('23 Load more (>300 sessions)', 'NOT_TESTED_needs 300+ fixtures'); note('24 drag-drop file onto session', 'NOT_TESTED_needs real OS file drop');
  note('25 Update & restart click', 'NOT_TESTED_runs install.sh and relaunches');
  await flow('26 quit-with-sessions dialog (own sandbox process only)', async () => {
    await R(`ipc.invoke('setSetting', 'desk.quitSessions', 'ask')`); // flow 15 left it on the last option
    const n = await R(`Object.keys(tabs).length`); let calls = [], answer = 3;
    dialog.showMessageBoxSync = (w, o) => { calls.push(o); return answer; };
    app.quit(); await sleep(500); ok(calls.length === 1, 'dialog calls ' + calls.length); ok(calls[0] && calls[0].message.startsWith(`${n} session${n > 1 ? 's are' : ' is'} open`), 'message: ' + (calls[0] && calls[0].message));
    ok(calls[0] && calls[0].buttons.join() === 'Keep running,Always keep running,Stop them,Cancel' && calls[0].cancelId === 3, 'quit choices'); ok(!win.isDestroyed(), 'Cancel did not keep the window');
    ok(await R(`Object.keys(tabs).length`) === n, 'Cancel lost tabs');
  });
  console.log('\n=== UITEST RESULTS ===');
  for (const [n, s, e] of results) console.log(`${s.padEnd(10)} ${n}${e ? '\n           ' + e : ''}`);
  const bad = results.filter(r => r[1] === 'FAIL').length; console.log(`\n${results.length - bad - results.filter(r => r[1] === 'NOT_TESTED').length} pass, ${bad} fail`);
  answerQuit(bad);
}
function answerQuit(bad) { dialog.showMessageBoxSync = () => 0; setTimeout(() => app.exit(bad ? 1 : 0), 100); }
