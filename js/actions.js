// Everything the user can DO. Views call these; these call the store + engine.

import * as S from './store.js';
import * as E from './engine.js';
import * as M from './mentor.js';
import { SAMPLE_CSV } from './sample.js';
import { dstr, addDays, diffDays, uid, parseCSV, clamp } from './utils.js';

const st = () => S.getState();

/* ------------------------------------------------------------------ day rows */

function dayRow(date) {
  const s = st();
  if (!s.days[date]) {
    s.days[date] = { id: date, date, dayType: 'normal', energy: '', mode: '', sleepHours: '', missReason: '', breadcrumb: '', minutes: 0, maintenance: false };
  }
  return s.days[date];
}

function patchDay(date, patch) {
  const r = dayRow(date);
  Object.assign(r, patch);
  S.put('days', r);
  S.commit();
}

export const currentEnergy = (date = dstr()) => st().days[date]?.energy || '';

export function setEnergy(energy) {
  const date = dstr();
  const minutes = E.minutesOn(st(), date);
  // An empty battery is new information: it overrides an earlier "show me everything" choice,
  // so Tunnel Vision can step in again.
  if (energy === 'red') st().runtime.tunnel = null;
  patchDay(date, { energy, maintenance: energy === 'red' && minutes > 0 });
}
export const setDayType = (date, dayType) => patchDay(date, { dayType });
export const setSleep = (hours) => patchDay(dstr(), { sleepHours: Number(hours) });
export const setMissReason = (reason) => patchDay(dstr(), { missReason: reason });
export const setBreadcrumb = (date, text) => patchDay(date, { breadcrumb: String(text || '').slice(0, 200) });

export function modeForEnergy(energy, tunnel) {
  if (energy === 'red') return 'maintenance';
  if (tunnel) return 'one-thing';
  if (energy === 'amber') return 'reduced';
  return 'full';
}

/* ------------------------------------------------------------------ plan snapshots (GPS audit trail) */

export function snapshotPlan(reason, baseline = false) {
  const s = st();
  const today = dstr();
  const p = E.computePlan(s, today);
  const prev = s.plans[s.meta.activePlanId];
  const fresh = baseline || !prev;
  const row = {
    id: uid('p_'),
    createdAt: Date.now(),
    reason,
    remainingMin: Math.round(p.remaining),
    targetMin: Math.round(p.unitTarget),
    eta: p.etaDate || '',
    examDate: s.meta.settings.examDate,
    effectiveDays: p.effDays,
    baselineStart: fresh ? today : prev.baselineStart,
    baselineEnd: fresh ? p.lastDay || s.meta.settings.examDate : prev.baselineEnd,
    baselineTotal: fresh ? Math.round(p.startRem) : prev.baselineTotal
  };
  S.put('plans', row);
  s.meta.activePlanId = row.id;
  S.touchMeta();
  return row;
}

export const recalcNotice = () => M.recalcNotice(st().plans);

/** Run once per day / app open: close finished days (streak, shields) and refresh the route. */
export function ensureToday() {
  const s = st();
  const today = dstr();
  const set = s.meta.settings;
  let changed = false;

  const from = addDays(s.meta.streak.lastProcessed, 1);
  if (diffDays(from, today) > 0) {
    const mm = E.minutesMap(s);
    const days = [];
    for (let d = from; diffDays(d, today) > 0; d = addDays(d, 1)) {
      days.push({ date: d, minutes: mm[d] || 0, weight: E.dayWeight(s, d), maintenance: !!s.days[d]?.maintenance });
    }
    const r = E.rolloverStreak(s.meta.streak, days, set);
    s.meta.streak = { ...r.streak, lastProcessed: addDays(today, -1) };
    r.events.forEach((e) => S.logEvent(e.type, e));
    S.touchMeta();
    changed = true;
  }

  if (set.examDate && s.meta.lastSnapshotDate !== today && Object.keys(s.topics).length) {
    snapshotPlan(s.meta.activePlanId ? 'recalc' : 'initial');
    s.meta.lastSnapshotDate = today;
    S.touchMeta();
    changed = true;
  }
  if (changed) S.commit();
}

/* ------------------------------------------------------------------ sessions (zero-form start) */

export const elapsedMs = (r, now = Date.now()) => Math.max(0, (r.paused ? r.pauseAt : now) - r.startTs - r.pausedMs);

