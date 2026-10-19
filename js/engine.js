// The brain: pure functions only (no DOM, no storage). Everything here is unit-tested.
//
// Effort is measured in MINUTES. A topic's remaining effort =
//   first-pass minutes still needed (estimate × your personal multiplier)  +  one revision pass.
// The "GPS" divides remaining effort by the weighted study days left and re-does it every day,
// so a missed day just nudges the route instead of piling up as "debt".

import { addDays, diffDays, weekday, median, clamp, round5, dstr } from './utils.js';

export const WEIGHTS = { normal: 1, heavy: 0.5, off: 0 };
export const REVISION_FACTOR = 0.3; // revision pass ≈ 30% of first-pass time
export const FEASIBILITY_LIMIT = 1.4; // required pace / demonstrated capacity
export const BALANCED_FACTOR = 1.15;
// First estimates almost always run short (planning fallacy), and harder topics run shortest.
// Until the app has seen you finish topics, each estimate is padded by its difficulty (1-5).
// After 2+ finished topics the app switches to YOUR measured speed. Tune these numbers if you like.
export const DIFFICULTY_PRIOR = { 1: 1.0, 2: 1.1, 3: 1.2, 4: 1.35, 5: 1.5 };
export const priorMult = (difficulty) => DIFFICULTY_PRIOR[clamp(Math.round(Number(difficulty) || 3), 1, 5)];
export const TIERS = [
  { id: 'tiny', min: 5 },
  { id: 'small', min: 10 },
  { id: 'normal', min: 20 }
];

const live = (o) => Object.values(o || {}).filter((r) => !r.deleted);
export const liveTopics = (st) => live(st.topics);
export const liveSessions = (st) => live(st.sessions);

/* ------------------------------------------------------------------ time & effort */

export function minutesMap(st) {
  const m = {};
  for (const s of liveSessions(st)) m[s.date] = (m[s.date] || 0) + (Number(s.minutes) || 0);
  return m;
}
export const minutesOn = (st, date) => minutesMap(st)[date] || 0;
export const studyCapital = (st) => liveSessions(st).reduce((a, s) => a + (Number(s.minutes) || 0), 0);

export function cumMinutes(mm, from, to) {
  let t = 0;
  for (let d = from; diffDays(d, to) >= 0; d = addDays(d, 1)) t += mm[d] || 0;
  return t;
}

export function dayTypeOf(st, date) {
  return st.days?.[date]?.dayType || 'normal';
}

/** 1 = normal day, 0.5 = heavy office day, 0 = rest/off day. */
export function dayWeight(st, date) {
  const rd = Number(st.meta.settings.weeklyRestDay);
  if (Number.isFinite(rd) && rd >= 0 && weekday(date) === rd) return 0;
  return WEIGHTS[dayTypeOf(st, date)] ?? 1;
}

/** Weighted number of study days in [from, to] inclusive. */
export function effectiveDays(st, from, to) {
  let s = 0;
  for (let d = from; diffDays(d, to) >= 0; d = addDays(d, 1)) s += dayWeight(st, d);
  return s;
}

/** How long YOU really take vs. your estimate — fixes the planning fallacy. */
export function subjectMultipliers(st) {
  const all = liveTopics(st);
  const done = all.filter((t) => (t.status === 'done' || t.status === 'revised') && t.firstPassMin > 0 && t.estMin > 0);
  const ratios = (arr) => arr.map((t) => t.firstPassMin / t.estMin);
  const globalLearned = done.length >= 2;
  const global = globalLearned ? clamp(median(ratios(done)), 0.6, 2.5) : 1;
  const bySubject = {};
  const learned = {};
  for (const subj of new Set(all.map((t) => t.subject))) {
    const ts = done.filter((t) => t.subject === subj);
    bySubject[subj] = ts.length >= 2 ? clamp(median(ratios(ts)), 0.6, 2.5) : global;
    learned[subj] = ts.length >= 2 || globalLearned;
  }
  return { global, bySubject, learned, nDone: done.length };
}

/** The multiplier for one topic: your measured speed if known, otherwise the difficulty guide. */
export const topicMult = (mult, t) => (mult.learned?.[t.subject] ? mult.bySubject[t.subject] : priorMult(t.difficulty));

