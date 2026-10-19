// Google Sheets sync (via an Apps Script web app).
//  - The app works fully offline; edits are queued in `dirty` and pushed when online.
//  - Writes use POST with Content-Type text/plain so the browser skips the CORS preflight Apps Script can't answer.
//  - Conflict rule: last write wins, decided by each row's `updatedAt`.
//  - Settings are the exception: they follow the newest SAVE of the settings (`meta.settingsAt`), so every device
//    you connect to the same Sheet ends up with the same settings, and a device that merely rolled over a day
//    can never overwrite them. The colour theme stays per device.
//  - The first time a device connects to a Sheet that already has data, it adopts the Sheet (or asks you).

import * as S from './store.js';
import { debounce } from './utils.js';

let status = { state: 'idle', msg: '', last: Number(localStorage.getItem('ca-mentor:lastSync') || 0) };
const listeners = new Set();
const set = (p) => {
  status = { ...status, ...p };
  listeners.forEach((f) => f(status));
};
export const onStatus = (fn) => listeners.add(fn);
export const getStatus = () => status;
export const isConfigured = () => !!S.getConn().url;

async function call(action, payload = {}) {
  const conn = S.getConn();
  if (!conn.url) throw new Error('Sheet URL is not set yet.');
  let res;
  try {
    res = await fetch(conn.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: conn.token, action, ...payload })
    });
  } catch {
    throw new Error('Could not reach the sheet. Check internet and the Web App URL.');
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('The URL did not answer like the mentor backend. Is it the /exec link of the deployed Web App?');
  }
  if (!json.ok) throw new Error(json.error === 'unauthorized' ? 'Token does not match the one in Code.gs.' : json.error || 'Sync failed.');
  return json;
}

export const test = () => call('ping');

function collectDirty() {
  const s = S.getState();
  const out = {};
  let n = 0;
  for (const t of S.TABLES) {
    const rows = Object.keys(s.dirty[t] || {})
      .map((id) => s[t][id])
      .filter(Boolean);
    if (rows.length) {
      out[t] = rows;
      n += rows.length;
    }
  }
  if (s.dirty.meta) {
    out.meta = [{ id: 'main', updatedAt: s.metaUpdatedAt || Date.now(), data: s.meta }];
    n++;
  }
  return { out, n };
}

export async function push() {
  const { out, n } = collectDirty();
  if (!n) return 0;
  await call('push', { tables: out });
  const s = S.getState();
  for (const t of S.TABLES) {
    (out[t] || []).forEach((r) => {
      if (s[t][r.id] && s[t][r.id].updatedAt === r.updatedAt) delete s.dirty[t][r.id];
    });
  }
  if (out.meta && s.metaUpdatedAt === out.meta[0].updatedAt) s.dirty.meta = 0;
  S.persist();
  return n;
}

export async function pull() {
  const s = S.getState();
  const since = Math.max(0, (s.runtime.lastPullTs || 0) - 60000);
  const res = await call('pull', { since });
  let merged = 0;
  for (const t of S.TABLES) {
    for (const r of res.tables?.[t] || []) {
      const cur = s[t][r.id];
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) {
        s[t][r.id] = { ...r, deleted: !!r.deleted };
        delete s.dirty[t][r.id];
        merged++;
      }
    }
  }
  const m = (res.tables?.meta || []).find((r) => r.id === 'main');
  if (m && m.data && mergeRemoteMeta(s, m)) merged++;
  s.runtime.lastPullTs = res.serverTs || Date.now();
  if (merged) S.commit();
  else S.persist();
  return merged;
}

/**
 * Merge the Sheet's meta row into this device. Field by field, so no device can undo another:
 *  - settings: the newest save wins (theme stays as it is on this device)
 *  - streak: whichever device has processed more days
 *  - active plan: follow the newer daily snapshot
 */
export function mergeRemoteMeta(s, m) {
  const rd = m.data || {};
  let changed = false;
  const rs = rd.settingsAt || 0;
  const ls = s.meta.settingsAt || 0;
  const legacy = rs === 0 && ls === 0 && (m.updatedAt || 0) > (s.metaUpdatedAt || 0); // sheets written before settingsAt existed
  if (rd.settings && (rs > ls || legacy)) {
    s.meta.settings = { ...s.meta.settings, ...rd.settings, theme: s.meta.settings.theme };
    s.meta.settingsAt = rs;
    changed = true;
  }
  if (rd.streak && (rd.streak.lastProcessed || '') > (s.meta.streak.lastProcessed || '')) {
    s.meta.streak = { ...s.meta.streak, ...rd.streak };
    changed = true;
  }
  if (rd.activePlanId && (rd.lastSnapshotDate || '') > (s.meta.lastSnapshotDate || '')) {
    s.meta.activePlanId = rd.activePlanId;
    s.meta.lastSnapshotDate = rd.lastSnapshotDate;
    changed = true;
  }
  if ((m.updatedAt || 0) > (s.metaUpdatedAt || 0)) s.metaUpdatedAt = m.updatedAt;
  if (s.dirty.meta) s.metaUpdatedAt = Math.max(s.metaUpdatedAt || 0, Date.now()); // our merged copy must be accepted by the Sheet
  return changed;
}

