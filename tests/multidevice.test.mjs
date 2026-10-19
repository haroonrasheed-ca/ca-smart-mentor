// Two devices, one Google Sheet. The real Code.gs runs on the fake backend; "switching device" swaps the
// whole local state, the way picking up a different phone would.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, TOKEN } from './fake-google.mjs';

const mem = {};
globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => (mem[k] = String(v)), removeItem: (k) => delete mem[k] };

const S = await import('../js/store.js');
const A = await import('../js/actions.js');
const Sync = await import('../js/sync.js');
const { dstr, addDays } = await import('../js/utils.js');

const today = dstr();
const fake = boot();
globalThis.fetch = async (_url, { body }) => ({ json: async () => fake.post(JSON.parse(body)) });
S.setConn({ url: 'https://script.google.com/macros/s/fake/exec', token: TOKEN });

const snapshot = () => JSON.parse(JSON.stringify(S.getState()));
const switchTo = (snap) => {
  const live = S.getState();
  for (const k of Object.keys(live)) delete live[k];
  Object.assign(live, JSON.parse(JSON.stringify(snap)));
};
const remote = () => fake.post({ token: TOKEN, action: 'pull', since: 0 }).tables;
const remoteSettings = () => remote().meta.find((r) => r.id === 'main').data.settings;
const tick = () => new Promise((r) => setTimeout(r, 8)); // two saves never share a millisecond
const live = (o) => Object.values(o).filter((x) => !x.deleted);

let snapA;
let snapB;
const EXAM1 = addDays(today, 90);
const EXAM2 = addDays(today, 120);

test('device A sets up and the Sheet becomes the source', async () => {
  A.saveSettings({ examDate: EXAM1, baselineWeekdayMin: 120, weeklyRestDay: 0, ifThen: 'If dinner, then START', onboarded: true, theme: 'dark' });
  A.importTopicsCSV('subject,chapter,name,estMin,weightage,difficulty\nAAFR,c,AAFR one,300,10,3\nAAFR,c,AAFR two,300,10,3\nBFD,c,BFD one,300,10,3');
  A.saveSettings({ 'exam:AAFR': addDays(today, 50), 'exam:BFD': addDays(today, 60) });
  await Sync.syncNow();
  assert.equal(Sync.getStatus().state, 'ok', Sync.getStatus().msg);
  assert.equal(live(remote().topics).length, 3);
  assert.equal(remoteSettings().subjectExams.AAFR, addDays(today, 50));
  snapA = snapshot();
});

test('a new device B joins the same Sheet and gets the same settings, without sending anything of its own', async () => {
  S.resetAll();
  assert.equal(S.getState().meta.settings.onboarded, false, 'B starts blank');
  await Sync.syncNow();
  const b = S.getState();
  assert.equal(Sync.getStatus().state, 'ok', Sync.getStatus().msg);
  assert.match(Sync.getStatus().msg, /came from the Sheet/);
  assert.equal(b.meta.settings.examDate, EXAM1);
  assert.equal(b.meta.settings.baselineWeekdayMin, 120);
  assert.equal(b.meta.settings.weeklyRestDay, 0);
  assert.equal(b.meta.settings.ifThen, 'If dinner, then START');
  assert.equal(b.meta.settings.onboarded, true, 'B does not ask to onboard again');
  assert.equal(b.meta.settings.subjectExams.BFD, addDays(today, 60));
  assert.equal(b.meta.settings.theme, 'auto', 'the colour theme stays per device');
  assert.equal(live(b.topics).length, 3);
  assert.equal(live(remote().topics).length, 3, 'nothing extra was pushed');
  snapB = snapshot();
});

test('a device that only rolled over a day cannot overwrite settings saved on the other device', async () => {
  await tick();
  switchTo(snapA);
  A.saveSettings({ examDate: EXAM2, minStreakMin: 120 });
  await Sync.syncNow();
  assert.equal(remoteSettings().examDate, EXAM2);
  snapA = snapshot();

  await tick();
  switchTo(snapB); // B still has the old settings...
  S.touchMeta(); // ...and just did its daily rollover, which makes its meta look newer
  await Sync.syncNow();
  const b = S.getState();
  assert.equal(b.meta.settings.examDate, EXAM2, 'B picked up A’s newer settings');
  assert.equal(b.meta.settings.minStreakMin, 120);
  assert.equal(remoteSettings().examDate, EXAM2, 'and the Sheet still has them');
  assert.equal(remoteSettings().minStreakMin, 120);
  snapB = snapshot();
});