export function topicRemaining(t, mult = 1) {
  if (t.skip) return 0;
  if (t.status === 'revised') return 0;
  const est = (t.estMin || 0) * mult;
  const rev = est * REVISION_FACTOR;
  if (t.status === 'done') {
    const revSpent = Math.max(0, (t.spentMin || 0) - (t.firstPassMin || 0));
    return Math.max(0, rev - revSpent);
  }
  const first = Math.max(est - (t.spentMin || 0), Math.min(est, (t.estMin || 0) * 0.15));
  return first + rev;
}

export function remainingEffort(st) {
  const mult = subjectMultipliers(st);
  const items = [];
  const bySubject = {};
  let total = 0;
  for (const t of liveTopics(st)) {
    const r = topicRemaining(t, topicMult(mult, t));
    items.push({ topic: t, rem: r });
    bySubject[t.subject] = (bySubject[t.subject] || 0) + r;
    total += r;
  }
  return { total, items, bySubject };
}

/** Demonstrated capacity: median of positive days in the last 14 (since the current plan began). */
export function capacity(st, today, mm = minutesMap(st)) {
  const bp = st.plans?.[st.meta.activePlanId];
  const floor = bp ? bp.baselineStart : addDays(today, -14);
  const vals = [];
  for (let i = 1; i <= 14; i++) {
    const d = addDays(today, -i);
    if (d < floor) break;
    if ((mm[d] || 0) > 0) vals.push(mm[d]);
  }
  const base = st.meta.settings.baselineWeekdayMin;
  if (vals.length < 3) return { value: base, source: 'baseline', n: vals.length };
  return { value: median(vals), source: 'demonstrated', n: vals.length };
}

/** Exponentially-weighted daily pace (per normal-weight day), looking back ≤ 21 days. */
export function velocity(st, today, mm = minutesMap(st), since = null) {
  const lo = addDays(today, -21);
  const start = since && since > lo ? since : lo;
  let ema = null;
  let n = 0;
  for (let d = start; diffDays(d, today) > 0; d = addDays(d, 1)) {
    const w = dayWeight(st, d);
    if (w <= 0) continue;
    const m = (mm[d] || 0) / w;
    ema = ema === null ? m : 0.2 * m + 0.8 * ema;
    n++;
  }
  const base = st.meta.settings.baselineWeekdayMin;
  if (n < 3 || ema === null) return { value: base * 0.8, n, provisional: true };
  return { value: ema, n, provisional: false };
}

export function forecastDate(st, today, remaining, vel, factor = 1, maxDays = 730) {
  if (remaining <= 0) return today;
  if (vel * factor <= 0.5) return null;
  let cum = 0;
  let d = today;
  for (let i = 0; i < maxDays; i++, d = addDays(d, 1)) {
    cum += vel * factor * dayWeight(st, d);
    if (cum >= remaining) return d;
  }
  return null;
}

/* ------------------------------------------------------------------ exam dates (one per subject) */

/** The exam date that applies to a subject: its own date, otherwise the default one. */
export const examDateFor = (settings, subject) => (settings.subjectExams && settings.subjectExams[subject]) || settings.examDate || '';

export const subjectsOf = (st) => [...new Set(liveTopics(st).map((t) => t.subject))].sort();

export const hasAnyExam = (st) => {
  const s = st.meta.settings;
  return !!s.examDate || subjectsOf(st).some((x) => s.subjectExams && s.subjectExams[x]);
};

/**
 * Subjects that share an exam date form a group. Groups are worked earliest-deadline-first, so the pace you
 * need is the worst of: (everything due by this exam) / (study days before this exam). With one exam date
 * this is exactly the old single-deadline maths.
 */
