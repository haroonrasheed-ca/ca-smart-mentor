// Pure view builders: state in, HTML string out. No DOM access, so they can be smoke-tested in Node.

import { liveTopics, liveSessions, subjectProgress, weeklyStats, studyCapital, modeTarget, paceSeries, routeOptions, courseOutlook } from './engine.js';
import * as M from './mentor.js';
import { esc, fmtMin, fmtDate, fmtClock, addDays, parseD } from './utils.js';
import { paceChart } from './chart.js';

const ENERGY = [
  ['green', 'Full'],
  ['amber', 'Half'],
  ['red', 'Empty']
];
const DAYTYPES = [
  ['normal', 'Normal'],
  ['heavy', 'Heavy office day'],
  ['off', 'Off']
];
const MISS = ['Office ran late', 'Too tired', 'Distracted', 'Unwell', 'Something else'];
const STATUS_LABEL = { todo: 'Not started', doing: 'In progress', done: 'First pass done', revised: 'Revised' };

/* ------------------------------------------------------------------ small parts */

const card = (inner, cls = '') => `<section class="card ${cls}">${inner}</section>`;

function energyRow(c, compact = false) {
  return `<div class="energy ${compact ? 'compact' : ''}" role="group" aria-label="Battery check-in">
    <span class="lbl">Battery</span>
    ${ENERGY.map(([v, l]) => `<button class="chip e-${v} ${c.energy === v ? 'on' : ''}" data-act="energy" data-v="${v}" aria-pressed="${c.energy === v}"><i class="dot"></i>${l}</button>`).join('')}
  </div>`;
}

function dayTypeRow(date, current) {
  return `<div class="chips" role="group" aria-label="Day type">${DAYTYPES.map(
    ([v, l]) => `<button class="chip ${current === v ? 'on' : ''}" data-act="daytype" data-date="${date}" data-v="${v}" aria-pressed="${current === v}">${l}</button>`
  ).join('')}</div>`;
}

function startButton(sub) {
  return `<div class="start-wrap">
    <button class="start" data-act="start" aria-label="Start studying now">
      <span class="start-label">START</span>
      ${sub ? `<span class="start-sub">${esc(sub)}</span>` : ''}
    </button>
  </div>`;
}

function nextLine(c) {
  if (!c.micro) return `<p class="next">Add a few topics and I’ll pick your next step.</p>`;
  return `<p class="next">Next up <b>${esc(c.micro.text)}</b> <span class="muted">· about ${c.micro.estMin} min</span></p>`;
}