test('a change made on B reaches A', async () => {
  await tick();
  switchTo(snapB);
  A.saveSettings({ baselineWeekdayMin: 200, 'exam:AAFR': addDays(today, 45) });
  await Sync.syncNow();
  snapB = snapshot();
  switchTo(snapA);
  await Sync.syncNow();
  const a = S.getState();
  assert.equal(a.meta.settings.baselineWeekdayMin, 200);
  assert.equal(a.meta.settings.subjectExams.AAFR, addDays(today, 45));
  assert.equal(a.meta.settings.examDate, EXAM2, 'earlier settings are kept too');
  assert.equal(a.meta.settings.theme, 'dark', 'A keeps its own theme');
});

test('topics added on one device show up on the other', async () => {
  await tick();
  A.importTopicsCSV('subject,chapter,name,estMin,weightage,difficulty\nBFD,c,BFD two,200,8,3');
  await Sync.syncNow();
  snapA = snapshot();
  switchTo(snapB);
  await Sync.syncNow();
  assert.ok(live(S.getState().topics).some((t) => t.name === 'BFD two'));
  assert.equal(live(S.getState().topics).length, 4);
});

test('a device with its own data meets a Sheet with data: it asks instead of guessing', async () => {
  const before = live(remote().topics).length;
  S.resetAll();
  A.saveSettings({ examDate: addDays(today, 10), onboarded: true });
  A.importTopicsCSV('subject,chapter,name,estMin,weightage,difficulty\nLaw,c,Only on this device,100,5,2');
  await Sync.syncNow();
  assert.equal(Sync.getStatus().state, 'ask');
  assert.equal(Sync.isAsking(), true);
  assert.equal(live(remote().topics).length, before, 'nothing was sent while it waits');
  await Sync.syncNow(); // an automatic sync while the question is open does nothing
  assert.equal(live(remote().topics).length, before);
  assert.equal(Sync.useSheetData(), true);
  const c = S.getState();
  assert.equal(live(c.topics).length, before);
  assert.ok(!live(c.topics).some((t) => t.name === 'Only on this device'));
  assert.equal(c.meta.settings.examDate, EXAM2, 'settings came from the Sheet');
  await Sync.syncNow();
  assert.equal(Sync.getStatus().state, 'ok');
});

test('saying "not now" keeps the device untouched and the Sheet unchanged', async () => {
  const before = live(remote().topics).length;
  S.resetAll();
  A.importTopicsCSV('subject,chapter,name,estMin,weightage,difficulty\nLaw,c,Keep me,100,5,2');
  await Sync.syncNow();
  assert.equal(Sync.getStatus().state, 'ask');
  Sync.dropFirstChoice();
  assert.equal(Sync.isAsking(), false);
  assert.ok(live(S.getState().topics).some((t) => t.name === 'Keep me'));
  assert.equal(live(remote().topics).length, before);
});

test('mergeRemoteMeta: newest settings save wins, streak and plan follow the further-along device', () => {
  const local = { meta: { settings: { examDate: 'L', theme: 'dark' }, settingsAt: 100, streak: { current: 3, lastProcessed: '2026-10-10' }, activePlanId: 'p1', lastSnapshotDate: '2026-10-10' }, metaUpdatedAt: 900, dirty: { meta: 0 } };
  const row = (settingsAt, extra = {}) => ({ id: 'main', updatedAt: 500, data: { settings: { examDate: 'R', theme: 'light' }, settingsAt, streak: { current: 5, lastProcessed: '2026-10-15' }, activePlanId: 'p2', lastSnapshotDate: '2026-10-15', ...extra } });
  // remote settings are older: local settings stay, but the further-along streak and plan are taken
  assert.equal(Sync.mergeRemoteMeta(local, row(50)), true);
  assert.equal(local.meta.settings.examDate, 'L');
  assert.equal(local.meta.streak.current, 5);
  assert.equal(local.meta.activePlanId, 'p2');
  // remote settings are newer: adopted, but the theme stays this device's own
  assert.equal(Sync.mergeRemoteMeta(local, row(300)), true);
  assert.equal(local.meta.settings.examDate, 'R');
  assert.equal(local.meta.settings.theme, 'dark');
  assert.equal(local.meta.settingsAt, 300);
  // a stale copy changes nothing
  assert.equal(Sync.mergeRemoteMeta(local, { id: 'main', updatedAt: 1, data: { settings: { examDate: 'OLD' }, settingsAt: 10, streak: { lastProcessed: '2026-01-01' } } }), false);
  assert.equal(local.meta.settings.examDate, 'R');
});
