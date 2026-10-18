// Entry point: wires the store, engine, views and sheets to the DOM.

import * as S from './store.js';
import * as E from './engine.js';
import * as A from './actions.js';
import * as Sync from './sync.js';
import * as V from './views.js';
import * as Sh from './sheets.js';
import * as M from './mentor.js';
import { $, $$, esc, dstr, fmtClock } from './utils.js';

const viewEl = $('#view');
const topEl = $('#top');
const navEl = $('#nav');
const sessionEl = $('#session');
const sheetEl = $('#sheet');
const toastEl = $('#toast');

let tab = 'today';
let phaseManual = false;
let hiddenAt = 0;
const autoPhase = (d = new Date()) => {
  const h = d.getHours();
  if (h >= 4 && h < 11) return 'morning';
  if (h >= 22 || h < 4) return 'night';
  return 'evening';
};
let phase = autoPhase();

/* ------------------------------------------------------------------ context + render */

function ctx() {
  const st = S.getState();
  const today = dstr();
  const plan = E.computePlan(st, today);
  return {
    st,
    today,
    plan,
    phase,
    energy: A.currentEnergy(today),
    tunnel: A.isTunnel(phase),
    micro: A.currentMicro(),
    swapsLeft: A.swapsLeft(),
    todayMin: plan.todayMin,
    hour: new Date().getHours(),
    sync: Sync.getStatus(),
    conn: S.getConn(),
    recalc: A.recalcNotice()
  };
}

