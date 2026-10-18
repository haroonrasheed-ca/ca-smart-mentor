import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/engine.js';
import { addDays } from '../js/utils.js';

const TODAY = '2026-10-18'; // a Sunday

function topic(id, subject, estMin, extra = {}) {
  return { id, subject, chapter: '', name: id, estMin, weightage: 5, difficulty: 3, confidence: 3, status: 'todo', spentMin: 0, firstPassMin: 0, revisionCount: 0, lastTouched: '', skip: false, ...extra };
}

function makeState({ examDate = addDays(TODAY, 60), topics = [], sessions = [], days = {}, settings = {}, plan = null } = {}) {
  const st = {
    meta: {
      settings: { examDate, revisionBufferDays: 0, weeklyRestDay: -1, baselineWeekdayMin: 90, maintenanceMin: 30, minStreakMin: 15, route: { mode: 'auto', dailyMin: 0 }, ...settings },
      streak: { current: 0, best: 0, missRun: 0, shields: 1, maintenanceDays: 0, totalDays: 0, lastProcessed: addDays(TODAY, -1) },
      activePlanId: plan ? plan.id : null
    },
    topics: {},
    sessions: {},
    days,
    plans: plan ? { [plan.id]: plan } : {},
    events: {}
  };
  topics.forEach((t) => (st.topics[t.id] = t));
  sessions.forEach((s, i) => (st.sessions[`s${i}`] = { id: `s${i}`, startTs: 0, ...s }));
  return st;
}

test('effectiveDays skips rest day and halves heavy days', () => {
  const st = makeState({ settings: { weeklyRestDay: 0 }, days: { '2026-10-20': { dayType: 'heavy' }, '2026-10-21': { dayType: 'off' } } });
  // 18 Oct (Sun, rest) .. 24 Oct (Sat): Sun 0, Mon 1, Tue .5, Wed 0, Thu 1, Fri 1, Sat 1 = 4.5
  assert.equal(E.effectiveDays(st, '2026-10-18', '2026-10-24'), 4.5);
});

test('topicRemaining: todo/doing/done/revised/skipped', () => {
  assert.equal(E.topicRemaining(topic('a', 'X', 100)), 100 + 30);
  assert.equal(E.topicRemaining(topic('a', 'X', 100, { status: 'doing', spentMin: 40 })), 60 + 30);
  assert.equal(E.topicRemaining(topic('a', 'X', 100, { status: 'done', spentMin: 100, firstPassMin: 100 })), 30);
  assert.equal(E.topicRemaining(topic('a', 'X', 100, { status: 'done', spentMin: 120, firstPassMin: 100 })), 10);
  assert.equal(E.topicRemaining(topic('a', 'X', 100, { status: 'revised' })), 0);
  assert.equal(E.topicRemaining(topic('a', 'X', 100, { skip: true })), 0);
});

test('estimate multiplier learns that you are slower than your estimates', () => {
  const st = makeState({
    topics: [
      topic('a', 'FAR', 100, { status: 'done', firstPassMin: 150, spentMin: 150 }),
      topic('b', 'FAR', 100, { status: 'done', firstPassMin: 150, spentMin: 150 }),
      topic('c', 'FAR', 100)
    ]
  });
  const m = E.subjectMultipliers(st);
  assert.equal(m.bySubject.FAR, 1.5);
  // remaining for the untouched topic uses the 1.5x multiplier: 150 + 45
  const rem = E.remainingEffort(st);
  assert.equal(rem.items.find((i) => i.topic.id === 'c').rem, 150 + 45);
});

test('GPS: a missed day nudges the route, it does not explode it', () => {
  const topics = [topic('a', 'X', 3000)]; // 3000 + 900 revision = 3900
  const st = makeState({ topics, settings: { baselineWeekdayMin: 120 } });
  const p0 = E.computePlan(st, TODAY);
  assert.equal(p0.effDays, 61);
  const pace0 = p0.unitPace;
  // tomorrow nothing was studied today -> next day's pace only creeps up
  const p1 = E.computePlan(st, addDays(TODAY, 1));
  assert.ok(p1.unitPace > pace0);
  assert.ok(p1.unitPace < pace0 * 1.03, 'one missed day should move pace by under 3%');
});

test('feasibility cap: impossible pace falls back to a balanced target', () => {
  const st = makeState({ examDate: addDays(TODAY, 10), topics: [topic('a', 'X', 6000)], settings: { baselineWeekdayMin: 90 } });
  const p = E.computePlan(st, TODAY);
  assert.equal(p.status, 'needs_route');
  assert.ok(p.needsRoute);
  assert.equal(p.targetToday, Math.round((90 * E.BALANCED_FACTOR) / 5) * 5);
  assert.ok(p.unitPace > 90 * E.FEASIBILITY_LIMIT);
});

