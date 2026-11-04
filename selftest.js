// DESK_SELFTEST=1 electron selftest.js : hidden window, opens one new claude session, prints what the terminal shows, quits.
const { app, BrowserWindow } = require('electron');
app.setActivationPolicy && app.setActivationPolicy('prohibited');
app.whenReady().then(() => {
  const orig = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = function (f) {
    this.hide();
    console.log('step load-called');
    this.webContents.once('did-finish-load', async () => {
      console.log('step loaded');
      await this.webContents.executeJavaScript(`openTab(null, require('os').tmpdir(), 'selftest')`);
      console.log('step tab-opened'); await new Promise(r => setTimeout(r, 12000));
      const out = await this.webContents.executeJavaScript(`(() => { const t = Object.values(tabs)[0]; const b = t.term.buffer.active;
        let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n';
        return JSON.stringify({ pid: t.pid, sidebarItems: document.querySelectorAll('.it').length, dots: [...document.querySelectorAll('.dot')].map(d=>d.className).slice(0,3), text: s.trim() }); })()`);
      console.log(out); const img = await Promise.race([this.webContents.capturePage(), new Promise(r=>setTimeout(()=>r(null),5000))]);
      if (img) require('fs').writeFileSync(process.env.SHOT, img.toPNG()); else console.log('step no-capture'); app.quit();
    });
    return orig.call(this, f);
  };
  require('./main.js');
});
