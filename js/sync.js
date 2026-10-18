// Google Sheets sync (via an Apps Script web app).
//  - The app works fully offline; edits are queued in `dirty` and pushed when online.
//  - Writes use POST with Content-Type text/plain so the browser skips the CORS preflight Apps Script can't answer.
//  - Conflict rule: last write wins, decided by each row's `updatedAt`.

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
  if (m && m.data && (m.updatedAt || 0) > (s.metaUpdatedAt || 0)) {
    s.meta = { ...s.meta, ...m.data, settings: { ...s.meta.settings, ...(m.data.settings || {}) }, streak: { ...s.meta.streak, ...(m.data.streak || {}) } };
    s.metaUpdatedAt = m.updatedAt;
    s.dirty.meta = 0;
    merged++;
  }
  s.runtime.lastPullTs = res.serverTs || Date.now();
  S.commit();
  return merged;
}

let busy = false;
export async function syncNow(quiet = false) {
  if (!isConfigured()) return;
  if (busy) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    set({ state: 'offline', msg: 'Offline. Changes are saved on this device and will sync later.' });
    return;
  }
  busy = true;
  set({ state: 'syncing', msg: 'Syncing…' });
  try {
    const pushed = await push();
    const pulled = await pull();
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
  if (isConfigured()) syncNow(true);
}