function applyTheme(st) {
  const t = st.meta.settings.theme;
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function renderSession(st) {
  const r = st.runtime.running;
  if (!r) {
    sessionEl.hidden = true;
    sessionEl.innerHTML = '';
    document.body.classList.remove('locked');
    return;
  }
  sessionEl.hidden = false;
  document.body.classList.add('locked');
  sessionEl.innerHTML = `<div class="session-inner">
    <p class="eyebrow">${r.paused ? 'Paused' : 'In session'}</p>
    <p class="session-text serif">${esc(r.text || 'Focus session')}</p>
    <div id="timer" class="timer" aria-live="off">${fmtClock(A.elapsedMs(r))}</div>
    <p class="muted" id="session-hint">Counting up, no pressure. Stop whenever you like.</p>
    <div class="row center">
      <button class="btn" data-act="pause">${r.paused ? 'Resume' : 'Pause'}</button>
      <button class="btn primary big" data-act="stop">Done</button>
    </div>
  </div>`;
}

function render() {
  const c = ctx();
  applyTheme(c.st);
  topEl.innerHTML = V.topBar(c);
  const pages = { today: V.todayView, pace: V.paceView, topics: V.topicsView, settings: V.settingsView };
  const keepScroll = viewEl.dataset.tab === tab ? window.scrollY : 0;
  viewEl.innerHTML = pages[tab](c);
  viewEl.dataset.tab = tab;
  if (keepScroll) window.scrollTo(0, keepScroll);
  $$('button', navEl).forEach((b) => b.setAttribute('aria-current', b.dataset.v === tab ? 'page' : 'false'));
  document.body.dataset.tunnel = tab === 'today' && c.tunnel && c.plan.status !== 'setup' ? '1' : '';
  renderSession(c.st);
}

/* ------------------------------------------------------------------ small UI helpers */

let toastTimer;
function toast(msg, ms = 3200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function openSheet(html, { lock = false } = {}) {
  sheetEl.innerHTML = `<div class="sheet-backdrop" ${lock ? '' : 'data-act="sheet-close"'}></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  sheetEl.hidden = false;
  document.body.classList.add('locked');
  const first = $('input:not([type=hidden]),select,textarea,button.btn', sheetEl);
  if (first) setTimeout(() => first.focus({ preventScroll: true }), 50);
}
function closeSheet() {
  sheetEl.hidden = true;
  sheetEl.innerHTML = '';
  if (!S.getState().runtime.running) document.body.classList.remove('locked');
}

function notify(title, body) {
  try {
    navigator.vibrate?.([200, 100, 200]);
    if ('Notification' in window && Notification.permission === 'granted') {
      if (navigator.serviceWorker?.controller) navigator.serviceWorker.ready.then((r) => r.showNotification(title, { body, icon: 'icons/icon-192.png', tag: 'mentor' }));
      else new Notification(title, { body, icon: 'icons/icon-192.png' });
    }
  } catch {
    /* notifications are a nice-to-have */
  }
}

const obj = (fd) => Object.fromEntries(fd.entries());
const ensurePlan = () => {
  if (!S.getState().meta.activePlanId) A.ensureToday();
};

/* ------------------------------------------------------------------ actions */

function begin(micro, mode, text) {
  A.startSession({ topicId: micro?.topicId || null, mode, text: text || micro?.text || 'Focus session' });
}

function openLog(draft) {
  const st = S.getState();
  openSheet(Sh.logSheet({ st, draft }), { lock: true });
}

const handlers = {
  tab: (el) => {
    tab = el.dataset.v;
    window.scrollTo(0, 0);
    render();
  },
  phase: (el) => {
    phase = el.dataset.v;
    phaseManual = true;
    render();
  },
  energy: (el) => A.setEnergy(el.dataset.v),
  daytype: (el) => A.setDayType(el.dataset.date, el.dataset.v),
  sleep: (el) => A.setSleep(el.dataset.v),
  miss: (el) => A.setMissReason(el.dataset.v),

  start: () => {
    const c = ctx();
    begin(c.micro, A.modeForEnergy(c.energy, c.tunnel));
  },
  spark: () => {
    const m = A.currentMicro(true);
    begin(m, 'full', m ? `Morning spark: ${m.text}` : 'Morning spark');
  },
  again: () => {
    closeSheet();
    const st = S.getState();
    const m = E.pickNextMicro(st, dstr(), { tierIdx: 0 }, A.currentEnergy());
    begin(m, 'one-thing');
  },
  'done-today': () => {
    closeSheet();
    phase = autoPhase() === 'morning' ? 'morning' : 'night';
    phaseManual = true;
    render();
  },
  pause: () => A.togglePause(),
  stop: () => {
    const d = A.stopSession();
    if (d) openLog(d);
  },
  'discard-draft': () => {
    A.discardDraft();
    closeSheet();
  },
  'manual-log': () => openLog(A.newManualDraft()),

  'tunnel-on': () => A.setTunnel(true),
  'tunnel-off': () => A.setTunnel(false),
  shrink: () => A.shrink(),
  swap: () => {
    if (!A.swapMicro()) toast('One swap a day. Make it smaller instead?');
  },

  'landing-start': () => A.landingPadStart(),
  'landing-skip': () => A.landingPadSkip(),

  'route-open': () => openSheet(Sh.routeSheet({ st: S.getState() })),
  'route-pick': (el) => {
    A.applyRoute(el.dataset.id);
    closeSheet();
    toast('Route updated. Your plan has been recalculated.');
  },
  'bankrupt-open': () => {
    const c = ctx();
    openSheet(Sh.bankruptcySheet({ st: c.st, plan: c.plan, recent: A.recentBankruptcy() }), { lock: false });
  },

  'onboard-open': () => openSheet(Sh.onboardSheet({ st: S.getState() })),
  'topic-new': () => openSheet(Sh.topicSheet({ topic: null })),
  'topic-edit': (el) => openSheet(Sh.topicSheet({ topic: S.getState().topics[el.dataset.id] })),
  'topic-delete': (el) => {
    if (confirm('Delete this topic? Your logged sessions stay.')) {
      A.deleteTopic(el.dataset.id);
      closeSheet();
    }
  },
  'import-open': () => openSheet(Sh.importSheet()),
  sample: () => {
    const n = A.loadSample();
    ensurePlan();
    toast(n ? `Added ${n} sample topics. Replace them with your syllabus any time.` : 'Sample topics are already in your list.');
  },
  'session-del': (el) => {
    if (confirm('Delete this session?')) A.deleteSession(el.dataset.id);
  },
  'sheet-close': () => {
    if (S.getState().runtime.draft && !S.getState().runtime.running && $('form[data-form=log]', sheetEl)) return; // keep unsaved logs
    closeSheet();
  },

  'sync-now': async () => {
    if (!Sync.isConfigured()) return toast('Add your Web App URL first.');
    await Sync.syncNow();
    const s = Sync.getStatus();
    toast(s.state === 'ok' ? 'Synced with your Google Sheet.' : s.msg);
  },
  export: () => {
    const blob = new Blob([S.exportBackup()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ca-mentor-backup-${dstr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'import-file': () => $('#backup-file')?.click(),
  reset: () => {
    if (confirm('Erase all study data on THIS device? Your Google Sheet copy is not touched.')) {
      S.resetAll();
      toast('Erased on this device.');
    }
  },
  notif: async () => {
    if (!('Notification' in window)) return toast('This browser does not support notifications.');
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? 'Notifications on. I’ll ping when your rest window ends.' : 'Notifications stay off.');
  },
  rebaseline: () => {
    if (confirm('Reset the ideal line to today? Your streak stays.')) {
      A.rebaseline();
      toast('Plan re-baselined.');
    }
  }
};

/* ------------------------------------------------------------------ events */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = handlers[el.dataset.act];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'backup-file') {
    const file = el.files[0];
    if (!file) return;
    file.text().then((t) => {
      try {
        S.importBackup(t);
        A.ensureToday();
        toast('Backup restored.');
      } catch (err) {
        toast(err.message);
      }
    });
    return;
  }
  const d = el.closest('[data-change]')?.dataset.change;
  if (d === 'breadcrumb') A.setBreadcrumb(el.dataset.date, el.value);
  if (d === 'log-topic') {
    const t = S.getState().topics[el.value];
    const want = Sh.defaultStatusFor(t);
    const radio = $(`#status-chips input[value="${want}"]`, sheetEl);
    if (radio) radio.checked = true;
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const kind = form.dataset.form;

  if (kind === 'log') {
    const res = A.saveSession(obj(fd));
    closeSheet();
    openSheet(Sh.completeSheet(res), { lock: false });
  } else if (kind === 'settings') {
    A.saveSettings({ ...obj(fd), nudgesOn: fd.has('nudgesOn') });
    ensurePlan();
    toast('Settings saved.');
  } else if (kind === 'conn') {
    const url = String(fd.get('url') || '').trim();
    const token = String(fd.get('token') || '').trim();
    S.setConn({ url, token });
    if (!url) return toast('Connection cleared.');
    try {
      await Sync.test();
      if (!S.getState().runtime.lastPullTs) S.markAllDirty();
      await Sync.syncNow();
      toast(Sync.getStatus().state === 'ok' ? 'Connected. Your sheet is now your backup.' : Sync.getStatus().msg);
    } catch (err) {
      toast(err.message, 5000);
      const el = $('#sync-status');
      if (el) el.textContent = err.message;
    }
  } else if (kind === 'topic') {
    A.saveTopic({ ...obj(fd), skip: fd.has('skip') });
    ensurePlan();
    closeSheet();
  } else if (kind === 'import') {
    const n = A.importTopicsCSV(String(fd.get('csv') || ''));
    ensurePlan();
    closeSheet();
    toast(n ? `Imported ${n} topics.` : 'No new topics found in that text.');
  } else if (kind === 'bankrupt') {
    A.bankruptcy({ examDate: fd.get('examDate'), weekdayMin: fd.get('weekdayMin'), skipIds: fd.getAll('skip') });
    closeSheet();
    tab = 'today';
    toast('Fresh start. Your route is rebuilt from what you actually manage.', 4500);
  } else if (kind === 'onboard') {
    A.saveSettings({
      examDate: fd.get('examDate'),
      baselineWeekdayMin: fd.get('baselineWeekdayMin'),
      weeklyRestDay: fd.get('weeklyRestDay'),
      ifThen: fd.get('ifThen'),
      onboarded: true
    });
    if (fd.has('sample')) A.loadSample();
    A.ensureToday();
    closeSheet();
    toast('Your route is ready.');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheetEl.hidden) handlers['sheet-close']();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  const st = S.getState();
  if (!st.runtime.running) st.runtime.appOpenTs = Date.now();
  if (hiddenAt && Date.now() - hiddenAt > 20 * 60000) phaseManual = false;
  if (!phaseManual) phase = autoPhase();
  A.ensureToday();
  if (Sync.isConfigured()) Sync.syncNow(true);
  render();
});

/* ------------------------------------------------------------------ ticking (timer, landing pad) */

setInterval(() => {
  const st = S.getState();
  const r = st.runtime.running;
  if (r) {
    const ms = A.elapsedMs(r);
    const t = $('#timer');
    if (t) t.textContent = fmtClock(ms);
    const sec = Math.floor(ms / 1000);
    for (const mark of [120, 300, 600]) {
      if (sec >= mark && !r.sent.includes(mark)) {
        r.sent.push(mark);
        const msg = M.milestone(mark);
        if (msg) toast(msg, 4000);
      }
    }
  }
  const lp = st.runtime.landingPad;
  if (lp && lp.state === 'running') {
    const left = lp.endTs - Date.now();
    if (left <= 0) {
      if (A.landingPadTick()) {
        toast('Rest window over. Ready for a small start?', 6000);
        notify('Rest window over', 'Ready for a 10-minute start?');
      }
    } else $$('[data-countdown]').forEach((el) => (el.textContent = fmtClock(left)));
  }
}, 1000);

/* ------------------------------------------------------------------ boot */

A.ensureToday();
Sync.init();
Sync.onStatus(() => {
  topEl.innerHTML = V.topBar(ctx());
  const el = $('#sync-status');
  const s = Sync.getStatus();
  if (el && s.msg) el.textContent = s.msg;
});
S.subscribe(render);
render();

if (!S.getState().meta.settings.onboarded) openSheet(Sh.onboardSheet({ st: S.getState() }), { lock: true });

// "Start now" home-screen shortcut
if (new URLSearchParams(location.search).get('start') === '1') {
  history.replaceState(null, '', location.pathname);
  const st = S.getState();
  if (st.meta.settings.onboarded && Object.keys(st.topics).length && !st.runtime.running) {
    const c = ctx();
    begin(c.micro, A.modeForEnergy(c.energy, c.tunnel));
  }
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
}
