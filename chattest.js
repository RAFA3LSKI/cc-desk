// DESK_SELFTEST=1 SHOT=out.png electron chattest.js : hidden window, real claude, sends one message through the chat box,
// waits for the reply in the chat view, answers a permission menu with its button if one shows, prints what the chat shows.
const { app, BrowserWindow, dialog } = require('electron');
dialog.showMessageBoxSync = () => 2;
process.env.DESK_PTYD_SOCK = require('path').join(require('os').tmpdir(), 'desk-chattest-' + process.pid + '.sock'); process.env.DESK_PTYD_EXIT_WITH_CLIENT = '1';
app.setActivationPolicy && app.setActivationPolicy('prohibited');
const wait = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(() => {
  const orig = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = function (f) {
    this.hide(); this.webContents.setBackgroundThrottling(false);
    const js = s => this.webContents.executeJavaScript(s);
    this.webContents.once('did-finish-load', async () => {
      const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'chattest-'));
      await js(`openTab(null, ${JSON.stringify(dir)}, 'chattest')`); await wait(12000);
      // fresh temp dir = folder-trust prompt (CC Desk strips CLAUDE_CODE_CHILD_SESSION, which used to skip it): pick "Yes, I trust"
      if (/trust this folder/.test(await js(`(() => { const b = Object.values(tabs)[0].term.buffer.active; let s=''; for (let i=0;i<b.length;i++) s += b.getLine(i).translateToString(true); return s; })()`))) { await js(`ipc.send('write', Object.keys(tabs)[0], '\\x1b[B'); setTimeout(() => ipc.send('write', Object.keys(tabs)[0], '\\r'), 400)`); await wait(8000); }
      const pre = JSON.parse(await js(`(() => { const t = Object.values(tabs)[0]; const b = t.term.buffer.active; let s=''; for (let i=0;i<b.length;i++) s += b.getLine(i).translateToString(true).trimEnd()+'\\n'; return JSON.stringify({ pid: t.pid, livePids: Object.keys(liveState.byPid), sid: t.sessionId, text: s.trim().slice(-1500) }); })()`)); console.log('PRETEXT'); console.log(pre.text); console.log('MENU', await js('JSON.stringify(Object.values(tabs)[0].menu)+" hidden="+Object.values(tabs)[0].ask.hidden'));
      const st = () => js(`(() => { const t = Object.values(tabs)[0]; return { mode: t.mode, sid: t.sessionId, me: [...t.col.querySelectorAll('.cme')].map(x => x.textContent),
        bot: [...t.col.querySelectorAll('.cbody')].map(x => x.innerText.slice(0, 200)), chips: [...t.col.querySelectorAll('.cstep')].map(x => x.className + ' ' + x.innerText),
        ask: t.ask.hidden ? null : t.ask.innerText, live: t.live.hidden ? null : t.live.innerText, modeTag: t.modeEl.hidden ? null : t.modeEl.textContent, pid: t.pid, pidLive: JSON.stringify(liveState.byPid[t.pid] || null), tail: (() => { const b = t.term.buffer.active; let s = ''; for (let i = Math.max(0, b.length - 14); i < b.length; i++) s += b.getLine(i).translateToString(true).trimEnd() + '\\n'; return s; })() }; })()`);
      let s, answered = false; await wait(1000); s = await st(); if (s.ask) { console.log('ASK0', JSON.stringify(s.ask)); await js(`(() => { const bs = [...Object.values(tabs)[0].ask.querySelectorAll('[data-opt]')]; (bs.find(b => /^yes/i.test(b.textContent)) || bs[0]).click(); })()`); await wait(6000); }
      const say = m => js(`(() => { const t = Object.values(tabs)[0]; t.ta.value = ${JSON.stringify(m)}; t.chatEl.querySelector('.csend').click(); })()`);
      if (process.env.SENDNOW) { // DESK SENDNOW=1: queue a message behind a 45 s command, click "Send now", the reply must come long before the command ends
        await say('Run this exact bash command in the foreground and wait for it: python3 -c "import time; time.sleep(45)" ; then say done'); await wait(7000);
        await say('Ignore the earlier task. Use the Bash tool to run: echo chat-ok   Then reply with one short sentence.'); await wait(1500);
        console.log('NOWBTN', await js(`(() => { const b = Object.values(tabs)[0].col.querySelector('.cnow'); const v = b && getComputedStyle(b).display; b && b.click(); return v; })()`)); }
      else await say('Use the Bash tool to run: echo chat-ok   Then reply with one short sentence.');
      const t0 = Date.now();

      for (let i = 0; i < 45; i++) { await wait(2000); s = await st();
        if (s.ask && !answered) { console.log('ASK', JSON.stringify(s.ask)); answered = true; await js(`(() => { const bs = [...Object.values(tabs)[0].ask.querySelectorAll('[data-opt]')]; (bs.find(b => /^yes/i.test(b.textContent)) || bs[0]).click(); })()`); answered = false; }
        if (s.bot.join(' ').match(/chat-ok/i) && !s.live) break; }
      console.log('SECS', Math.round((Date.now() - t0) / 1000)); console.log('CHAT', JSON.stringify(s, null, 1));
      const img = await Promise.race([this.webContents.capturePage(), wait(5000).then(() => null)]);
      if (img && process.env.SHOT) require('fs').writeFileSync(process.env.SHOT, img.toPNG());
      app.quit();
    });
    return orig.call(this, f);
  };
  require('./main.js');
});