export function examGroups(st, today, remBySubject, todayBySubject = {}, todayMin = 0) {
  const s = st.meta.settings;
  const buffer = Number(s.revisionBufferDays) || 0;
  const by = {};
  for (const subj of subjectsOf(st)) {
    const exam = examDateFor(s, subj);
    if (!exam) continue;
    const g = (by[exam] ||= { examDate: exam, lastDay: addDays(exam, -buffer), subjects: [], rem: 0, startRem: 0 });
    g.subjects.push(subj);
    g.rem += remBySubject[subj] || 0;
    g.startRem += (remBySubject[subj] || 0) + (todayBySubject[subj] || 0);
  }
  let groups = Object.values(by).sort((a, b) => (a.examDate < b.examDate ? -1 : a.examDate > b.examDate ? 1 : 0));
  const upcoming = groups.filter((g) => g.examDate >= today);
  if (upcoming.length) groups = upcoming; // an exam that has already happened no longer constrains the others
  const attributed = Object.values(todayBySubject).reduce((a, b) => a + b, 0);
  const extra = Math.max(0, todayMin - attributed); // minutes logged today against nothing on your list
  let cumRem = 0;
  let cumStart = 0;
  let cumSubjects = [];
  groups.forEach((g, i) => {
    cumRem += g.rem;
    cumStart += g.startRem + (i === groups.length - 1 ? extra : 0);
    cumSubjects = [...cumSubjects, ...g.subjects];
    g.cumRem = cumRem;
    g.cumStart = cumStart;
    g.cumSubjects = cumSubjects;
    g.days = diffDays(today, g.lastDay) >= 0 ? effectiveDays(st, today, g.lastDay) : 0;
    g.pace = g.days > 0 ? g.cumStart / g.days : g.cumStart;
  });
  return groups;
}

/** With several exam dates, topics from the nearest exam get a gentle nudge in "what next". */
export function subjectUrgency(st, today = dstr()) {
  const rem = remainingEffort(st);
  const groups = examGroups(st, today, rem.bySubject).filter((g) => g.rem > 0);
  const out = {};
  if (groups.length < 2) return out;
  groups.forEach((g, i) => g.subjects.forEach((x) => (out[x] = 1 + 0.6 / (i + 1))));
  return out;
}

/* ------------------------------------------------------------------ the GPS */

