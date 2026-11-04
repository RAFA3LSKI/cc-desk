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
      fs.mkdirSync(path.join(C, 'projects', d), { recursive: true }); fs.copyFileSync(f, path.join(C, 'projects', d, n)); picked.push(f); } }
  // fake login shell: no real claude. "mcp" call answers a fixed list, anything else just idles like a terminal session.
  fs.writeFileSync(path.join(H, 'fakesh'), '#!/bin/sh\ncase "$*" in *mcp*) echo "claude.ai Fake: https://x - Connected";; *) exec sleep 600;; esac\n', { mode: 0o755 });
  console.log('sandbox HOME:', H, '| fixtures:', picked.length);
  const env = { ...process.env, HOME: H, SHELL: path.join(H, 'fakesh'), DESK_UITEST: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.DESK_SMOKE;
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
  const flow = async (name, fn) => { fails = []; try { await fn(); } catch (e) { fails.push('EXC ' + e.message); } results.push([name, fails.length ? 'FAIL' : 'PASS', fails.join(' | ')]); };
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
    ok(a[0] === 'Hide empty', 'label ' + a[0]); ok(a[1] === fixtures.length, `rows ${a[1]} vs ${fixtures.length}`);
    await R(`$('showEmpty').click()`); ok(await R(`$('showEmpty').textContent`) === 'Show empty', 'label did not revert');
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
    const want = { 'desk.notify': get('desk.notify'), inputNeededNotifEnabled: !!get('inputNeededNotifEnabled'), agentPushNotifEnabled: !!get('agentPushNotifEnabled') };
    ok(a.length === 3 && a.every(x => { const [k, v] = x.split(':'); return String(want[k]) === v; }), `switch state ${a} vs file ${JSON.stringify(want)}`);
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
    for (const [w, h] of [[900, 600], [1300, 850], [1000, 700]]) { win.setSize(w, h); await sleep(600);
      const r = JSON.parse(await R(`JSON.stringify((() => { const t = tabs[active], d = t.fit.proposeDimensions(), a = t.el.getBoundingClientRect(), b = $('terms').getBoundingClientRect();
        return { cols: t.term.cols, rows: t.term.rows, pc: d.cols, pr: d.rows, inside: a.right <= b.right + 1 && a.bottom <= b.bottom + 1, w: innerWidth }; })())`));
      ok(r.cols === r.pc && r.rows === r.pr && r.inside, `${w}x${h}: ${JSON.stringify(r)}`); }
  });
  await flow('22 JS console errors', async () => { ok(!jserr.length, jserr.join(' | ')); });
  note('23 Load more (>300 sessions)', 'NOT_TESTED_needs 300+ fixtures'); note('24 drag-drop file onto session', 'NOT_TESTED_needs real OS file drop');
  note('25 Update & restart click', 'NOT_TESTED_runs install.sh and relaunches');
  await flow('26 quit-with-sessions dialog (own sandbox process only)', async () => {
    const n = await R(`Object.keys(tabs).length`); let calls = [], answer = 1;
    dialog.showMessageBoxSync = (w, o) => { calls.push(o); return answer; };
    app.quit(); await sleep(500); ok(calls.length === 1, 'dialog calls ' + calls.length); ok(calls[0] && calls[0].message.startsWith(`${n} session${n > 1 ? 's are' : ' is'} open`), 'message: ' + (calls[0] && calls[0].message));
    ok(calls[0] && calls[0].buttons.join() === 'Quit,Cancel' && calls[0].defaultId === 1, 'Cancel should be default'); ok(!win.isDestroyed(), 'Cancel did not keep the window');
    ok(await R(`Object.keys(tabs).length`) === n, 'Cancel lost tabs');
  });
  console.log('\n=== UITEST RESULTS ===');
  for (const [n, s, e] of results) console.log(`${s.padEnd(10)} ${n}${e ? '\n           ' + e : ''}`);
  const bad = results.filter(r => r[1] === 'FAIL').length; console.log(`\n${results.length - bad - results.filter(r => r[1] === 'NOT_TESTED').length} pass, ${bad} fail`);
  answerQuit(bad);
}
function answerQuit(bad) { dialog.showMessageBoxSync = () => 0; setTimeout(() => app.exit(bad ? 1 : 0), 100); }