export function startSession({ topicId = null, mode = 'full', text = '' } = {}) {
  const s = st();
  if (s.runtime.running) return;
  const now = Date.now();
  const today = dstr();
  const lp = s.runtime.landingPad;
  const afterPad = lp && lp.date === today && lp.endTs && lp.endTs <= now;
  const ref = afterPad ? lp.endTs : s.runtime.appOpenTs;
  S.logEvent('start', { latencySec: Math.min(7200, Math.max(0, Math.round((now - ref) / 1000))), from: afterPad ? 'landing' : 'open', mode });
  s.runtime.running = { startTs: now, topicId, mode, text, paused: false, pausedMs: 0, pauseAt: 0, pauses: 0, sent: [] };
  const d = dayRow(today);
  d.mode = mode;
  S.put('days', d);
  S.commit();
}

/** Quick jot while the timer runs. Saved to the device only (no re-render, so typing never loses focus). */
export function setRunningNote(text) {
  const r = st().runtime.running;
  if (!r) return;
  r.note = String(text || '').slice(0, 500);
  S.persist();
}

export function togglePause() {
  const r = st().runtime.running;
  if (!r) return;
  if (r.paused) {
    r.pausedMs += Date.now() - r.pauseAt;
    r.paused = false;
  } else {
    r.paused = true;
    r.pauseAt = Date.now();
    r.pauses += 1;
  }
  S.commit();
}

export function stopSession() {
  const s = st();
  const r = s.runtime.running;
  if (!r) return null;
  const end = Date.now();
  s.runtime.draft = {
    startTs: r.startTs,
    endTs: end,
    minutes: Math.max(1, Math.round(elapsedMs(r, end) / 60000)),
    topicId: r.topicId,
    mode: r.mode,
    pauses: r.pauses,
    text: r.text,
    notes: r.note || '',
    manual: false
  };
  s.runtime.running = null;
  S.commit();
  return s.runtime.draft;
}

export function newManualDraft() {
  const s = st();
  s.runtime.draft = { manual: true, minutes: '', topicId: currentMicro()?.topicId || null, mode: 'manual', pauses: 0 };
  S.commit();
  return s.runtime.draft;
}

export function discardDraft() {
  st().runtime.draft = null;
  S.commit();
}

function applyToTopic(topic, minutes, f, date) {
  topic.spentMin = (topic.spentMin || 0) + minutes;
  topic.lastTouched = date;
  const prev = topic.status;
  let next = f.status || prev;
  if (prev === 'todo' && next === 'todo') next = 'doing';
  if ((next === 'done' || next === 'revised') && prev !== 'done' && prev !== 'revised') topic.firstPassMin = topic.spentMin;
  if (next === 'revised' && prev !== 'revised') topic.revisionCount = (topic.revisionCount || 0) + 1;
  topic.status = next;
  if (f.confidence) topic.confidence = clamp(Number(f.confidence), 1, 5);
  S.put('topics', topic);
}

export function saveSession(f) {
  const s = st();
  const d = s.runtime.draft || {};
  const minutes = Math.max(1, Math.round(Number(f.minutes) || Number(d.minutes) || 1));
  const date = f.date || (d.startTs ? dstr(new Date(d.startTs)) : dstr());
  const startTs = d.startTs || new Date(`${date}T20:00:00`).getTime();
  const endTs = d.endTs || startTs + minutes * 60000;
  const topic = f.topicId ? s.topics[f.topicId] : null;
  const energy = s.days[date]?.energy || '';
  const row = {
    id: uid('s_'),
    date,
    startTs,
    endTs,
    minutes,
    topicId: topic?.id || '',
    subject: topic?.subject || '',
    activity: f.activity || '',
    units: f.units ? Number(f.units) : '',
    focus: f.focus ? Number(f.focus) : '',
    pauses: d.pauses || 0,
    planned: !!(d.topicId && d.topicId === f.topicId),
    logDelaySec: d.manual ? '' : Math.max(0, Math.round((Date.now() - endTs) / 1000)),
    mode: d.mode || 'manual',
    energy,
    notes: String(f.notes ?? d.notes ?? '').trim().slice(0, 500)
  };
  S.put('sessions', row);
  if (topic) applyToTopic(topic, minutes, f, date);
  const day = dayRow(date);
  day.minutes = E.minutesOn(s, date);
  day.maintenance = energy === 'red' && day.minutes > 0;
  if (!day.mode) day.mode = row.mode;
  S.put('days', day);
  s.runtime.draft = null;
  S.commit();
  return { minutes, date, capital: E.studyCapital(s) };
}

