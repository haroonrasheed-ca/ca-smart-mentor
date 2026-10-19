// End-to-end flows through the real store + actions + views + sync (in Node, with a fake localStorage
// and the real Code.gs running on a fake Google backend). Tests run in order and share state on purpose,
// the way a real week of use does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, TOKEN } from './fake-google.mjs';

const mem = {};
globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => (mem[k] = String(v)), removeItem: (k) => delete mem[k] };

const S = await import('../js/store.js');
const E = await import('../js/engine.js');
const A = await import('../js/actions.js');
const V = await import('../js/views.js');
const Sh = await import('../js/sheets.js');
const Sync = await import('../js/sync.js');
const { dstr, addDays } = await import('../js/utils.js');

const today = dstr();
const at = (h) => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d;
};

function ctx(phase = 'evening') {
  const st = S.getState();
  const plan = E.computePlan(st, today);
  return {
    st, today, plan, phase,
    energy: A.currentEnergy(today),
    tunnel: A.isTunnel(phase, at(21)),
    micro: A.currentMicro(),
    swapsLeft: A.swapsLeft(),
    todayMin: plan.todayMin,
    hour: 21,
    sync: { state: 'idle', msg: '', last: 0 },
    conn: S.getConn(),
    recalc: A.recalcNotice()
  };
}
const clean = (html, label) => {
  assert.ok(html.length > 40, `${label} rendered nothing`);
  assert.ok(!/undefined|NaN|\[object/.test(html), `${label} contains undefined/NaN: ${(html.match(/.{30}(undefined|NaN|\[object).{30}/) || [''])[0]}`);
};

test('onboarding builds a baseline plan from the sample syllabus', () => {
  assert.equal(E.computePlan(S.getState(), today).status, 'setup');
  A.saveSettings({ examDate: addDays(today, 120), baselineWeekdayMin: 90, weeklyRestDay: -1, ifThen: 'If dinner, then START', onboarded: true });
  assert.equal(A.loadSample(), 26);
  assert.equal(A.loadSample(), 0, 'sample import is idempotent');
  A.ensureToday();
  const st = S.getState();
  const plan = E.computePlan(st, today);
  assert.notEqual(plan.status, 'setup');
  assert.ok(st.meta.activePlanId);
  const base = st.plans[st.meta.activePlanId];
  assert.equal(base.reason, 'initial');
  assert.equal(base.baselineStart, today);
  assert.ok(base.baselineTotal > 5000);
});

test('zero-form session: START → timer → 10-second log → topic advances', () => {
  const micro = A.currentMicro();
  assert.ok(micro && micro.estMin === 20);
  A.startSession({ topicId: micro.topicId, mode: 'full', text: micro.text });
  const st = S.getState();
  assert.ok(st.runtime.running);
  A.togglePause();
  assert.ok(st.runtime.running.paused);
  A.togglePause();
  st.runtime.running.startTs -= 25 * 60000; // pretend 25 minutes passed
  const draft = A.stopSession();
  assert.equal(draft.minutes, 25);
  assert.equal(st.runtime.running, null);
  const res = A.saveSession({ minutes: 25, topicId: micro.topicId, activity: 'practice', focus: 4, status: 'doing' });
  assert.equal(res.minutes, 25);
  const t = st.topics[micro.topicId];
  assert.equal(t.status, 'doing');
  assert.equal(t.spentMin, 25);
  assert.equal(st.days[today].minutes, 25);
  assert.equal(E.computePlan(st, today).todayMin, 25);
  const startEv = Object.values(st.events).find((e) => e.type === 'start');
  assert.ok(startEv && startEv.payload.latencySec >= 0);
  // finishing the topic records the real first-pass time (feeds the estimate multiplier)
  A.saveSession({ minutes: 100, date: today, topicId: micro.topicId, activity: 'reading', focus: 3, status: 'done', confidence: 4 });
  assert.equal(t.status, 'done');
  assert.equal(t.firstPassMin, 125);
  assert.equal(t.confidence, 4);
});

test('empty battery: maintenance target, low-effort micro-task, automatic Tunnel Vision', () => {
  A.setEnergy('red');
  const st = S.getState();
  const plan = E.computePlan(st, today);
  assert.equal(E.modeTarget(plan, st.meta.settings, 'red'), 30);
  assert.equal(A.autoTunnel('evening', at(15)), true, 'red battery always triggers tunnel');
  assert.equal(A.autoTunnel('morning', at(8)), false);
  assert.equal(A.modeForEnergy('red', true), 'maintenance');
  const m = A.currentMicro();
  assert.equal(m.estMin, 10);
  A.setTunnel(false);
  assert.equal(A.isTunnel('evening', at(21)), false, 'manual override beats the auto rule');
  A.setTunnel(true);
  assert.equal(A.isTunnel('evening', at(21)), true);
  // shrink + swap-once
  A.shrink();
  assert.equal(A.currentMicro().estMin, 5);
  const first = A.currentMicro().topicId;
  assert.equal(A.swapMicro(), true);
  assert.notEqual(A.currentMicro().topicId, first);
  assert.equal(A.swapMicro(), false);
  assert.equal(A.swapsLeft(), 0);
  A.setEnergy('green');
});

test('landing pad ends exactly once', () => {
  A.landingPadStart();
  const lp = S.getState().runtime.landingPad;
  assert.equal(lp.state, 'running');
  assert.equal(A.landingPadTick(Date.now()), false);
  assert.equal(A.landingPadTick(lp.endTs + 1), true);
  assert.equal(A.landingPadTick(lp.endTs + 2), false);
  assert.equal(S.getState().runtime.landingPad.state, 'done');
});

test('streak rollover after days away: grace, shield, counted days', () => {
  const st = S.getState();
  // pretend the app was last opened 4 days ago and we studied on days -4, -3 and -1 (missed -2)
  st.meta.streak = { ...st.meta.streak, current: 0, best: 0, missRun: 0, shields: 1, lastProcessed: addDays(today, -5) };
  for (const off of [-4, -3, -1]) A.saveSession({ minutes: 20, date: addDays(today, off), topicId: '', activity: 'reading', focus: 3 });
  A.ensureToday();
  assert.equal(st.meta.streak.current, 3);
  assert.equal(st.meta.streak.lastProcessed, addDays(today, -1));
  assert.ok(Object.values(st.events).some((e) => e.type === 'grace_day'));
  A.ensureToday(); // idempotent
  assert.equal(st.meta.streak.current, 3);
});

test('route options and Audit Bankruptcy (clean slate)', () => {
  const st = S.getState();
  // squeeze the calendar so the full syllabus is clearly infeasible
  st.meta.settings.examDate = addDays(today, 14);
  st.meta.settings.revisionBufferDays = 0;
  S.touchMeta();
  let plan = E.computePlan(st, today);
  assert.equal(plan.status, 'needs_route');
  A.applyRoute('triage');
  assert.equal(st.meta.settings.route.mode, 'triage');
  const parked = E.liveTopics(st).filter((t) => t.skip);
  assert.ok(parked.length > 0, 'triage parks some topics');
  A.applyRoute('auto');
  assert.equal(st.meta.settings.route.mode, 'auto');

  const bestBefore = st.meta.streak.best;
  const plansBefore = Object.keys(st.plans).length;
  A.bankruptcy({ examDate: addDays(today, 90), weekdayMin: 60, skipIds: parked.slice(0, 1).map((t) => t.id) });
  assert.equal(st.meta.streak.current, 0);
  assert.equal(st.meta.streak.best, bestBefore, 'best streak survives the reset');
  assert.equal(st.meta.settings.baselineWeekdayMin, 60);
  assert.equal(st.meta.settings.examDate, addDays(today, 90));
  assert.ok(Object.keys(st.plans).length > plansBefore);
  assert.equal(st.plans[st.meta.activePlanId].reason, 'restructure');
  const ev = Object.values(st.events).find((e) => e.type === 'bankruptcy');
  assert.ok(ev && ev.payload.remainingMin > 0, 'old plan is archived in the event log');
  assert.equal(A.recentBankruptcy(), true);
  plan = E.computePlan(st, today);
  assert.notEqual(plan.status, 'needs_route');
});

test('every screen and sheet renders without undefined/NaN', () => {
  for (const phase of ['morning', 'evening', 'night']) {
    for (const energy of ['', 'green', 'amber', 'red']) {
      if (energy) A.setEnergy(energy);
      A.setTunnel(false);
      clean(V.todayView({ ...ctx(phase), tunnel: false }), `today/${phase}/${energy}`);
    }
  }
  A.setEnergy('red');
  A.setTunnel(true);
  const tun = V.todayView(ctx('evening'));
  clean(tun, 'tunnel');
  assert.match(tun, /Your one thing/);
  assert.match(tun, /data-act="start"/);
  assert.doesNotMatch(tun, /Syllabus|Forecast/);
  A.setTunnel(false);
  A.setEnergy('green');

  clean(V.topBar(ctx()), 'topbar');
  const pace = V.paceView(ctx());
  clean(pace, 'pace');
  assert.match(pace, /<svg class="pace-chart"/);
  clean(V.topicsView(ctx()), 'topics');
  clean(V.settingsView(ctx()), 'settings');

  const st = S.getState();
  const c = ctx();
  clean(Sh.logSheet({ st, draft: { minutes: 25, topicId: E.liveTopics(st)[0].id } }), 'log sheet');
  clean(Sh.logSheet({ st, draft: { manual: true, minutes: '' } }), 'manual log sheet');
  clean(Sh.completeSheet({ minutes: 25, capital: 500 }), 'complete sheet');
  clean(Sh.routeSheet({ st }), 'route sheet');
  clean(Sh.bankruptcySheet({ st, plan: c.plan, recent: true }), 'bankruptcy sheet');
  clean(Sh.topicSheet({ topic: E.liveTopics(st)[0] }), 'topic sheet');
  clean(Sh.topicSheet({ topic: null }), 'new topic sheet');
  clean(Sh.importSheet(), 'import sheet');
  clean(Sh.onboardSheet({ st }), 'onboard sheet');

  // user-supplied text is escaped
  A.saveTopic({ subject: 'X<script>', name: '<img src=x onerror=alert(1)>', estMin: 30 });
  const html = V.topicsView(ctx());
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
});

test('log sheet adds a CSV-imported topic cleanly', () => {
  const n = A.importTopicsCSV('subject,chapter,name,estMin,weightage,difficulty\n"Law","Ch 1","Quoted, comma name",90,6,2\nAudit,,ISA 200,60,5,3');
  assert.equal(n, 2);
  assert.ok(E.liveTopics(S.getState()).some((t) => t.name === 'Quoted, comma name'));
});

test('end-to-end sync: device A pushes, a fresh device B pulls everything back', async () => {
  const fake = boot();
  globalThis.fetch = async (_url, { body }) => ({ json: async () => fake.post(JSON.parse(body)) });
  S.setConn({ url: 'https://script.google.com/macros/s/fake/exec', token: TOKEN });

  const st = S.getState();
  S.markAllDirty();
  assert.ok(S.dirtyCount() > 20);
  await Sync.syncNow();
  assert.equal(Sync.getStatus().state, 'ok', Sync.getStatus().msg);
  assert.equal(S.dirtyCount(), 0);

  const counts = { sessions: Object.keys(st.sessions).length, topics: Object.keys(st.topics).length };
  const exam = st.meta.settings.examDate;
  const sheetRows = (name) => fake.sheets[name].getLastRow() - 1;
  assert.equal(sheetRows('sessions'), counts.sessions);
  assert.equal(sheetRows('topics'), counts.topics);

  // device B: empty local state, same sheet
  S.resetAll();
  assert.equal(Object.keys(S.getState().topics).length, 0);
  await Sync.syncNow();
  const b = S.getState();
  assert.equal(Object.keys(b.sessions).length, counts.sessions);
  assert.equal(Object.keys(b.topics).length, counts.topics);
  assert.equal(b.meta.settings.examDate, exam);
  assert.equal(b.meta.settings.ifThen, 'If dinner, then START');
  assert.ok(b.meta.activePlanId && b.plans[b.meta.activePlanId]);
  assert.equal(E.computePlan(b, today).status !== 'setup', true);

  // a wrong token produces a clear message, not a crash
  S.setConn({ url: 'https://script.google.com/macros/s/fake/exec', token: 'wrong' });
  await Sync.syncNow();
  assert.equal(Sync.getStatus().state, 'error');
  assert.match(Sync.getStatus().msg, /Token/);
});

test('backup export / import round-trips', () => {
  const before = Object.keys(S.getState().topics).length;
  const json = S.exportBackup();
  S.resetAll();
  assert.equal(Object.keys(S.getState().topics).length, 0);
  S.importBackup(json);
  assert.equal(Object.keys(S.getState().topics).length, before);
  assert.throws(() => S.importBackup('{"app":"other"}'), /not a CA Smart Mentor backup/);
});

test('notes: jot while the timer runs, edit after saving, shown on Today and Pace', () => {
  const micro = A.currentMicro();
  A.startSession({ topicId: micro.topicId, mode: 'full', text: micro.text });
  A.setRunningNote('Lease modification still unclear');
  S.getState().runtime.running.startTs -= 12 * 60000;
  const draft = A.stopSession();
  assert.equal(draft.notes, 'Lease modification still unclear');
  const sheet = Sh.logSheet({ st: S.getState(), draft });
  assert.match(sheet, /name="notes"/);
  assert.match(sheet, /Lease modification still unclear/);
  A.saveSession({ minutes: 12, topicId: micro.topicId, activity: 'reading', focus: 3, status: 'doing', notes: 'Lease modification still unclear, redo Q4' });
  const row = E.liveSessions(S.getState()).find((x) => x.notes && x.notes.includes('redo Q4'));
  assert.ok(row, 'note stored on the session');
  assert.ok(A.setSessionNote(row.id, 'Edited note'));
  A.setEnergy('green');
  A.setTunnel(false);
  const today_ = V.todayView({ ...ctx(), tunnel: false });
  clean(today_, 'today');
  assert.match(today_, /Edited note/);
  assert.match(today_, /data-act="note-edit"/);
  assert.match(today_, /data-act="start"/);
  assert.match(V.paceView(ctx()), /Edited note/);
  assert.match(Sh.noteSheet({ session: row, topicName: 'X' }), /<textarea/);
});


test('import: optional status and confidence columns for students who are mid-way', () => {
  const before = E.liveTopics(S.getState()).length;
  const n = A.importTopicsCSV('subject,chapter,name,estMin,weightage,difficulty,status,confidence\nMID,Lectures 1-3,Mid chapter A,270,10,4,done,2\nMID,Lectures 4-5,Mid chapter B,180,10,3,In progress,\nMID,Lectures 6,Mid chapter C,90,10,3,revised,5\nMID,Lectures 7,Mid chapter D,90,10,3');
  assert.equal(n, 4);
  const mine = E.liveTopics(S.getState()).filter((t) => t.subject === 'MID');
  assert.equal(E.liveTopics(S.getState()).length, before + 4);
  const by = (name) => mine.find((t) => t.name === name);
  assert.equal(by('Mid chapter A').status, 'done');
  assert.equal(by('Mid chapter A').confidence, 2);
  assert.equal(by('Mid chapter B').status, 'doing');
  assert.equal(by('Mid chapter C').status, 'revised');
  assert.equal(by('Mid chapter C').revisionCount, 1);
  assert.equal(by('Mid chapter D').status, 'todo');
  assert.equal(by('Mid chapter D').confidence, 3);
  assert.match(Sh.importSheet(), /status/);
});