export function computePlan(st, today = dstr()) {
  const s = st.meta.settings;
  const mm = minutesMap(st);
  const rem = remainingEffort(st);
  const mult = subjectMultipliers(st);
  const cap = capacity(st, today, mm);
  const todayMin = mm[today] || 0;
  const out = {
    today,
    todayMin,
    remaining: rem.total,
    startRem: rem.total + todayMin,
    rem,
    mult,
    capacity: cap,
    status: 'setup',
    examDate: s.examDate || '',
    lastDay: null,
    daysToExam: null,
    effDays: 0,
    unitPace: 0,
    unitTarget: 0,
    targetToday: 0,
    feasibility: 0,
    needsRoute: false,
    velocity: { value: 0, n: 0, provisional: true },
    etaDate: null,
    gapDays: 0,
    idealY: 0,
    actualY: 0,
    idealToday: 0,
    actualToday: 0,
    idealRate: 0,
    bp: null,
    groups: [],
    bind: null,
    worst: null,
    multi: false,
    unscheduled: []
  };
  const todayBySubject = {};
  for (const x of liveSessions(st)) {
    if (x.date === today && x.topicId && st.topics[x.topicId]) {
      const sj = st.topics[x.topicId].subject;
      todayBySubject[sj] = (todayBySubject[sj] || 0) + (x.minutes || 0);
    }
  }
  const groups = examGroups(st, today, rem.bySubject, todayBySubject, todayMin);
  if (!groups.length) return out;

  const bind = groups.reduce((a, g) => (g.pace > a.pace ? g : a), groups[0]);
  const lastDay = groups[groups.length - 1].lastDay;
  const effDays = bind.days;
  const startRem = out.startRem;
  const unitPace = bind.pace;
  const feas = cap.value > 0 ? unitPace / cap.value : Infinity;
  const route = s.route || { mode: 'auto', dailyMin: 0 };
  const fixed = (route.mode === 'balanced' || route.mode === 'light') && route.dailyMin > 0;
  const needsRoute = route.mode === 'auto' && feas > FEASIBILITY_LIMIT && rem.total > 0;
  const unitTarget = fixed ? route.dailyMin : needsRoute ? cap.value * BALANCED_FACTOR : unitPace;
  const w = dayWeight(st, today);
  let targetToday = rem.total > 0 && w > 0 ? Math.max(15, round5(unitTarget * w)) : 0;
  targetToday = Math.min(targetToday, 360);

  const bp = st.plans?.[st.meta.activePlanId] || null;
  const vel = velocity(st, today, mm, bp ? bp.baselineStart : null);
  for (const g of groups) g.eta = forecastDate(st, today, g.cumRem, vel.value);
  const marginOf = (g) => (g.eta ? diffDays(g.eta, g.examDate) : -Infinity);
  const pool = groups.filter((g) => g.rem > 0);
  const cand = pool.length ? pool : [groups[groups.length - 1]];
  const worst = cand.reduce((a, g) => (marginOf(g) < marginOf(a) ? g : a), cand[0]);
  const eta = worst.eta;

  let gapDays = 0;
  let idealY = 0;
  let actualY = 0;
  let idealToday = 0;
  let actualToday = 0;
  let idealRate = 0;
  if (bp && bp.baselineTotal > 0) {
    const totalW = effectiveDays(st, bp.baselineStart, bp.baselineEnd) || 1;
    idealRate = bp.baselineTotal / totalW;
    const yest = addDays(today, -1);
    idealY = diffDays(bp.baselineStart, yest) >= 0 ? Math.min(bp.baselineTotal, idealRate * effectiveDays(st, bp.baselineStart, yest)) : 0;
    actualY = diffDays(bp.baselineStart, yest) >= 0 ? cumMinutes(mm, bp.baselineStart, yest) : 0;
    idealToday = Math.min(bp.baselineTotal, idealRate * effectiveDays(st, bp.baselineStart, today));
    actualToday = cumMinutes(mm, bp.baselineStart, today);
    gapDays = idealRate > 0 ? (idealY - actualY) / idealRate : 0;
  }

  let status;
  if (rem.total <= 0) status = 'done';
  else if (effDays <= 0) status = 'window_closed';
  else if (needsRoute) status = 'needs_route';
  else if (gapDays <= -1) status = 'ahead';
  else if (gapDays < 1.5) status = 'on_track';
  else status = 'behind';
  // with several exams, one close exam can be at risk even while the overall line looks fine
  if (groups.length > 1 && (status === 'on_track' || status === 'ahead')) {
    if (groups.some((g) => g.rem > 0 && (g.eta === null || diffDays(g.lastDay, g.eta) >= 1))) status = 'behind';
  }
  const scheduled = new Set(groups.flatMap((g) => g.subjects));
  const unscheduled = subjectsOf(st).filter((x) => !scheduled.has(x) && (rem.bySubject[x] || 0) > 0);

  return {
    ...out,
    status,
    lastDay,
    examDate: worst.examDate,
    groups: groups.map((g) => ({ examDate: g.examDate, lastDay: g.lastDay, subjects: g.subjects, rem: g.rem, cumRem: g.cumRem, days: g.days, pace: g.pace, eta: g.eta })),
    bind: { subjects: bind.cumSubjects, rem: bind.cumStart, days: bind.days, lastDay: bind.lastDay, examDate: bind.examDate },
    worst: { subjects: worst.subjects, examDate: worst.examDate, eta: worst.eta, margin: worst.eta ? diffDays(worst.eta, worst.examDate) : null },
    multi: groups.length > 1,
    unscheduled,
    daysToExam: diffDays(today, groups[0].examDate),
    effDays,
    unitPace,
    unitTarget,
    targetToday,
    feasibility: feas,
    needsRoute,
    velocity: vel,
    etaDate: eta,
    gapDays: Math.round(gapDays * 10) / 10,
    idealY,
    actualY,
    idealToday,
    actualToday,
    idealRate,
    bp
  };
}

/* ------------------------------------------------------------------ course outlook (before you start, and while you go) */

export const toughnessLabel = (d) => (d < 2.2 ? 'Light' : d < 3 ? 'Moderate' : d < 3.8 ? 'Tough' : 'Very tough');

/**
 * "How many hours is this whole course really, and how hard is it?"
 * Hours = what you already put in + what is still to come, padded realistically.
 * The range is wide until the app has measured your own speed, then it narrows.
 */
