/**
 * CA Smart Mentor — Google Sheets backend (Google Apps Script Web App)
 * ---------------------------------------------------------------------
 * This script is "container-bound": create a Google Sheet, open Extensions → Apps Script, paste this file.
 *
 * What it does
 *   • doPost  → the app talks to it (ping / push / pull). Every call must carry API_TOKEN.
 *   • setup() → creates one tab per table with proper headers (run once).
 *   • nudgeCheck() → OPTIONAL hourly trigger: sends at most two gentle emails a day if you haven't studied.
 *
 * Conflict rule: last write wins, decided by each row's `updatedAt` (milliseconds).
 */

// 1) CHANGE THIS to a long random string (20+ characters). Paste the same value into the app's Settings.
const API_TOKEN = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';

// 2) Optional: hours (24h, script time zone) when a nudge may be sent if no session is logged yet.
const NUDGE_HOURS = [19, 21];

// Each table = one sheet tab. ints → shown as whole numbers, floats → General, bools → TRUE/FALSE, json → stored as JSON text.
const SCHEMA = {
  meta: { cols: ['id', 'updatedAt', 'data'], ints: ['updatedAt'], floats: [], bools: [], json: ['data'] },
  topics: {
    cols: ['id', 'subject', 'chapter', 'name', 'estMin', 'weightage', 'difficulty', 'confidence', 'status', 'spentMin', 'firstPassMin', 'revisionCount', 'lastTouched', 'skip', 'deleted', 'updatedAt'],
    ints: ['estMin', 'difficulty', 'confidence', 'spentMin', 'firstPassMin', 'revisionCount', 'updatedAt'],
    floats: ['weightage'],
    bools: ['skip', 'deleted'],
    json: []
  },
  sessions: {
    cols: ['id', 'date', 'startTs', 'endTs', 'minutes', 'topicId', 'subject', 'activity', 'units', 'focus', 'pauses', 'planned', 'logDelaySec', 'mode', 'energy', 'notes', 'deleted', 'updatedAt'],
    ints: ['startTs', 'endTs', 'minutes', 'units', 'focus', 'pauses', 'logDelaySec', 'updatedAt'],
    floats: [],
    bools: ['planned', 'deleted'],
    json: []
  },
  days: {
    cols: ['id', 'date', 'dayType', 'energy', 'mode', 'sleepHours', 'missReason', 'breadcrumb', 'minutes', 'maintenance', 'updatedAt'],
    ints: ['minutes', 'updatedAt'],
    floats: ['sleepHours'],
    bools: ['maintenance'],
    json: []
  },
  plans: {
    cols: ['id', 'createdAt', 'reason', 'remainingMin', 'targetMin', 'eta', 'examDate', 'effectiveDays', 'baselineStart', 'baselineEnd', 'baselineTotal', 'updatedAt'],
    ints: ['createdAt', 'remainingMin', 'targetMin', 'baselineTotal', 'updatedAt'],
    floats: ['effectiveDays'],
    bools: [],
    json: []
  },
  events: { cols: ['id', 'ts', 'type', 'payload', 'updatedAt'], ints: ['ts', 'updatedAt'], floats: [], bools: [], json: ['payload'] }
};

/* ============================ Web app entry points ============================ */

function doGet() {
  // Harmless health check. Never returns data.
  return json_({ ok: true, service: 'CA Smart Mentor API', note: 'Use the app. This endpoint only answers POST requests with a valid token.' });
}

function doPost(e) {
  let lock;
  try {
    if (API_TOKEN.indexOf('CHANGE_ME') === 0) return json_({ ok: false, error: 'Set API_TOKEN in Code.gs first, then redeploy.' });
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.token !== API_TOKEN) return json_({ ok: false, error: 'unauthorized' });

    lock = LockService.getScriptLock();
    lock.waitLock(20000);

    switch (body.action) {
      case 'ping':
        return json_({ ok: true, time: Date.now(), tables: Object.keys(SCHEMA) });
      case 'push': {
        const out = {};
        Object.keys(body.tables || {}).forEach(function (name) {
          if (SCHEMA[name]) out[name] = upsert_(name, body.tables[name]);
        });
        return json_({ ok: true, result: out, serverTs: Date.now() });
      }
      case 'pull': {
        const since = Number(body.since) || 0;
        const tables = {};
        Object.keys(SCHEMA).forEach(function (name) {
          tables[name] = readAll_(name).filter(function (r) { return (r.updatedAt || 0) > since; });
        });
        return json_({ ok: true, tables: tables, serverTs: Date.now() });
      }
      default:
        return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================ Sheet helpers ============================ */

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const cols = SCHEMA[name].cols;
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#e8f0f1');
    sh.setFrozenRows(1);
  }
  return sh;
}

function formats_(def, rows) {
  const row = def.cols.map(function (c) {
    if (def.ints.indexOf(c) >= 0) return '0';
    if (def.floats.indexOf(c) >= 0 || def.bools.indexOf(c) >= 0) return 'General';
    return '@'; // plain text: keeps dates like 2026-10-18 from turning into Date objects
  });
  const out = [];
  for (let i = 0; i < rows; i++) out.push(row);
  return out;
}

function toRow_(def, o) {
  return def.cols.map(function (c) {
    const v = o[c];
    if (v === undefined || v === null) return '';
    if (def.json.indexOf(c) >= 0) return JSON.stringify(v);
    if (def.bools.indexOf(c) >= 0) return !!v;
    return v;
  });
}