test('modeTarget: green / amber / red', () => {
  const st = makeState({ topics: [topic('a', 'X', 3000)], settings: { baselineWeekdayMin: 120 } });
  const p = E.computePlan(st, TODAY);
  const s = st.meta.settings;
  assert.equal(E.modeTarget(p, s, 'red'), 30);
  assert.equal(E.modeTarget(p, s, 'green'), p.targetToday);
  assert.ok(E.modeTarget(p, s, 'amber') < p.targetToday);
  assert.ok(E.modeTarget(p, s, 'amber') >= 20);
});

test('capacity uses the median of demonstrated days, else baseline', () => {
  const none = makeState({ topics: [topic('a', 'X', 100)] });
  assert.deepEqual(E.capacity(none, TODAY), { value: 90, source: 'baseline', n: 0 });
  const sessions = [30, 60, 90, 120, 45].map((m, i) => ({ date: addDays(TODAY, -(i + 1)), minutes: m }));
  const st = makeState({ topics: [topic('a', 'X', 100)], sessions });
  const c = E.capacity(st, TODAY);
  assert.equal(c.source, 'demonstrated');
  assert.equal(c.value, 60);
});

test('rolloverStreak: never-miss-twice, shields, rest days freeze, reset keeps best', () => {
  const base = { current: 0, best: 0, missRun: 0, shields: 1, maintenanceDays: 0, totalDays: 0 };
  const d = (n, minutes, weight = 1, maintenance = false) => ({ date: `d${n}`, minutes, weight, maintenance });
  // 4 good days, 1 miss (grace), 1 good => streak 5 and a shield earned
  let r = E.rolloverStreak(base, [d(1, 30), d(2, 30), d(3, 30), d(4, 30), d(5, 0), d(6, 20)], { minStreakMin: 15 });
  assert.equal(r.streak.current, 5);
  assert.equal(r.streak.shields, 2);
  assert.ok(r.events.some((e) => e.type === 'grace_day'));
  assert.ok(r.events.some((e) => e.type === 'shield_earned'));
  // two misses in a row: grace then shield (streak intact)
  r = E.rolloverStreak({ ...base, current: 3, best: 3 }, [d(1, 0), d(2, 0)], { minStreakMin: 15 });
  assert.equal(r.streak.current, 3);
  assert.equal(r.streak.shields, 0);
  // three misses: grace, shield, reset (best stays)
  r = E.rolloverStreak({ ...base, current: 3, best: 3 }, [d(1, 0), d(2, 0), d(3, 0)], { minStreakMin: 15 });
  assert.equal(r.streak.current, 0);
  assert.equal(r.streak.best, 3);
  // rest day with no study freezes everything
  r = E.rolloverStreak({ ...base, current: 4, best: 4 }, [d(1, 0, 0)], { minStreakMin: 15 });
  assert.equal(r.streak.current, 4);
  assert.equal(r.streak.missRun, 0);
  // maintenance minutes count
  r = E.rolloverStreak(base, [d(1, 15, 1, true)], { minStreakMin: 15 });
  assert.equal(r.streak.current, 1);
  assert.equal(r.streak.maintenanceDays, 1);
});

test('routeOptions: triage parks low value topics and makes the pace realistic', () => {
  const topics = [
    topic('big-low', 'X', 1200, { weightage: 2, confidence: 5 }),
    topic('mid', 'X', 1200, { weightage: 8, confidence: 2 }),
    topic('small-high', 'X', 600, { weightage: 9, confidence: 1 })
  ];
  const st = makeState({ examDate: addDays(TODAY, 20), topics, settings: { baselineWeekdayMin: 120 } });
  const plan = E.computePlan(st, TODAY);
  assert.ok(plan.needsRoute);
  const opts = E.routeOptions(st, TODAY);
  assert.deepEqual(opts.map((o) => o.id), ['balanced', 'light', 'triage', 'restructure']);
  const tri = opts.find((o) => o.id === 'triage');
  assert.ok(tri.skipIds.includes('big-low'));
  assert.ok(!tri.skipIds.includes('small-high'));
  assert.ok(tri.marksKeptPct < 100);
  assert.ok(tri.dailyMin < plan.unitPace);
});

test('pickNextMicro: finish started topics; empty battery prefers light revision', () => {
  const topics = [topic('new', 'X', 100, { weightage: 9 }), topic('wip', 'X', 100, { status: 'doing', spentMin: 20 }), topic('old', 'X', 100, { status: 'done', firstPassMin: 90, spentMin: 90 })];
  const st = makeState({ topics });
  assert.equal(E.pickNextMicro(st, TODAY, {}, 'green').topicId, 'wip');
  const red = E.pickNextMicro(st, TODAY, {}, 'red');
  assert.equal(red.topicId, 'old');
  assert.equal(red.estMin, 10); // red defaults to the small tier
  // shrink walks down the tiers, swap excludes the topic
  assert.equal(E.pickNextMicro(st, TODAY, { tierIdx: 0 }, 'green').estMin, 5);
  assert.notEqual(E.pickNextMicro(st, TODAY, { exclude: ['wip'] }, 'green').topicId, 'wip');
  assert.match(E.pickNextMicro(st, TODAY, { tierIdx: 1 }, 'green').text, /Solve 1 question/);
});

