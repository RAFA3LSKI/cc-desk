// Background-job parsing check (Raf 2026-11-09 "still running" line). Run: node test-bg.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deskbg-')); process.env.HOME = home;
const dir = path.join(home, '.claude/projects/-x'); fs.mkdirSync(dir, { recursive: true });
const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const note = id => `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`;
const lines = [
  use('a', 'Bash', { command: 'sleep 9', description: 'Wait for clips', run_in_background: true }), res('a', 'Command running in background with ID: b1.'),
  use('b', 'Bash', { command: 'grep x', description: 'Slow grep' }), res('b', 'out\nCommand did not complete within its 120s timeout and was moved to the background (ID: b2).'),
  use('c', 'Agent', { description: 'Scout', prompt: 'p' }), res('c', [{ type: 'text', text: 'Async agent launched successfully.' }]),
  use('d', 'Bash', { command: 'cat log', description: 'Read log' }), res('d', 'some text mentioning Async agent launched in the middle'), // not a job
  { type: 'queue-operation', operation: 'enqueue', content: note('a') },             // finish notice in a queued line
  { type: 'user', message: { content: note('c') } },                                  // finish notice as a user message
];
fs.writeFileSync(path.join(dir, '00000000-0000-0000-0000-000000000001.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
const s = require('./sessions.js'), bg = {};
for (const it of s.chat('00000000-0000-0000-0000-000000000001', 0).items) { if (it.k === 'bg') bg[it.id] = 1; if (it.k === 'bgdone') delete bg[it.id]; }
assert.deepStrictEqual(Object.keys(bg), ['b'], 'only the timed-out grep should still be running, got ' + Object.keys(bg));
fs.rmSync(home, { recursive: true }); console.log('test-bg: PASS');