/** Replace everything on this device with what the Sheet holds (used when a new device joins an existing Sheet). */
export function adoptRemote(res) {
  const s = S.getState();
  for (const t of S.TABLES) {
    s[t] = {};
    s.dirty[t] = {};
    for (const r of res.tables?.[t] || []) s[t][r.id] = { ...r, deleted: !!r.deleted };
  }
  const m = (res.tables?.meta || []).find((r) => r.id === 'main');
  if (m && m.data) {
    const theme = s.meta.settings.theme;
    s.meta = {
      ...s.meta,
      ...m.data,
      settings: { ...s.meta.settings, ...(m.data.settings || {}), theme },
      streak: { ...s.meta.streak, ...(m.data.streak || {}) },
      settingsAt: m.data.settingsAt || 0
    };
    s.metaUpdatedAt = m.updatedAt || Date.now();
  }
  s.dirty.meta = 0;
  s.runtime.micro = null;
  s.runtime.lastPullTs = res.serverTs || Date.now();
  S.commit();
}

let firstChoice = null; // the Sheet's data, held while the person decides what to keep
export const isAsking = () => !!firstChoice;

/** First sync from this device: look at the Sheet before sending anything. */
async function firstSync() {
  const res = await call('pull', { since: 0 });
  const s = S.getState();
  const live = (t) => (res.tables?.[t] || []).filter((r) => !r.deleted);
  const rm = (res.tables?.meta || []).find((r) => r.id === 'main');
  const remoteHas = live('topics').length + live('sessions').length > 0 || !!(rm && rm.data && rm.data.settings && rm.data.settings.onboarded);
  const localHas = Object.values(s.topics).some((t) => !t.deleted) || Object.values(s.sessions).some((x) => !x.deleted);
  if (!remoteHas) {
    S.markAllDirty(); // an empty Sheet: this device becomes its first source
    const sent = await push();
    await pull();
    return { mode: 'pushed', sent };
  }
  if (!localHas) {
    adoptRemote(res); // a new device joining: take the Sheet's settings and data, send nothing
    return { mode: 'adopted' };
  }
  firstChoice = res; // both sides have data: never guess, ask
  return { mode: 'ask' };
}

/** The person chose "use the Sheet's data" on a device that already had data of its own. */
export function useSheetData() {
  if (!firstChoice) return false;
  adoptRemote(firstChoice);
  firstChoice = null;
  const last = Date.now();
  localStorage.setItem('ca-mentor:lastSync', String(last));
  set({ state: 'ok', msg: 'Connected. Settings and data now come from your Sheet.', last });
  return true;
}

export function dropFirstChoice() {
  firstChoice = null;
  set({ state: 'idle', msg: '' });
}

let busy = false;
export async function syncNow(quiet = false) {
  if (!isConfigured()) return;
  if (busy || firstChoice) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    set({ state: 'offline', msg: 'Offline. Changes are saved on this device and will sync later.' });
    return;
  }
  busy = true;
  set({ state: 'syncing', msg: 'Syncing…' });
  try {
    if (!S.getState().runtime.lastPullTs) {
      const r = await firstSync();
      if (r.mode === 'ask') {
        set({ state: 'ask', msg: 'This Sheet already has data. Choose which to keep.' });
        return;
      }
      const last = Date.now();
      localStorage.setItem('ca-mentor:lastSync', String(last));
      set({ state: 'ok', msg: r.mode === 'adopted' ? 'Connected. Your settings and data came from the Sheet.' : `Connected. Sent ${r.sent}.`, last });
      return;
    }
    // pull first: merge what other devices did, then send the merged result (so stale data can never overwrite newer)
    const pulled = await pull();
    const pushed = await push();
    const last = Date.now();
    localStorage.setItem('ca-mentor:lastSync', String(last));
    set({ state: 'ok', msg: quiet ? '' : `Synced. Sent ${pushed}, received ${pulled}.`, last });
  } catch (e) {
    set({ state: 'error', msg: e.message });
  } finally {
    busy = false;
  }
}

const schedule = debounce(() => syncNow(true), 4000);

export function init() {
  S.subscribe(() => {
    if (isConfigured() && S.dirtyCount() > 0) schedule();
  });
  window.addEventListener('online', () => syncNow(true));
  if (typeof document !== 'undefined') {
    // two devices at once: pick up the other one's changes whenever this app is looked at again, and every minute
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow(true);
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') syncNow(true);
    }, 60000);
  }
  if (isConfigured()) syncNow(true);
}
