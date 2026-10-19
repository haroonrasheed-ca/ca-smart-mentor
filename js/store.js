// Local-first store. The browser is the source of truth; Google Sheets is the durable mirror.
// Every row carries `updatedAt` (last write wins) and tables are soft-deleted (`deleted: true`).

import { dstr, addDays, uid } from './utils.js';

const KEY = 'ca-mentor:v1';
const CONN_KEY = 'ca-mentor:conn'; // sheet URL + token live ONLY on this device, never in the synced data
export const TABLES = ['topics', 'sessions', 'days', 'plans', 'events'];

export const DEFAULT_SETTINGS = {
  onboarded: false,
  examDate: '', // default exam date, used by any subject that has no date of its own
  subjectExams: {}, // { subjectName: 'YYYY-MM-DD' }: each subject can have its own exam date
  revisionBufferDays: 7, // final days kept free of new syllabus
  weeklyRestDay: -1, // 0=Sun … 6=Sat, -1 = none
  baselineWeekdayMin: 90, // realistic minutes on a normal office day
  maintenanceMin: 30, // "Empty battery" target
  minStreakMin: 15, // minutes needed for a day to count
  landingPadMin: 20,
  officeEndHour: 18,
  ifThen: '',
  reward: '',
  theme: 'auto',
  nudgesOn: true,
  route: { mode: 'auto', dailyMin: 0 }, // auto | balanced | light | triage
  lastBankruptcy: 0
};

function fresh() {
  const t = dstr();
  return {
    v: 1,
    meta: {
      settings: { ...DEFAULT_SETTINGS },
      streak: { current: 0, best: 0, missRun: 0, shields: 1, maintenanceDays: 0, totalDays: 0, lastProcessed: addDays(t, -1), lastReset: 0 },
      activePlanId: null,
      lastSnapshotDate: '',
      settingsAt: 0 // when the settings were last saved on ANY device (settings follow the newest save)
    },
    metaUpdatedAt: 0,
    topics: {},
    sessions: {},
    days: {},
    plans: {},
    events: {},
    dirty: { meta: 0, topics: {}, sessions: {}, days: {}, plans: {}, events: {} },
    // runtime = per-device, never synced
    runtime: { running: null, draft: null, landingPad: null, micro: null, tunnel: null, appOpenTs: Date.now(), lastPullTs: 0 }
  };
}

function load() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (!raw) return fresh();
    const saved = JSON.parse(raw);
    const f = fresh();
    return {
      ...f,
      ...saved,
      meta: {
        ...f.meta,
        ...(saved.meta || {}),
        settings: { ...f.meta.settings, ...(saved.meta?.settings || {}) },
        streak: { ...f.meta.streak, ...(saved.meta?.streak || {}) }
      },
      dirty: { ...f.dirty, ...(saved.dirty || {}) },
      runtime: { ...f.runtime, ...(saved.runtime || {}), appOpenTs: Date.now() }
    };
  } catch (e) {
    console.warn('Store load failed, starting fresh', e);
    return fresh();
  }
}

let state = load();
const subs = new Set();

export const getState = () => state;
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save locally', e);
  }
}

/** Persist and tell the UI / sync layer something changed. */
export function commit() {
  persist();
  subs.forEach((f) => f(state));
}

export function put(table, obj) {
  obj.updatedAt = Date.now();
  state[table][obj.id] = obj;
  state.dirty[table][obj.id] = 1;
  return obj;
}

export function remove(table, id) {
  const o = state[table][id];
  if (o) {
    o.deleted = true;
    put(table, o);
  }
}

export function touchMeta() {
  state.metaUpdatedAt = Date.now();
  state.dirty.meta = 1;
}

/** Call whenever the person changes a setting. Only this moves the settings forward in time, so a device that merely
 *  rolled over a day can never overwrite settings you saved on another device. */
export function touchSettings() {
  state.meta.settingsAt = Date.now();
  touchMeta();
}

export function logEvent(type, payload = {}) {
  return put('events', { id: uid('e_'), ts: Date.now(), type, payload });
}

export function dirtyCount() {
  return TABLES.reduce((n, t) => n + Object.keys(state.dirty[t] || {}).length, 0) + (state.dirty.meta ? 1 : 0);
}

export function markAllDirty() {
  for (const t of TABLES) for (const id of Object.keys(state[t])) state.dirty[t][id] = 1;
  state.dirty.meta = 1;
  state.metaUpdatedAt = state.metaUpdatedAt || Date.now();
  persist();
}

/* ---- device-only connection settings ---- */
export function getConn() {
  try {
    return JSON.parse(localStorage.getItem(CONN_KEY)) || { url: '', token: '' };
  } catch {
    return { url: '', token: '' };
  }
}
export const setConn = (c) => localStorage.setItem(CONN_KEY, JSON.stringify(c));

/* ---- backup / restore ---- */
export function exportBackup() {
  const { runtime, dirty, ...rest } = state;
  return JSON.stringify({ app: 'ca-smart-mentor', exportedAt: new Date().toISOString(), ...rest }, null, 2);
}

export function importBackup(text) {
  const data = JSON.parse(text);
  if (data.app !== 'ca-smart-mentor' || !data.meta) throw new Error('This is not a CA Smart Mentor backup file.');
  const f = fresh();
  state = {
    ...f,
    ...data,
    meta: { ...f.meta, ...data.meta, settings: { ...f.meta.settings, ...data.meta.settings }, streak: { ...f.meta.streak, ...data.meta.streak } },
    dirty: f.dirty,
    runtime: f.runtime
  };
  markAllDirty();
  commit();
}

export function resetAll() {
  localStorage.removeItem(KEY);
  state = fresh();
  commit();
}