export function courseOutlook(st, today = dstr()) {
  const plan = computePlan(st, today);
  const mult = subjectMultipliers(st);
  const topics = liveTopics(st).filter((t) => !t.skip);
  const [lo, hi] = mult.nDone >= 6 ? [0.9, 1.2] : mult.nDone >= 2 ? [0.85, 1.3] : [0.8, 1.45];
  const subj = {};
  let spent = 0;
  let remaining = 0;
  let dSum = 0;
  let dW = 0;
  for (const t of topics) {
    const m = topicMult(mult, t);
    const r = topicRemaining(t, m);
    const sp = t.spentMin || 0;
    const o = (subj[t.subject] ||= { subject: t.subject, topics: 0, spent: 0, remaining: 0, dSum: 0, dW: 0, marks: 0, learned: !!mult.learned[t.subject] });
    o.topics += 1;
    o.spent += sp;
    o.remaining += r;
    const w = Math.max(1, (t.estMin || 0) * m);
    o.dSum += (Number(t.difficulty) || 3) * w;
    o.dW += w;
    o.marks += Number(t.weightage) || 0;
    spent += sp;
    remaining += r;
    dSum += (Number(t.difficulty) || 3) * w;
    dW += w;
  }
  const total = spent + remaining;
  const subjects = Object.values(subj)
    .map((o) => {
      const d = o.dW ? o.dSum / o.dW : 3;
      const tot = o.spent + o.remaining;
      const exam = examDateFor(st.meta.settings, o.subject);
      return { subject: o.subject, exam, daysToExam: exam ? diffDays(today, exam) : null, topics: o.topics, spentMin: Math.round(o.spent), remainingMin: Math.round(o.remaining), totalMin: Math.round(tot), share: total ? Math.round((tot / total) * 100) : 0, difficulty: Math.round(d * 10) / 10, toughness: toughnessLabel(d), learned: o.learned };
    })
    .sort((a, b) => b.totalMin - a.totalMin);
  const avgD = dW ? dSum / dW : 3;
  const hardest = topics
    .filter((t) => (Number(t.difficulty) || 3) >= 4 && t.status !== 'revised')
    .map((t) => ({ name: t.name, subject: t.subject, min: Math.round(topicRemaining(t, topicMult(mult, t))), difficulty: Number(t.difficulty) || 3 }))
    .sort((a, b) => b.min - a.min)
    .slice(0, 3);

  // Can it be done at the pace you really keep?
  const cap = plan.capacity.value;
  const hasExam = plan.status !== 'setup' && plan.effDays > 0;
  const f = plan.feasibility;
  let verdict = null;
  if (hasExam && remaining > 0) verdict = f <= 0.9 ? 'comfortable' : f <= BALANCED_FACTOR ? 'doable' : f <= FEASIBILITY_LIMIT ? 'stretch' : 'unrealistic';

  // Has the syllabus changed since the ideal line was drawn?
  const bp = st.plans?.[st.meta.activePlanId];
  let drift = null;
  if (bp && bp.baselineTotal > 0) {
    const scopeNow = cumMinutes(minutesMap(st), bp.baselineStart, today) + remaining;
    const pct = scopeNow / bp.baselineTotal - 1;
    if (Math.abs(pct) >= 0.25) drift = { baseline: bp.baselineTotal, now: Math.round(scopeNow), pct: Math.round(pct * 100) };
  }

  return {
    topics: topics.length,
    spentMin: Math.round(spent),
    remainingMin: Math.round(remaining),
    totalMin: Math.round(total),
    lowMin: Math.round(spent + remaining * lo),
    highMin: Math.round(spent + remaining * hi),
    toughness: toughnessLabel(avgD),
    difficulty: Math.round(avgD * 10) / 10,
    subjects,
    hardest,
    basis: mult.nDone >= 2 ? 'learned' : 'guide',
    nDone: mult.nDone,
    multiplier: mult.global,
    verdict,
    capacityMin: cap,
    capacitySource: plan.capacity.source,
    needPerDay: Math.round(plan.unitPace),
    feasibility: f,
    daysLeft: plan.bind ? plan.bind.days : plan.effDays,
    exams: plan.groups,
    multi: plan.multi,
    unscheduled: plan.unscheduled,
    etaAtCapacity: remaining > 0 && cap > 0 ? forecastDate(st, today, remaining, cap) : null,
    examDate: plan.examDate,
    drift
  };
}

/** Tonight's target for the chosen battery level. green = full, amber = half, red = empty. */
export function modeTarget(plan, settings, energy) {
  if (energy === 'red') return settings.maintenanceMin;
  const base = plan.targetToday || 0;
  if (energy === 'amber') return base > 0 ? Math.max(20, round5(base * 0.6)) : 20;
  return base;
}

/* ------------------------------------------------------------------ pace chart data */

