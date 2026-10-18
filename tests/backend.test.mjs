// Runs apps-script/Code.gs against an in-memory fake of Google's services,
// so the sync protocol (auth, push, pull, upsert, types, nudges) is verified without a Google account.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, TOKEN, TZ } from './fake-google.mjs';


test('rejects wrong token and the unconfigured default token', () => {
  const { post } = boot();
  assert.deepEqual(post({ token: 'nope', action: 'ping' }), { ok: false, error: 'unauthorized' });
  const raw = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(raw, /CHANGE_ME_TO_A_LONG_RANDOM_STRING/, 'shipped file must still carry the placeholder');
});

test('ping works with the right token', () => {
  const { post } = boot();
  const r = post({ token: TOKEN, action: 'ping' });
  assert.equal(r.ok, true);
  assert.ok(r.tables.includes('sessions'));
});

test('push then pull round-trips rows with correct types', () => {
  const { post } = boot();
  const now = Date.now();
  const push = post({
    token: TOKEN,
    action: 'push',
    tables: {
      topics: [{ id: 't1', subject: 'FAR', chapter: '', name: 'IFRS 16', estMin: 210, weightage: 8.5, difficulty: 4, confidence: 3, status: 'doing', spentMin: 30, firstPassMin: 0, revisionCount: 0, lastTouched: '2026-10-18', skip: false, deleted: false, updatedAt: now }],
      sessions: [{ id: 's1', date: '2026-10-18', startTs: now - 1800000, endTs: now, minutes: 30, topicId: 't1', subject: 'FAR', activity: 'practice', units: '', focus: 4, pauses: 0, planned: true, logDelaySec: 12, mode: 'full', energy: 'amber', notes: '', deleted: false, updatedAt: now }],
      events: [{ id: 'e1', ts: now, type: 'start', payload: { latencySec: 40, from: 'open' }, updatedAt: now }],
      meta: [{ id: 'main', updatedAt: now, data: { settings: { examDate: '2027-03-01', ifThen: 'If dinner then START' }, streak: { current: 3 } } }]
    }
  });
  assert.equal(push.ok, true);
  assert.deepEqual(push.result.sessions, { updated: 0, added: 1 });

  const pull = post({ token: TOKEN, action: 'pull', since: 0 });
  assert.equal(pull.ok, true);
  const t = pull.tables.topics[0];
  assert.equal(t.weightage, 8.5);
  assert.equal(t.estMin, 210);
  assert.equal(t.skip, false);
  assert.equal(t.lastTouched, '2026-10-18');
  const s = pull.tables.sessions[0];
  assert.equal(s.minutes, 30);
  assert.equal(s.planned, true);
  assert.equal(s.units, null);
  assert.equal(s.date, '2026-10-18');
  assert.deepEqual(pull.tables.events[0].payload, { latencySec: 40, from: 'open' });
  assert.equal(pull.tables.meta[0].data.settings.examDate, '2027-03-01');
});

test('upsert is last-write-wins by updatedAt and never duplicates ids', () => {
  const { post, sheets } = boot();
  const row = (extra) => ({ id: 's1', date: '2026-10-18', minutes: 30, deleted: false, updatedAt: 1000, ...extra });
  post({ token: TOKEN, action: 'push', tables: { sessions: [row({})] } });
  // newer wins
  let r = post({ token: TOKEN, action: 'push', tables: { sessions: [row({ minutes: 45, updatedAt: 2000 })] } });
  assert.deepEqual(r.result.sessions, { updated: 1, added: 0 });
  // older is ignored
  r = post({ token: TOKEN, action: 'push', tables: { sessions: [row({ minutes: 5, updatedAt: 500 })] } });
  assert.deepEqual(r.result.sessions, { updated: 0, added: 0 });
  // duplicate ids inside one batch collapse to the newest
  r = post({ token: TOKEN, action: 'push', tables: { sessions: [row({ id: 's2', minutes: 10, updatedAt: 10 }), row({ id: 's2', minutes: 20, updatedAt: 20 })] } });
  assert.deepEqual(r.result.sessions, { updated: 0, added: 1 });
  const pulled = post({ token: TOKEN, action: 'pull', since: 0 }).tables.sessions;
  assert.equal(pulled.length, 2);
  assert.equal(pulled.find((x) => x.id === 's1').minutes, 45);
  assert.equal(pulled.find((x) => x.id === 's2').minutes, 20);
  assert.equal(sheets.sessions.getLastRow(), 3); // header + 2 rows
});

test('pull respects the since filter', () => {
  const { post } = boot();
  post({ token: TOKEN, action: 'push', tables: { sessions: [{ id: 'old', date: '2026-10-01', minutes: 10, deleted: false, updatedAt: 100 }, { id: 'new', date: '2026-10-18', minutes: 20, deleted: false, updatedAt: 900 }] } });
  const ids = post({ token: TOKEN, action: 'pull', since: 500 }).tables.sessions.map((r) => r.id);
  assert.deepEqual(ids, ['new']);
});

test('setup creates every tab and the dashboard', () => {
  const { run, sheets } = boot();
  run('setup()');
  for (const name of ['meta', 'topics', 'sessions', 'days', 'plans', 'events', 'Dashboard']) assert.ok(sheets[name], `missing tab ${name}`);
});

test('nudges: one email per slot, skipped once you studied or turned them off', () => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date())) % 24;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  const a = boot({ nudgeHour: hour });
  a.post({ token: TOKEN, action: 'push', tables: { meta: [{ id: 'main', updatedAt: 1, data: { settings: { ifThen: 'If dinner, then START', nudgesOn: true } } }] } });
  a.run('nudgeCheck()');
  assert.equal(a.mails.length, 1);
  assert.match(a.mails[0].body, /If dinner, then START/);
  a.run('nudgeCheck()');
  assert.equal(a.mails.length, 1, 'second call in the same slot must not resend');

  const b = boot({ nudgeHour: hour });
  b.post({ token: TOKEN, action: 'push', tables: { sessions: [{ id: 's', date: today, minutes: 20, deleted: false, updatedAt: 1 }] } });
  b.run('nudgeCheck()');
  assert.equal(b.mails.length, 0, 'no nudge after studying');

  const c = boot({ nudgeHour: hour });
  c.post({ token: TOKEN, action: 'push', tables: { meta: [{ id: 'main', updatedAt: 1, data: { settings: { nudgesOn: false } } }] } });
  c.run('nudgeCheck()');
  assert.equal(c.mails.length, 0, 'respects nudgesOn=false');
});