function bar(pct) {
  return `<div class="bar" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
}

export function topBar(c) {
  const sk = c.st.meta.streak;
  const streak = sk.current + (c.todayMin >= c.st.meta.settings.minStreakMin ? 1 : 0);
  const sync = c.conn.url ? c.sync.state : 'off';
  const syncLabel = { off: 'Sheet not connected', idle: 'Sheet connected', syncing: 'Syncing', ok: 'Synced', offline: 'Offline', error: 'Sync problem' }[sync];
  return `<div class="brand">Mentor</div>
  <div class="top-right">
    <span class="pill" title="Current streak. Best: ${sk.best}">${streak} day streak</span>
    <span class="pill soft" title="Shields cover a second missed day">${sk.shields} shield${sk.shields === 1 ? '' : 's'}</span>
    <button class="sync-dot ${sync}" data-act="tab" data-v="settings" aria-label="${syncLabel}" title="${syncLabel}"></button>
  </div>`;
}

/* ------------------------------------------------------------------ TODAY */

export function todayView(c) {
  const topics = liveTopics(c.st);
  if (c.plan.status === 'setup' || !topics.length) return setupCard(c, topics.length);
  const body = c.tunnel ? tunnelHtml(c) : todayHtml(c);
  return `${body}${c.tunnel ? '' : cleanSlateLink()}`;
}

function setupCard(c, topicCount) {
  const hasExam = !!c.st.meta.settings.examDate;
  return card(
    `<h1 class="serif">Let’s plot your route</h1>
    <p class="lead">Two things and I’ll start doing the arithmetic for you: your exam date and your syllabus.</p>
    <ul class="checks">
      <li class="${hasExam ? 'ok' : ''}">Exam date ${hasExam ? 'is set' : 'is missing'}</li>
      <li class="${topicCount ? 'ok' : ''}">${topicCount ? `${topicCount} topics added` : 'No topics yet'}</li>
    </ul>
    <div class="row">
      <button class="btn primary" data-act="onboard-open">Set up my route</button>
      ${topicCount ? '' : '<button class="btn ghost" data-act="sample">Load sample topics</button>'}
    </div>`,
    'hero'
  );
}

const cleanSlateLink = () => `<p class="foot"><button class="link" data-act="bankrupt-open">Feeling buried? Take a clean slate</button></p>`;

function tunnelHtml(c) {
  const m = c.micro;
  return `<section class="tunnel">
    ${energyRow(c, true)}
    <div class="one-card">
      <p class="eyebrow">Your one thing</p>
      <h1 class="one-text serif">${esc(m ? m.text : 'Open your notes and read one page')}</h1>
      <p class="muted">About ${m ? m.estMin : 5} minutes. That’s all that’s asked.</p>
    </div>
    ${startButton('')}
    <div class="row center">
      <button class="btn ghost" data-act="shrink" ${m && m.canShrink ? '' : 'disabled'}>Make it smaller</button>
      <button class="btn ghost" data-act="swap" ${c.swapsLeft ? '' : 'disabled'}>Swap${c.swapsLeft ? '' : ' (used today)'}</button>
    </div>
    <p class="foot"><button class="link" data-act="tunnel-off">Show the full dashboard</button></p>
  </section>`;
}

function landingPad(c) {
  if (c.todayMin > 0) return '';
  const lp = c.st.runtime.landingPad;
  const cur = lp && lp.date === c.today ? lp : null;
  if (cur && cur.state === 'skipped') return '';
  if (cur && cur.state === 'running') {
    return card(
      `<p class="eyebrow">Landing pad</p><div class="big-count" data-countdown>${fmtClock(Math.max(0, cur.endTs - Date.now()))}</div>
      <p class="muted">Rest properly: music, tea, a walk. Even scrolling is allowed until this ends.</p>
      <button class="btn ghost" data-act="landing-skip">I’m ready now</button>`,
      'pad running'
    );
  }
  if (cur && cur.state === 'done') {
    return card(`<p class="eyebrow">Rest window over</p><p class="lead">Ready for a ${c.micro ? c.micro.estMin : 10}-minute start? Tap START below.</p>`, 'pad done');
  }
  if (c.hour < (c.st.meta.settings.officeEndHour || 18) - 2) return '';
  const mins = c.st.meta.settings.landingPadMin;
  return card(
    `<p class="eyebrow">Landing pad</p><h2>Rest first, on purpose</h2>
    <p class="muted">${mins} guilt-free minutes with a hard end. Then one small start.</p>
    <div class="row"><button class="btn" data-act="landing-start">Start ${mins}-minute rest</button><button class="btn ghost" data-act="landing-skip">Skip rest</button></div>`,
    'pad'
  );
}

function todayHtml(c) {
  const s = c.st.meta.settings;
  const day = c.st.days[c.today] || {};
  const tomorrow = addDays(c.today, 1);
  const tDay = c.st.days[tomorrow] || {};
  const target = modeTarget(c.plan, s, c.energy || day.energy || '');
  const left = Math.max(0, target - c.todayMin);
  const pct = target > 0 ? (c.todayMin / target) * 100 : c.todayMin > 0 ? 100 : 0;
  const sk = c.st.meta.streak;
  const streak = sk.current + (c.todayMin >= s.minStreakMin ? 1 : 0);
  const line =
    c.todayMin === 0
      ? M.eveningMessage(c.energy, target, c.plan)
      : left === 0
        ? M.nightMessage(c.todayMin, target, day.energy)
        : `${fmtMin(c.todayMin)} banked. ${fmtMin(left)} more reaches today’s target.`;
  const sessions = liveSessions(c.st)
    .filter((x) => x.date === c.today)
    .sort((a, b) => b.startTs - a.startTs);
  const topicName = (id) => c.st.topics[id]?.name || 'Not on my list';

  return `${landingPad(c)}
  ${card(
    `<p class="eyebrow">Today</p>
    <p class="mentor serif">${esc(line)}</p>
    ${s.ifThen && c.todayMin === 0 ? `<p class="muted">${esc(s.ifThen)}</p>` : ''}
    <div class="today-progress">
      <div class="split"><div><b>${fmtMin(c.todayMin)}</b> <span class="muted">of ${fmtMin(target)}</span></div><span class="muted">${streak} day streak</span></div>
      ${bar(pct)}
    </div>
    ${startButton('')}
    ${nextLine(c)}
    ${c.plan.needsRoute ? '<div class="row center"><button class="btn primary" data-act="route-open">Choose a route</button></div>' : ''}
    <div class="row center"><button class="link" data-act="tunnel-on">Show me just one thing</button><button class="link" data-act="manual-log">Log a session I forgot to time</button></div>`,
    'hero'
  )}
  ${card(
    `<h2>Today’s sessions</h2>${
      sessions.length
        ? `<ul class="sessions day">${sessions
            .map(
              (x) => `<li><div><b>${fmtMin(x.minutes)}</b> <span class="muted">· ${esc(topicName(x.topicId))}${x.focus ? ` · focus ${x.focus}/5` : ''}</span>${x.notes ? `<p class="s-note">${esc(x.notes)}</p>` : ''}</div><button class="link" data-act="note-edit" data-id="${x.id}">${x.notes ? 'Edit note' : 'Add note'}</button></li>`
            )
            .join('')}</ul>`
        : '<p class="muted">Nothing yet. Tap START and your session (with notes) will show up here.</p>'
    }`
  )}
  ${card(
    `<div class="check-grid">
      <div><h3>Battery</h3>${energyRow(c, true)}</div>
      <div><h3>What kind of office day?</h3>${dayTypeRow(c.today, day.dayType || 'normal')}</div>
    </div>`
  )}
  ${
    c.todayMin === 0 && c.hour >= 20
      ? card(`<h2>What got in the way?</h2><p class="muted">One tap. It feeds the plan, not your guilt.</p><div class="chips">${MISS.map(
          (m) => `<button class="chip ${day.missReason === m ? 'on' : ''}" data-act="miss" data-v="${esc(m)}">${m}</button>`
        ).join('')}</div>`)
      : ''
  }
  ${card(
    `<h2>Tomorrow</h2><p class="muted">What kind of day does it look like?</p>${dayTypeRow(tomorrow, tDay.dayType || 'normal')}
    <label class="field-l" for="breadcrumb">First step for tomorrow <span class="muted">· start mid-thought</span></label>
    <input class="field" id="breadcrumb" data-change="breadcrumb" data-date="${tomorrow}" maxlength="200" placeholder="e.g. finish the lease example on page 42" value="${esc(tDay.breadcrumb || '')}">`
  )}`;
}

/* ------------------------------------------------------------------ PACE */

const hrs = (m) => Math.round(m / 60);

function outlookCard(o) {
  if (!o.topics) return '';
  const verdictText = {
    comfortable: ['good', 'Comfortable. The pace you really keep is enough.'],
    doable: ['good', `Doable, with a small step up: about ${fmtMin(o.needPerDay)} a day against your usual ${fmtMin(o.capacityMin)}.`],
    stretch: ['warn', `A stretch. It needs about ${fmtMin(o.needPerDay)} a day against your usual ${fmtMin(o.capacityMin)}. Choose a route before it turns into stress.`],
    unrealistic: ['warn', `Not realistic yet. It needs about ${fmtMin(o.needPerDay)} a day, far above your usual ${fmtMin(o.capacityMin)}. Choose a route now, not in week six.`]
  }[o.verdict];
  const basis =
    o.basis === 'learned'
      ? `Based on your own speed: you take ${o.multiplier.toFixed(2)}× your estimates (${o.nDone} topics finished).`
      : 'Not measured yet. Each estimate is padded by its difficulty (harder topics get more) because first estimates run short. After 2 finished topics I switch to your real speed.';
  return card(
    `<p class="eyebrow">Course outlook</p>
    <h2>About ${hrs(o.totalMin)} hours in total</h2>
    <p class="muted">Likely range ${hrs(o.lowMin)}–${hrs(o.highMin)} h · ${hrs(o.spentMin)} h done · ${hrs(o.remainingMin)} h to go · ${o.topics} topics</p>
    <p>Overall difficulty: <b>${esc(o.toughness)}</b> <span class="muted">(${o.difficulty} / 5)</span></p>
    ${o.subjects
      .map(
        (x) => `<div class="subj"><div class="split"><b>${esc(x.subject)} <span class="pill soft">${esc(x.toughness)}</span></b><span class="muted">${hrs(x.totalMin)} h · ${x.share}%</span></div>${bar(x.share)}</div>`
      )
      .join('')}
    ${o.hardest.length ? `<p class="muted">Hardest to get through: ${o.hardest.map((h) => `${esc(h.name)} (${fmtMin(h.min)})`).join(', ')}</p>` : ''}
    ${verdictText ? `<p class="verdict ${verdictText[0]}">${esc(verdictText[1])}</p>${o.verdict === 'stretch' || o.verdict === 'unrealistic' ? '<button class="btn primary" data-act="route-open">Choose a route</button>' : ''}` : ''}
    ${o.etaAtCapacity && o.examDate && o.verdict ? `<p class="muted">At your usual pace you would finish around ${fmtDate(o.etaAtCapacity)}.</p>` : ''}
    <p class="tiny muted">${esc(basis)}</p>
    ${
      o.drift
        ? `<p class="verdict warn">Your syllabus has changed since the ideal line was drawn (${o.drift.pct > 0 ? '+' : ''}${o.drift.pct}% against the ${hrs(o.drift.baseline)} h plan). The graph is comparing you with an old plan.</p><button class="btn" data-act="rebaseline">Reset the ideal line to today</button>`
        : ''
    }`
  );
}

export function paceView(c) {
  const p = c.plan;
  if (p.status === 'setup') return setupCard(c, liveTopics(c.st).length);
  const sc = M.statusCard(p);
  const sr = paceSeries(c.st, c.today);
  const w = weeklyStats(c.st, c.today);
  const gap = p.gapDays;
  const gapTxt = !p.bp ? '—' : Math.abs(gap) < 0.5 ? 'On pace' : gap > 0 ? `${Math.abs(gap).toFixed(1)} days behind` : `${Math.abs(gap).toFixed(1)} days ahead`;
  const maxDay = Math.max(60, ...w.days.map((d) => d.min));
  const subs = subjectProgress(c.st);
  const sessions = liveSessions(c.st).sort((a, b) => b.startTs - a.startTs).slice(0, 8);
  const topicName = (id) => c.st.topics[id]?.name || 'Unassigned';
  const slotBest = Object.entries(w.slots)
    .filter(([, v]) => v.n >= 2 && v.f.length)
    .map(([k, v]) => [k, v.f.reduce((a, b) => a + b, 0) / v.f.length])
    .sort((a, b) => b[1] - a[1])[0];
  const lat = (x) => (x === null ? '—' : x >= 90 ? `${Math.round(x / 60)} min` : `${Math.round(x)} sec`);

  return `${card(`<p class="eyebrow">Trajectory</p><h1 class="serif">${esc(M.headline(p))}</h1>
    <div class="chart-wrap">${sr ? paceChart(sr) : '<p class="muted">Your chart appears after the first daily plan is created.</p>'}</div>
    <div class="legend"><span class="lg ideal">Ideal</span><span class="lg actual">Actual</span><span class="lg forecast">Forecast ±30%</span></div>`, 'hero')}
  ${outlookCard(courseOutlook(c.st, c.today))}
  <div class="tiles">
    <div class="tile"><p class="muted">Needed a day</p><p class="num">${fmtMin(p.unitPace)}</p></div>
    <div class="tile"><p class="muted">Your capacity</p><p class="num">${fmtMin(p.capacity.value)}</p><p class="tiny muted">${p.capacity.source === 'baseline' ? 'your estimate' : 'from your logs'}</p></div>
    <div class="tile"><p class="muted">Forecast finish</p><p class="num">${p.etaDate ? fmtDate(p.etaDate) : '—'}</p></div>
    <div class="tile"><p class="muted">Against ideal</p><p class="num sm">${gapTxt}</p></div>
  </div>
  ${card(`<h2>${esc(sc.title)}</h2><p class="lead">${esc(sc.body)}</p><button class="btn ${p.needsRoute ? 'primary' : 'ghost'}" data-act="route-open">${p.needsRoute ? 'Choose a route' : 'See route options'}</button>`, `status ${sc.tone}`)}
  ${card(`<h2>This week</h2><div class="weekbars">${w.days
    .map(
      (d) => `<div class="wb" title="${fmtDate(d.date)}: ${fmtMin(d.min)}"><i class="${d.maint ? 'maint' : ''}" style="height:${Math.max(4, (d.min / maxDay) * 100)}%"></i><span>${'SMTWTFS'[parseD(d.date).getDay()]}</span></div>`
    )
    .join('')}</div>
    <ul class="kv">
      <li><span>Total</span><b>${fmtMin(w.total)}</b></li>
      <li><span>Days studied</span><b>${w.activeDays} of 7</b></li>
      <li><span>Average focus</span><b>${w.avgFocus ? w.avgFocus.toFixed(1) + ' / 5' : '—'}</b></li>
      <li><span>Time from opening the app to START</span><b>${lat(w.latPrev)} → ${lat(w.latThis)}</b></li>
      ${slotBest ? `<li><span>Sharpest slot so far</span><b>${slotBest[0]}</b></li>` : ''}
      <li><span>Your speed vs your estimates</span><b>${p.mult.nDone >= 2 ? `${p.mult.global.toFixed(2)}×` : 'not measured yet'}</b></li>
    </ul>
    ${w.maintShare > 0.5 ? '<p class="note">More than half of your recent days were maintenance days. That’s the body asking for something: sleep, a lighter route, or a rest day.</p>' : ''}`)}
  ${card(`<h2>Syllabus</h2>${subs.map((x) => `<div class="subj"><div class="split"><b>${esc(x.subject)}</b><span class="muted">${x.pct}% first pass · ${x.revised}/${x.topics} revised</span></div>${bar(x.pct)}</div>`).join('') || '<p class="muted">No topics yet.</p>'}`)}
  ${w.risk.length ? card(`<h2>Where the marks are at risk</h2><ul class="plain">${w.risk.map(({ t }) => `<li><b>${esc(t.name)}</b> <span class="muted">· ${esc(t.subject)} · confidence ${t.confidence}/5</span></li>`).join('')}</ul>`) : ''}
  ${card(`<h2>Recent sessions</h2>${
    sessions.length
      ? `<ul class="sessions">${sessions
          .map(
            (s) => `<li><div><b>${fmtMin(s.minutes)}</b> <span class="muted">· ${esc(topicName(s.topicId))}</span><br><span class="tiny muted">${fmtDate(s.date)}${s.focus ? ` · focus ${s.focus}/5` : ''}</span>${s.notes ? `<p class="s-note">${esc(s.notes)}</p>` : ''}</div><div class="row"><button class="link" data-act="note-edit" data-id="${s.id}">${s.notes ? 'Edit note' : 'Add note'}</button><button class="link" data-act="session-del" data-id="${s.id}" aria-label="Delete session">Delete</button></div></li>`
          )
          .join('')}</ul>`
      : '<p class="muted">Nothing logged yet. Your first START will show up here.</p>'
  }<button class="btn ghost" data-act="manual-log">Log a session manually</button>`)}`;
}

/* ------------------------------------------------------------------ TOPICS */

export function topicsView(c) {
  const ts = liveTopics(c.st);
  if (!ts.length) {
    return card(
      `<h1 class="serif">Your syllabus lives here</h1><p class="lead">Start with the sample set or import your own CSV. You can edit everything later.</p>
      <div class="row"><button class="btn primary" data-act="sample">Load sample topics</button><button class="btn" data-act="import-open">Import CSV</button><button class="btn ghost" data-act="topic-new">Add one topic</button></div>`,
      'hero'
    );
  }
  const subjects = [...new Set(ts.map((t) => t.subject))];
  const o = courseOutlook(c.st, c.today);
  return `<div class="row between"><h1 class="serif">Topics</h1><div class="row"><button class="btn ghost" data-act="import-open">Import</button><button class="btn" data-act="topic-new">Add topic</button></div></div>
  <p class="muted">${o.topics} topics · about ${hrs(o.totalMin)} h in total (likely ${hrs(o.lowMin)}–${hrs(o.highMin)} h) · overall ${esc(o.toughness)}</p>
  ${subjects
    .map((subj) => {
      const list = ts.filter((t) => t.subject === subj);
      return card(`<h2>${esc(subj)}</h2><ul class="topics">${list
        .map(
          (t) => `<li><button class="trow ${t.skip ? 'skipped' : ''}" data-act="topic-edit" data-id="${t.id}">
            <span class="tname"><b>${esc(t.name)}</b>${t.chapter ? `<br><span class="tiny muted">${esc(t.chapter)}</span>` : ''}</span>
            <span class="tmeta"><span class="badge s-${t.status}">${t.skip ? 'Parked' : STATUS_LABEL[t.status]}</span><span class="tiny muted">${fmtMin(t.estMin)} · ${t.weightage}%</span></span>
          </button></li>`
        )
        .join('')}</ul>`);
    })
    .join('')}`;
}

/* ------------------------------------------------------------------ SETTINGS */

export function settingsView(c) {
  const s = c.st.meta.settings;
  const conn = c.conn;
  const opt = (v, l, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${l}</option>`;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const lastSync = c.sync.last ? new Date(c.sync.last).toLocaleString('en-GB') : 'never';
  return `<h1 class="serif">Settings</h1>
  <form data-form="settings">
  ${card(`<h2>Exam & plan</h2>
    <label class="field-l">Exam date<input class="field" type="date" name="examDate" value="${esc(s.examDate)}"></label>
    <label class="field-l">Revision buffer (days kept free before the exam)<input class="field" type="number" name="revisionBufferDays" min="0" max="60" value="${s.revisionBufferDays}"></label>
    <label class="field-l">Weekly rest day<select class="field" name="weeklyRestDay">${opt(-1, 'None', s.weeklyRestDay)}${days.map((d, i) => opt(i, d, s.weeklyRestDay)).join('')}</select></label>
    <label class="field-l">Realistic minutes on a normal office day<input class="field" type="number" name="baselineWeekdayMin" min="15" max="600" value="${s.baselineWeekdayMin}"></label>
    <label class="field-l">Empty-battery (maintenance) minutes<input class="field" type="number" name="maintenanceMin" min="10" max="120" value="${s.maintenanceMin}"></label>
    <label class="field-l">Minutes that keep a streak day alive<input class="field" type="number" name="minStreakMin" min="5" max="600" value="${s.minStreakMin}"></label>
    <label class="field-l">Landing-pad rest (minutes)<input class="field" type="number" name="landingPadMin" min="5" max="60" value="${s.landingPadMin}"></label>`)}
  ${card(`<h2>Habit</h2>
    <label class="field-l">Your if-then sentence<input class="field" name="ifThen" maxlength="200" placeholder="If I finish dinner, then I tap START before picking up my phone." value="${esc(s.ifThen)}"></label>
    <label class="field-l">Study-only treat<input class="field" name="reward" maxlength="120" placeholder="e.g. my favourite podcast, or masala chai" value="${esc(s.reward)}"></label>
    <label class="field-l">Theme<select class="field" name="theme">${opt('auto', 'Match my phone', s.theme)}${opt('dark', 'Dark', s.theme)}${opt('light', 'Light', s.theme)}</select></label>
    <label class="check"><input type="checkbox" name="nudgesOn" ${s.nudgesOn ? 'checked' : ''}> Allow up to two soft email nudges a day (needs the optional trigger in the guide)</label>`)}
  <div class="row"><button class="btn primary" type="submit">Save settings</button></div>
  </form>
  <form data-form="conn">
  ${card(`<h2>Google Sheet sync</h2>
    <p class="muted">Your data stays on this device and mirrors to your own Google Sheet. The link and token are stored only on this device.</p>
    <label class="field-l">Web App URL (ends with /exec)<input class="field" name="url" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(conn.url)}"></label>
    <label class="field-l">Token (same as API_TOKEN in Code.gs)<input class="field" type="password" name="token" autocomplete="off" value="${esc(conn.token)}"></label>
    <p class="muted" id="sync-status">${esc(c.sync.msg || (conn.url ? `Last synced: ${lastSync}` : 'Not connected yet.'))}</p>
    <div class="row"><button class="btn" type="submit">Save & test connection</button><button class="btn ghost" type="button" data-act="sync-now">Sync now</button></div>`)}
  </form>
  ${card(`<h2>Your data</h2>
    <div class="row"><button class="btn ghost" data-act="export">Download backup</button><button class="btn ghost" data-act="import-file">Restore backup</button><input id="backup-file" type="file" accept="application/json" hidden></div>
    <div class="row"><button class="btn ghost" data-act="notif">Enable notifications</button><button class="btn ghost" data-act="rebaseline">Re-baseline plan</button></div>
    <p class="tiny muted">Re-baseline keeps your streak and resets the ideal line. Use it after adding many topics.</p>`)}
  ${card(`<h2>Clean slate</h2><p class="muted">Archive an unmanageable plan and rebuild a realistic one. Your streak resets to zero; your best streak and total study time stay.</p><button class="btn warn" data-act="bankrupt-open">Audit Bankruptcy</button>`)}
  ${card(`<h2>Danger zone</h2><button class="btn ghost" data-act="reset">Erase everything on this device</button>`, 'quiet')}`;
}

/* exposed for the sheets module & smoke test */
export const parts = { ENERGY, DAYTYPES, STATUS_LABEL, routeOptions };
