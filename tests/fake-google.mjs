// In-memory fake of the Google services Code.gs uses (Sheets, Properties, Mail, Lock, Content).
// Shared by backend.test.mjs and flow.test.mjs so the REAL Code.gs is what gets exercised.

import vm from 'node:vm';
import fs from 'node:fs';

export const TZ = 'Asia/Karachi';

function makeSheet(name) {
  const data = []; // data[r][c], 0-based
  const sh = {
    name,
    formats: {},
    getLastRow: () => {
      let last = 0;
      data.forEach((row, i) => {
        if (row && row.some((v) => v !== '' && v !== undefined && v !== null)) last = i + 1;
      });
      return last;
    },
    setFrozenRows() {},
    setColumnWidth() {},
    clear() { data.length = 0; },
    getRange(r, c, nr = 1, nc = 1) {
      const rg = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => data[r - 1 + i]?.[c - 1 + j] ?? '')),
        setValues: (vals) => {
          vals.forEach((row, i) => {
            data[r - 1 + i] ||= [];
            row.forEach((v, j) => (data[r - 1 + i][c - 1 + j] = v));
          });
          return rg;
        },
        setNumberFormats: (f) => { sh.formats[`${r}:${c}`] = f; return rg; },
        setValue: (v) => rg.setValues([[v]]),
        setFormulas: (f) => rg.setValues(f),
        setFormula: (f) => rg.setValues([[f]]),
        setFontWeight: () => rg,
        setBackground: () => rg,
        setFontSize: () => rg
      };
      return rg;
    }
  };
  return sh;
}

export function boot({ nudgeHour = null } = {}) {
  let src = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  src = src.replace('CHANGE_ME_TO_A_LONG_RANDOM_STRING', 'unit-test-token-1234567890');
  if (nudgeHour !== null) src = src.replace('const NUDGE_HOURS = [19, 21];', `const NUDGE_HOURS = [${nudgeHour}, ${(nudgeHour + 1) % 24}];`);
  const sheets = {};
  const mails = [];
  const props = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: (s) => delete sheets[s.name]
  };
  const ctx = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    ContentService: { createTextOutput: (t) => ({ t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => TZ, getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
        return fmt === 'H' ? String(Number(p.hour) % 24) : `${p.year}-${p.month}-${p.day}`;
      }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => (props[k] = v) }) },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    Logger: { log() {} },
    Date, JSON, Object, String, Number, Array
  });
  vm.runInContext(src, ctx);
  const post = (body) => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(body) } }).t);
  return { ctx, post, sheets, mails, props, run: (code) => vm.runInContext(code, ctx) };
}

export const TOKEN = 'unit-test-token-1234567890';