/** Add or edit the note on a saved session. */
export function setSessionNote(id, text) {
  const row = st().sessions[id];
  if (!row) return false;
  row.notes = String(text || '').trim().slice(0, 500);
  S.put('sessions', row);
  S.commit();
  return true;
}

export function deleteSession(id) {
  const s = st();
  const row = s.sessions[id];
  if (!row) return;
  S.remove('sessions', id);
  const day = dayRow(row.date);
  day.minutes = E.minutesOn(s, row.date);
  day.maintenance = day.energy === 'red' && day.minutes > 0;
  S.put('days', day);
  S.commit();
}

/* ------------------------------------------------------------------ landing pad */

export function landingPadStart() {
  const s = st();
  const now = Date.now();
  s.runtime.landingPad = { date: dstr(), startTs: now, endTs: now + s.meta.settings.landingPadMin * 60000, state: 'running' };
  S.commit();
}
export function landingPadSkip() {
  st().runtime.landingPad = { date: dstr(), state: 'skipped' };
  S.commit();
}
/** Returns true exactly once, when the rest window runs out. */
export function landingPadTick(now = Date.now()) {
  const lp = st().runtime.landingPad;
  if (lp && lp.state === 'running' && now >= lp.endTs) {
    lp.state = 'done';
    S.commit();
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ One Thing (tunnel vision) */

export function microPref() {
  const s = st();
  const today = dstr();
  if (!s.runtime.micro || s.runtime.micro.date !== today) s.runtime.micro = { date: today, tierIdx: null, exclude: [], swaps: 0 };
  return s.runtime.micro;
}

export function currentMicro(hard = false) {
  const s = st();
  const today = dstr();
  const m = microPref();
  return E.pickNextMicro(s, today, { tierIdx: m.tierIdx ?? undefined, exclude: m.exclude, hard }, currentEnergy(today));
}

export const swapsLeft = () => Math.max(0, 1 - microPref().swaps);

export function shrink() {
  const m = microPref();
  const cur = currentMicro();
  if (!cur) return;
  m.tierIdx = Math.max(0, cur.tierIdx - 1);
  S.commit();
}

export function swapMicro() {
  const m = microPref();
  if (m.swaps >= 1) return false;
  const cur = currentMicro();
  if (cur) m.exclude.push(cur.topicId);
  m.swaps += 1;
  S.commit();
  return true;
}

export function setTunnel(value) {
  st().runtime.tunnel = { date: dstr(), value };
  S.commit();
}

/** Auto Tunnel Vision: empty battery, late with nothing done yet, or 2+ days of silence. */
export function autoTunnel(phase, now = new Date()) {
  if (phase !== 'evening') return false;
  const s = st();
  const today = dstr(now);
  const energy = currentEnergy(today);
  const todayMin = E.minutesOn(s, today);
  const gap = E.daysSinceLastSession(s, today);
  return energy === 'red' || (now.getHours() >= 20 && todayMin === 0) || (gap !== null && gap >= 3);
}

export function isTunnel(phase, now = new Date()) {
  const ov = st().runtime.tunnel;
  if (ov && ov.date === dstr(now)) return ov.value;
  return autoTunnel(phase, now);
}

/* ------------------------------------------------------------------ routes & bankruptcy */

export function applyRoute(id) {
  const s = st();
  const set = s.meta.settings;
  const opt = E.routeOptions(s, dstr()).find((o) => o.id === id);
  if (id === 'auto') set.route = { mode: 'auto', dailyMin: 0 };
  else if (!opt) return;
  else if (id === 'balanced' || id === 'light') set.route = { mode: id, dailyMin: opt.dailyMin };
  else if (id === 'triage') {
    set.route = { mode: 'triage', dailyMin: 0 };
    opt.skipIds.forEach((tid) => {
      s.topics[tid].skip = true;
      S.put('topics', s.topics[tid]);
    });
  }
  S.touchMeta();
  S.logEvent('route_selected', { id, dailyMin: opt?.dailyMin || null, skipped: opt?.skipIds?.length || 0 });
  snapshotPlan('recalc');
  S.commit();
}

/** Audit Bankruptcy: archive the old plan, zero the streak (best is kept), rebuild from real capacity. */
export function bankruptcy({ examDate, weekdayMin, skipIds = [] }) {
  const s = st();
  const today = dstr();
  const set = s.meta.settings;
  const plan = E.computePlan(s, today);
  S.logEvent('bankruptcy', {
    remainingMin: Math.round(plan.remaining),
    requiredPace: Math.round(plan.unitPace || 0),
    gapDays: plan.gapDays,
    streak: { ...s.meta.streak },
    route: { ...set.route },
    examDate: set.examDate
  });
  s.meta.streak = { ...s.meta.streak, current: 0, missRun: 0, lastReset: Date.now(), lastProcessed: addDays(today, -1) };
  if (examDate) set.examDate = examDate;
  if (weekdayMin) set.baselineWeekdayMin = clamp(Number(weekdayMin), 15, 600);
  set.route = { mode: 'auto', dailyMin: 0 };
  set.lastBankruptcy = Date.now();
  skipIds.forEach((id) => {
    if (s.topics[id]) {
      s.topics[id].skip = true;
      S.put('topics', s.topics[id]);
    }
  });
  snapshotPlan('restructure', true);
  s.meta.lastSnapshotDate = today;
  S.touchMeta();
  S.commit();
}

export function recentBankruptcy(days = 30) {
  const t = st().meta.settings.lastBankruptcy || 0;
  return t > 0 && Date.now() - t < days * 86400000;
}

/** Same plan, new baseline (keeps the streak). Useful after adding many topics. */
export function rebaseline() {
  S.logEvent('rebaseline', {});
  snapshotPlan('rebaseline', true);
  st().meta.lastSnapshotDate = dstr();
  S.touchMeta();
  S.commit();
}

/* ------------------------------------------------------------------ topics & settings */

export function saveTopic(f) {
  const s = st();
  let t = f.id ? s.topics[f.id] : null;
  if (!t) t = { id: uid('t_'), status: 'todo', spentMin: 0, firstPassMin: 0, revisionCount: 0, lastTouched: '', skip: false, confidence: 3 };
  Object.assign(t, {
    subject: String(f.subject || '').trim() || 'General',
    chapter: String(f.chapter || '').trim(),
    name: String(f.name || '').trim() || 'Untitled topic',
    estMin: Math.max(5, Number(f.estMin) || 60),
    weightage: Math.max(0, Number(f.weightage) || 5),
    difficulty: clamp(Number(f.difficulty) || 3, 1, 5),
    confidence: clamp(Number(f.confidence) || 3, 1, 5),
    status: f.status || t.status,
    skip: !!f.skip
  });
  S.put('topics', t);
  S.commit();
}

export function deleteTopic(id) {
  S.remove('topics', id);
  S.commit();
}

export function importTopicsCSV(text) {
  const s = st();
  const rows = parseCSV(text);
  if (rows.length && /subject/i.test(rows[0][0] || '')) rows.shift();
  const have = new Set(E.liveTopics(s).map((t) => `${t.subject}|${t.name}`.toLowerCase()));
  let added = 0;
  for (const r of rows) {
    const [subject, chapter, name, estMin, weightage, difficulty] = r.map((x) => x.trim());
    if (!subject || !name) continue;
    const key = `${subject}|${name}`.toLowerCase();
    if (have.has(key)) continue;
    have.add(key);
    S.put('topics', {
      id: uid('t_'),
      subject,
      chapter: chapter || '',
      name,
      estMin: Math.max(5, Number(estMin) || 60),
      weightage: Math.max(0, Number(weightage) || 5),
      difficulty: clamp(Number(difficulty) || 3, 1, 5),
      confidence: 3,
      status: 'todo',
      spentMin: 0,
      firstPassMin: 0,
      revisionCount: 0,
      lastTouched: '',
      skip: false
    });
    added++;
  }
  S.commit();
  return added;
}

export const loadSample = () => importTopicsCSV(SAMPLE_CSV);

export function saveSettings(f) {
  const s = st();
  const set = s.meta.settings;
  const num = (k, lo, hi) => {
    if (f[k] !== undefined && f[k] !== '') set[k] = clamp(Number(f[k]), lo, hi);
  };
  if (f.examDate !== undefined) set.examDate = f.examDate;
  num('revisionBufferDays', 0, 60);
  num('weeklyRestDay', -1, 6);
  num('baselineWeekdayMin', 15, 600);
  num('maintenanceMin', 10, 120);
  num('minStreakMin', 5, 600);
  num('landingPadMin', 5, 60);
  num('officeEndHour', 12, 23);
  if (f.ifThen !== undefined) set.ifThen = String(f.ifThen).slice(0, 200);
  if (f.reward !== undefined) set.reward = String(f.reward).slice(0, 120);
  if (f.theme !== undefined) set.theme = f.theme;
  if ('nudgesOn' in f) set.nudgesOn = !!f.nudgesOn;
  if (f.onboarded !== undefined) set.onboarded = !!f.onboarded;
  S.touchMeta();
  S.commit();
}