export function paceSeries(st, today = dstr()) {
  const s = st.meta.settings;
  const bp = st.plans?.[st.meta.activePlanId];
  const mm = minutesMap(st);
  const plan = computePlan(st, today);
  if (!bp || !plan.groups.length) return null;
  const lastExam = plan.groups[plan.groups.length - 1].examDate;
  const start = bp.baselineStart;
  const ideal = [
    { d: start, y: 0 },
    { d: bp.baselineEnd, y: bp.baselineTotal }
  ];
  const actual = [];
  let cum = 0;
  for (let d = start; diffDays(d, today) >= 0; d = addDays(d, 1)) {
    cum += mm[d] || 0;
    actual.push({ d, y: cum });
  }
  const scope = cum + plan.remaining;
  const mk = (factor) => {
    const pts = [{ d: today, y: cum }];
    let y = cum;
    for (let i = 1; i <= 400; i++) {
      const d = addDays(today, i);
      y += plan.velocity.value * factor * dayWeight(st, d);
      if (y >= scope) {
        pts.push({ d, y: scope });
        break;
      }
      pts.push({ d, y });
      if (diffDays(lastExam, d) > 14) break;
    }
    return pts;
  };
  return { start, today, exam: lastExam, exams: plan.groups.map((g) => ({ d: g.examDate, subjects: g.subjects })), endIdeal: bp.baselineEnd, total: bp.baselineTotal, scope, ideal, actual, forecast: mk(1), lo: mk(0.7), hi: mk(1.3) };
}

/* ------------------------------------------------------------------ route options */

export function routeOptions(st, today = dstr()) {
  const plan = computePlan(st, today);
  const cap = plan.capacity.value;
  const bind = plan.bind || { subjects: [], rem: plan.startRem, days: plan.effDays };
  const fixedOpt = (id, label, dailyMin, desc) => {
    const eta = forecastDate(st, today, plan.remaining, dailyMin);
    const covered = bind.days > 0 ? Math.min(1, (dailyMin * bind.days) / Math.max(1, bind.rem)) : 0;
    let late = null;
    for (const g of plan.groups) {
      const ge = forecastDate(st, today, g.cumRem, dailyMin);
      if (!ge) { late = null; break; }
      late = Math.max(late ?? 0, Math.max(0, diffDays(g.examDate, ge)));
    }
    return {
      id,
      label,
      desc,
      dailyMin,
      eta,
      coveredPct: Math.round(covered * 100),
      lateByDays: eta && plan.examDate ? late : null
    };
  };
  const balanced = fixedOpt('balanced', 'Balanced', round5(cap * BALANCED_FACTOR), 'A modest step up from what you already manage.');
  const light = fixedOpt('light', 'Light', round5(cap), 'Exactly your demonstrated pace. Finish date moves later.');

  // Triage: drop the lowest "marks per minute" topics until the pace is realistic.
  const inScope = new Set(bind.subjects);
  const open = liveTopics(st).filter((t) => !t.skip && (t.status === 'todo' || t.status === 'doing') && (!inScope.size || inScope.has(t.subject)));
  const items = open
    .map((t) => {
      const r = topicRemaining(t, topicMult(plan.mult, t));
      const value = (t.weightage || 1) * (6 - (t.confidence || 3));
      return { t, r, vpm: value / Math.max(1, r) };
    })
    .sort((a, b) => a.vpm - b.vpm);
  const affordable = cap * BALANCED_FACTOR * Math.max(1, bind.days);
  let total = bind.rem;
  let skipped = 0;
  const skipIds = [];
  const maxSkip = total * 0.4;
  for (const it of items) {
    if (total <= affordable) break;
    if (skipped + it.r > maxSkip) continue;
    skipIds.push(it.t.id);
    skipped += it.r;
    total -= it.r;
  }
  const allOpenW = open.reduce((a, t) => a + (t.weightage || 0), 0) || 1;
  const skippedW = skipIds.reduce((a, id) => a + (st.topics[id].weightage || 0), 0);
  const triage = {
    id: 'triage',
    label: 'Triage',
    desc: 'Park the lowest marks-per-minute topics and keep the rest on time.',
    skipIds,
    skippedMin: Math.round(skipped),
    marksKeptPct: Math.round(((allOpenW - skippedW) / allOpenW) * 100),
    dailyMin: round5(total / Math.max(1, bind.days))
  };
  const restructure = { id: 'restructure', label: 'Restructure', desc: 'Clean slate: archive the old plan and rebuild from your real capacity.' };
  return [balanced, light, triage, restructure];
}