function fromRow_(def, r) {
  const tz = Session.getScriptTimeZone();
  const o = {};
  def.cols.forEach(function (c, i) {
    let v = r[i];
    if (def.json.indexOf(c) >= 0) {
      try { v = v === '' || v === null ? null : JSON.parse(v); } catch (e) { v = null; }
    } else if (def.ints.indexOf(c) >= 0 || def.floats.indexOf(c) >= 0) {
      v = v === '' || v === null ? null : Number(v);
    } else if (def.bools.indexOf(c) >= 0) {
      v = v === true || v === 'TRUE' || v === 'true';
    } else {
      if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      v = v === null || v === undefined ? '' : String(v);
    }
    o[c] = v;
  });
  return o;
}

function readAll_(name) {
  const def = SCHEMA[name];
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh
    .getRange(2, 1, last - 1, def.cols.length)
    .getValues()
    .map(function (r) { return fromRow_(def, r); })
    .filter(function (r) { return r.id !== '' && r.id !== null; });
}

function upsert_(name, rows) {
  const def = SCHEMA[name];
  const sh = sheet_(name);
  const n = def.cols.length;
  const updCol = def.cols.indexOf('updatedAt');

  // de-duplicate the batch (keep the newest per id)
  const byId = {};
  (rows || []).forEach(function (o) {
    if (!o || o.id === undefined || o.id === '') return;
    const k = String(o.id);
    if (!byId[k] || (Number(o.updatedAt) || 0) >= (Number(byId[k].updatedAt) || 0)) byId[k] = o;
  });

  const last = sh.getLastRow();
  const existing = last >= 2 ? sh.getRange(2, 1, last - 1, n).getValues() : [];
  const idx = {};
  existing.forEach(function (r, i) { idx[String(r[0])] = i; });

  const append = [];
  let updated = 0;
  Object.keys(byId).forEach(function (k) {
    const o = byId[k];
    if (k in idx) {
      const i = idx[k];
      const old = Number(existing[i][updCol]) || 0;
      if ((Number(o.updatedAt) || 0) >= old) {
        const rg = sh.getRange(i + 2, 1, 1, n);
        rg.setNumberFormats(formats_(def, 1));
        rg.setValues([toRow_(def, o)]);
        updated++;
      }
    } else {
      append.push(toRow_(def, o));
    }
  });
  if (append.length) {
    const rg = sh.getRange(sh.getLastRow() + 1, 1, append.length, n);
    rg.setNumberFormats(formats_(def, append.length));
    rg.setValues(append);
  }
  return { updated: updated, added: append.length };
}

/* ============================ One-time setup ============================ */

/** Run this ONCE from the editor (▶ Run → setup). It creates every tab and a small Dashboard. */
function setup() {
  Object.keys(SCHEMA).forEach(sheet_);
  const ss = ss_();
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() <= 1 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  let d = ss.getSheetByName('Dashboard');
  if (!d) d = ss.insertSheet('Dashboard', 0);
  d.clear();
  d.getRange('A1').setValue('CA Smart Mentor — quick numbers').setFontWeight('bold').setFontSize(14);
  d.getRange('A3:B5').setFormulas([
    ['Total hours studied', '=IFERROR(SUMIFS(sessions!E:E,sessions!Q:Q,FALSE)/60,0)'],
    ['Sessions logged', '=IFERROR(COUNTIFS(sessions!A:A,"<>",sessions!Q:Q,FALSE),0)'],
    ['Average focus (1-5)', '=IFERROR(AVERAGEIFS(sessions!J:J,sessions!Q:Q,FALSE),"-")']
  ]);
  d.getRange('A7').setValue('Minutes by subject').setFontWeight('bold');
  d.getRange('A8').setFormula('=IFERROR(QUERY(sessions!A:R,"select G, sum(E) where Q = false and G <> \'\' group by G order by sum(E) desc label G \'Subject\', sum(E) \'Minutes\'",1),"Log a session to see this")');
  d.setColumnWidth(1, 220);
  Logger.log('Setup complete. Tabs: ' + Object.keys(SCHEMA).join(', '));
}

/* ============================ Optional gentle nudges (email) ============================ */

/** Run installTriggers() once if you want up to two soft emails a day. Run removeTriggers() to stop them. */
function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('nudgeCheck').timeBased().everyHours(1).create();
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'nudgeCheck') ScriptApp.deleteTrigger(t);
  });
}

function nudgeCheck() {
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const slot = NUDGE_HOURS.indexOf(hour);
  if (slot < 0) return;

  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  const key = 'nudge_' + today + '_' + slot;
  if (props.getProperty(key)) return; // never more than one per slot

  const meta = readAll_('meta').filter(function (r) { return r.id === 'main'; })[0];
  const settings = (meta && meta.data && meta.data.settings) || {};
  if (settings.nudgesOn === false) return;

  const studied = readAll_('sessions').some(function (s) { return s.date === today && !s.deleted && (s.minutes || 0) > 0; });
  if (studied) return;

  const day = readAll_('days').filter(function (r) { return r.id === today; })[0];
  if (day && day.dayType === 'off') return;

  const sentence = settings.ifThen || 'Open the app and tap START. Ten minutes is enough to count.';
  const subject = slot === 0 ? 'Ready when you are' : 'Tired day? A small start still counts';
  const body =
    slot === 0
      ? 'Your plan, in your own words:\n\n' + sentence + '\n\nNo catching up needed. The route has already been recalculated around your day.'
      : 'If the battery is empty, set it to Empty in the app. A 15–30 minute maintenance session keeps your streak alive, and nothing more is expected tonight.';
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body);
  props.setProperty(key, '1');
}
