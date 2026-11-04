// node check.js: fails if session reading breaks (e.g. Claude Code changes its file format).
const assert = require('assert'), S = require('./sessions');
(async () => {
  const { items: list, total } = S.list();
  assert(total >= list.length, 'total wrong');
  assert(list.length > 0, 'no sessions found');
  const titled = list.filter(s => !s.empty);
  assert(titled.length > list.length / 2, 'most sessions have no title, title parsing broke');
  assert(!titled.some(s => s.title.startsWith('<command-name>')), 'raw /clear titles leaking through');
  const live = S.live();
  assert(Object.keys(live.byId).length > 0, 'no live session found (this check runs inside one)');
  await require('./usage').selfcheck();
  const u = await S.usage(titled[0].file);
  assert(u.turns > 0 && u.output > 0, 'usage parsing broke');
  console.log(`OK: ${list.length} sessions, ${titled.length} titled, live: ${Object.values(live.byId).map(v => v.status).join(',')}, newest usage ${u.turns} turns`);
  console.log(titled.slice(0, 8).map(s => '  ' + s.title).join('\n'));
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