/* ------------------------------------------------------------------ micro-tasks ("One Thing") */

export function daysSinceLastSession(st, today = dstr()) {
  let last = null;
  for (const s of liveSessions(st)) if ((s.minutes || 0) > 0 && (!last || s.date > last)) last = s.date;
  return last ? diffDays(last, today) : null;
}

export function topicPriority(t, today) {
  const since = t.lastTouched ? Math.min(30, diffDays(t.lastTouched, today)) : 14;
  return (t.weightage || 1) * (6 - (t.confidence || 3)) + since * 0.5;
}

export function topicRisk(t, today) {
  const since = t.lastTouched ? Math.min(30, diffDays(t.lastTouched, today)) : 30;
  return (t.weightage || 1) * (6 - (t.confidence || 3)) * (1 + since / 30);
}

export function microFor(t, tierIdx, lowCog = false) {
  const kind = t.status === 'done' ? 'done' : lowCog && t.status === 'todo' ? 'doing' : t.status === 'revised' ? 'done' : t.status;
  const n = t.name;
  const text = {
    todo: [`Open “${n}” and read just the first paragraph`, `Read one page of “${n}”`, `Read the opening section of “${n}” and underline the key terms`],
    doing: [`Re-read your last note on “${n}”`, `Solve 1 question on “${n}”`, `Solve 3 questions on “${n}”`],
    done: [`Do 2 quick MCQs on “${n}”`, `Skim your notes on “${n}”`, `Revise “${n}”: skim your notes, then 5 MCQs`]
  }[kind][tierIdx];
  return {
    topicId: t.id,
    subject: t.subject,
    text,
    estMin: TIERS[tierIdx].min,
    activity: kind === 'done' ? 'revision' : kind === 'todo' ? 'reading' : 'practice',
    tierIdx,
    canShrink: tierIdx > 0
  };
}

/**
 * Pick the single next thing to do.
 * Normal: finish what you started → new topics → revision.  Empty battery: low-effort revision first.
 * pref: { tierIdx, exclude[], hard }
 */
export function pickNextMicro(st, today, pref = {}, energy = '') {
  const tierIdx = clamp(pref.tierIdx ?? (energy === 'red' ? 1 : 2), 0, 2);
  const exclude = new Set(pref.exclude || []);
  const pool = liveTopics(st).filter((t) => !t.skip && t.status !== 'revised' && !exclude.has(t.id));
  if (!pool.length) return null;
  const urg = subjectUrgency(st, today);
  const pr = (t) => topicPriority(t, today) * (urg[t.subject] || 1);
  const rank = (arr) => [...arr].sort((a, b) => pr(b) - pr(a));
  const by = (status) => pool.filter((t) => t.status === status);
  let cand;
  if (pref.hard) {
    const hard = pool.filter((t) => t.status === 'todo' || t.status === 'doing');
    cand = [...(hard.length ? hard : pool)].sort((a, b) => (b.weightage || 1) * (6 - (b.confidence || 3)) - (a.weightage || 1) * (6 - (a.confidence || 3)))[0];
  } else if (energy === 'red') {
    cand = rank(by('done'))[0] || rank(by('doing'))[0] || rank(by('todo'))[0];
  } else {
    cand = rank(by('doing'))[0] || rank(by('todo'))[0] || rank(by('done'))[0];
  }
  return cand ? microFor(cand, tierIdx, energy === 'red') : null;
}

/* ------------------------------------------------------------------ streak (never-miss-twice) */

/**
 * Process finished days in order.
 *  - a day counts if minutes ≥ minStreakMin (maintenance minutes count!)
 *  - rest / off days with no study freeze the streak
 *  - 1st missed day in a row: free grace; 2nd: a shield is used; otherwise the streak resets (best is kept)
 *  - every 5th counted day earns a shield (max 3)
 */