test('paceSeries: ideal, actual and forecast are produced and forecast stops at scope', () => {
  const plan = { id: 'p1', createdAt: 1, reason: 'initial', baselineStart: addDays(TODAY, -4), baselineEnd: addDays(TODAY, 56), baselineTotal: 3900 };
  const sessions = [-3, -2, -1, 0].map((o) => ({ date: addDays(TODAY, o), minutes: 60 }));
  const st = makeState({ topics: [topic('a', 'X', 3000, { status: 'doing', spentMin: 240 })], sessions, plan });
  const sr = E.paceSeries(st, TODAY);
  assert.equal(sr.ideal.length, 2);
  assert.equal(sr.actual.length, 5);
  assert.equal(sr.actual.at(-1).y, 240);
  const last = sr.forecast.at(-1);
  assert.ok(last.y <= sr.scope + 1e-9);
  assert.ok(sr.forecast.length > 2);
  const p = E.computePlan(st, TODAY);
  assert.ok(Number.isFinite(p.gapDays));
});

test('computePlan with no exam date returns setup status safely', () => {
  const st = makeState({ examDate: '', topics: [topic('a', 'X', 100)] });
  const p = E.computePlan(st, TODAY);
  assert.equal(p.status, 'setup');
  assert.equal(p.targetToday, 0);
});

test('subjectProgress and weeklyStats shape', () => {
  const st = makeState({
    topics: [topic('a', 'FAR', 100, { status: 'done', firstPassMin: 100, spentMin: 100 }), topic('b', 'FAR', 100), topic('c', 'Audit', 50)],
    sessions: [{ date: TODAY, minutes: 40, focus: 4, startTs: new Date(`${TODAY}T20:00:00`).getTime() }]
  });
  const sp = E.subjectProgress(st);
  assert.equal(sp.find((x) => x.subject === 'FAR').pct, 50);
  const w = E.weeklyStats(st, TODAY);
  assert.equal(w.days.length, 7);
  assert.equal(w.total, 40);
  assert.equal(w.avgFocus, 4);
  assert.equal(w.slots.evening.min, 40);
  assert.ok(Array.isArray(w.risk));
});

test('difficulty guide pads estimates until your own speed is measured', () => {
  const st = makeState({ topics: [topic('e', 'X', 100, { difficulty: 1 }), topic('h', 'X', 100, { difficulty: 5 })] });
  const rem = E.remainingEffort(st);
  assert.equal(rem.items.find((i) => i.topic.id === 'e').rem, 100 * 1.0 * 1.3);
  assert.equal(rem.items.find((i) => i.topic.id === 'h').rem, 100 * 1.5 * 1.3);
});

test('courseOutlook: total hours, range, toughness, verdict and plan drift', () => {
  const st = makeState({
    topics: [topic('a', 'FAR', 300, { difficulty: 5 }), topic('b', 'FAR', 300, { difficulty: 4 }), topic('c', 'Law', 120, { difficulty: 2 })]
  });
  const o = E.courseOutlook(st, TODAY);
  assert.equal(o.topics, 3);
  assert.equal(o.basis, 'guide');
  assert.ok(o.lowMin < o.totalMin && o.totalMin < o.highMin);
  assert.equal(o.subjects[0].subject, 'FAR');
  assert.equal(o.subjects[0].toughness, 'Very tough');
  assert.equal(o.subjects[1].toughness, 'Light');
  assert.equal(o.hardest[0].name, 'a');
  assert.ok(['comfortable', 'doable', 'stretch', 'unrealistic'].includes(o.verdict));
  // an ideal line drawn for a much bigger syllabus is flagged
  const stale = makeState({ topics: [topic('a', 'FAR', 60)], plan: { id: 'p', baselineStart: TODAY, baselineEnd: addDays(TODAY, 59), baselineTotal: 5000 } });
  const o2 = E.courseOutlook(stale, TODAY);
  assert.ok(o2.drift && o2.drift.pct < -25);
  // learned speed replaces the guide and narrows the range
  const learned = makeState({
    topics: [
      topic('a', 'FAR', 100, { status: 'done', firstPassMin: 150, spentMin: 150 }),
      topic('b', 'FAR', 100, { status: 'done', firstPassMin: 150, spentMin: 150 }),
      topic('c', 'FAR', 100, { difficulty: 5 })
    ]
  });
  const o3 = E.courseOutlook(learned, TODAY);
  assert.equal(o3.basis, 'learned');
  assert.equal(o3.multiplier, 1.5);
});