export function rolloverStreak(streak, days, cfg) {
  const s = { ...streak };
  const events = [];
  const minDay = cfg.minStreakMin ?? 15;
  for (const d of days) {
    const counted = d.minutes >= minDay;
    if (!counted && d.weight === 0) continue;
    if (counted) {
      s.current += 1;
      s.totalDays += 1;
      s.missRun = 0;
      if (d.maintenance) s.maintenanceDays += 1;
      if (s.current > s.best) s.best = s.current;
      if (s.current % 5 === 0 && s.shields < 3) {
        s.shields += 1;
        events.push({ type: 'shield_earned', date: d.date });
      }
    } else if (s.missRun === 0) {
      s.missRun = 1;
      events.push({ type: 'grace_day', date: d.date });
    } else if (s.shields > 0) {
      s.shields -= 1;
      events.push({ type: 'shield_used', date: d.date });
    } else {
      if (s.current > 0) events.push({ type: 'streak_reset', date: d.date, was: s.current });
      s.current = 0;
      s.missRun = 0;
    }
  }
  return { streak: s, events };
}

/* ------------------------------------------------------------------ analytics */

export function subjectProgress(st) {
  const mult = subjectMultipliers(st);
  const map = {};
  for (const t of liveTopics(st)) {
    const o = (map[t.subject] ||= { subject: t.subject, topics: 0, done: 0, revised: 0, est: 0, estDone: 0, remaining: 0 });
    o.topics += 1;
    o.est += t.estMin || 0;
    if (t.status === 'done' || t.status === 'revised') {
      o.done += 1;
      o.estDone += t.estMin || 0;
    }
    if (t.status === 'revised') o.revised += 1;
    o.remaining += topicRemaining(t, topicMult(mult, t));
  }
  return Object.values(map).map((o) => ({ ...o, pct: o.est ? Math.round((o.estDone / o.est) * 100) : 0 }));
}

export function weeklyStats(st, today = dstr()) {
  const mm = minutesMap(st);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    days.push({ date: d, min: mm[d] || 0, weight: dayWeight(st, d), energy: st.days?.[d]?.energy || '', maint: !!st.days?.[d]?.maintenance });
  }
  const total = days.reduce((a, d) => a + d.min, 0);
  const sessions = liveSessions(st).filter((s) => s.date >= days[0].date && s.date <= today);
  const focus = sessions.map((s) => Number(s.focus)).filter(Boolean);
  const slots = { morning: { n: 0, min: 0, f: [] }, afternoon: { n: 0, min: 0, f: [] }, evening: { n: 0, min: 0, f: [] }, night: { n: 0, min: 0, f: [] } };
  for (const s of liveSessions(st)) {
    if (!s.startTs) continue;
    const h = new Date(s.startTs).getHours();
    const k = h < 11 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night';
    slots[k].n += 1;
    slots[k].min += s.minutes || 0;
    if (s.focus) slots[k].f.push(Number(s.focus));
  }
  const evs = Object.values(st.events || {}).filter((e) => !e.deleted && e.type === 'start' && e.payload?.latencySec !== undefined);
  const now = Date.now();
  const lat = (from, to) => median(evs.filter((e) => e.ts >= now - to * 86400000 && e.ts < now - from * 86400000).map((e) => e.payload.latencySec));
  const latThis = evs.some((e) => e.ts >= now - 7 * 86400000) ? lat(0, 7) : null;
  const latPrev = evs.some((e) => e.ts >= now - 14 * 86400000 && e.ts < now - 7 * 86400000) ? lat(7, 14) : null;

  let active14 = 0;
  let maint14 = 0;
  for (let i = 1; i <= 14; i++) {
    const d = addDays(today, -i);
    if ((mm[d] || 0) > 0) {
      active14++;
      if (st.days?.[d]?.maintenance) maint14++;
    }
  }
  const redByWeekday = Array.from({ length: 7 }, () => ({ n: 0, red: 0 }));
  for (const [d, row] of Object.entries(st.days || {})) {
    if (!row.energy) continue;
    const w = weekday(d);
    redByWeekday[w].n += 1;
    if (row.energy === 'red') redByWeekday[w].red += 1;
  }
  const risk = liveTopics(st)
    .filter((t) => !t.skip && t.status !== 'revised')
    .map((t) => ({ t, score: topicRisk(t, today) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    days,
    total,
    activeDays: days.filter((d) => d.min > 0).length,
    sessionCount: sessions.length,
    avgFocus: focus.length ? focus.reduce((a, b) => a + b, 0) / focus.length : null,
    slots,
    latThis,
    latPrev,
    maintShare: active14 ? maint14 / active14 : 0,
    redByWeekday,
    risk
  };
}
