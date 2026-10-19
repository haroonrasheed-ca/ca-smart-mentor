// Modal ("bottom sheet") content builders. Pure strings, no DOM.

import { liveTopics, routeOptions, subjectsOf } from './engine.js';
import * as M from './mentor.js';
import { esc, fmtMin, fmtDate, addDays, dstr } from './utils.js';

const close = `<button type="button" class="sheet-x" data-act="sheet-close" aria-label="Close">×</button>`;
const radio = (name, value, label, checked, cls = '') =>
  `<label class="chip radio ${cls}"><input type="radio" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}><span>${label}</span></label>`;

export function defaultStatusFor(topic) {
  if (!topic) return 'doing';
  return topic.status === 'todo' ? 'doing' : topic.status;
}

export function logSheet({ st, draft, today = dstr() }) {
  const topics = liveTopics(st);
  const subjects = [...new Set(topics.map((t) => t.subject))];
  const sel = draft.topicId && st.topics[draft.topicId] ? draft.topicId : '';
  const topic = sel ? st.topics[sel] : null;
  const status = defaultStatusFor(topic);
  const manual = !!draft.manual;
  return `<form data-form="log" class="sheet-form">
    ${close}
    <h2 class="serif">${manual ? 'Log a session' : 'Nice. Ten seconds to log it'}</h2>
    <p class="muted">${manual ? 'For anything you didn’t time.' : 'Everything is pre-filled. Change only what’s wrong.'}</p>
    <div class="grid2">
      <label class="field-l">Minutes<input class="field" name="minutes" type="number" inputmode="numeric" min="1" max="720" value="${esc(draft.minutes ?? '')}" required></label>
      ${manual ? `<label class="field-l">Day<select class="field" name="date"><option value="${today}">Today</option><option value="${addDays(today, -1)}">Yesterday</option></select></label>` : '<div></div>'}
    </div>
    <label class="field-l">Topic<select class="field" name="topicId" data-change="log-topic">
      <option value="">Not on my list</option>
      ${subjects.map((s) => `<optgroup label="${esc(s)}">${topics.filter((t) => t.subject === s).map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>`).join('')}
    </select></label>
    <label class="field-l">Notes <span class="tiny">(optional: what you learned, where you stopped, what to revisit)</span>
      <textarea class="field" name="notes" rows="3" maxlength="500" placeholder="e.g. Lease modification part is still unclear. Redo question 4 tomorrow.">${esc(draft.notes || '')}</textarea>
    </label>
    <fieldset><legend>What did you do?</legend><div class="chips">
      ${[['reading', 'Read'], ['practice', 'Practice'], ['revision', 'Revise'], ['video', 'Video'], ['notes', 'Notes']].map(([v, l], i) => radio('activity', v, l, i === 0)).join('')}
    </div></fieldset>
    <fieldset><legend>Focus</legend><div class="chips">${[1, 2, 3, 4, 5].map((n) => radio('focus', n, n, n === 3)).join('')}</div></fieldset>
    <fieldset><legend>Where is this topic now?</legend><div class="chips" id="status-chips">
      ${[['doing', 'Still working'], ['done', 'First pass done'], ['revised', 'Revised']].map(([v, l]) => radio('status', v, l, status === v)).join('')}
    </div></fieldset>
    <details><summary>A little more detail</summary>
      <fieldset><legend>Confidence now</legend><div class="chips">${radio('confidence', '', 'Skip', true)}${[1, 2, 3, 4, 5].map((n) => radio('confidence', n, n, false)).join('')}</div></fieldset>
      <label class="field-l">Questions or pages done<input class="field" name="units" type="number" inputmode="numeric" min="0" max="999"></label>
    </details>
    <div class="row"><button class="btn primary big" type="submit">Save and bank it</button>${manual ? '' : '<button class="btn ghost" type="button" data-act="discard-draft">Discard</button>'}</div>
  </form>`;
}

export function noteSheet({ session, topicName }) {
  return `<form data-form="note" class="sheet-form">
    ${close}
    <h2 class="serif">Session note</h2>
    <p class="muted">${esc(topicName)} · ${fmtMin(session.minutes)}</p>
    <input type="hidden" name="id" value="${esc(session.id)}">
    <label class="field-l">Note
      <textarea class="field" name="notes" rows="5" maxlength="500" placeholder="What did you learn? Where did you stop? What to revisit?">${esc(session.notes || '')}</textarea>
    </label>
    <div class="row"><button class="btn primary big" type="submit">Save note</button></div>
  </form>`;
}

export function completeSheet({ minutes, capital }) {
  return `<div class="sheet-form center">
    <div class="burst" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="23"/><path d="M15 27l8 8 14-17"/></svg></div>
    <h2 class="serif">${esc(M.completeMessage(minutes))}</h2>
    <p class="muted">Study capital: <b>${fmtMin(capital)}</b>. It only ever goes up.</p>
    <div class="row center">
      <button class="btn primary" data-act="again">One more, just 5 minutes</button>
      <button class="btn ghost" data-act="done-today">I’m done for now</button>
    </div>
  </div>`;
}

export function routeSheet({ st, today = dstr() }) {
  const opts = routeOptions(st, today);
  const cur = st.meta.settings.route?.mode || 'auto';
  const line = (o) => {
    if (o.id === 'restructure') return '';
    if (o.id === 'triage') return `Parks ${o.skipIds.length} low-yield topic${o.skipIds.length === 1 ? '' : 's'} (${fmtMin(o.skippedMin)}), keeps about ${o.marksKeptPct}% of the marks in play. Around ${fmtMin(o.dailyMin)} a day.`;
    return `${fmtMin(o.dailyMin)} a day. ${o.eta ? `Forecast finish ${fmtDate(o.eta)}${o.lateByDays ? ` (${o.lateByDays} days after the exam)` : ''}.` : 'Finish date is far out.'} Covers about ${o.coveredPct}% by your deadline.`;
  };
  return `<div class="sheet-form">${close}
    <h2 class="serif">Pick a route</h2>
    <p class="muted">Like a GPS offering alternatives. There’s no wrong turn, and you can change this any time.</p>
    ${opts
      .map(
        (o) => `<div class="route ${cur === o.id ? 'cur' : ''}"><div><b>${o.label}</b><p class="muted">${esc(o.desc)}</p><p class="tiny">${esc(line(o))}</p></div>
        <button class="btn ${o.id === 'restructure' ? 'warn' : ''}" data-act="${o.id === 'restructure' ? 'bankrupt-open' : 'route-pick'}" data-id="${o.id}">${cur === o.id ? 'Current' : 'Use this'}</button></div>`
      )
      .join('')}
    ${cur !== 'auto' ? '<button class="link" data-act="route-pick" data-id="auto">Go back to the automatic route</button>' : ''}
  </div>`;
}

export function bankruptcySheet({ st, plan, recent, today = dstr() }) {
  const s = st.meta.settings;
  const open = liveTopics(st).filter((t) => !t.skip && (t.status === 'todo' || t.status === 'doing'));
  const suggested = routeOptions(st, today).find((o) => o.id === 'triage')?.skipIds || [];
  const exam = s.examDate || addDays(today, 60);
  const hasOwn = subjectsOf(st).some((x) => s.subjectExams && s.subjectExams[x]);
  return `<form data-form="bankrupt" class="sheet-form">${close}
    <h2 class="serif">Take a clean slate</h2>
    <p class="muted">Your old plan is archived (not deleted). Your streak goes to zero; your best streak (${st.meta.streak.best}) and ${fmtMin(plan.actualToday || 0)} logged on this plan stay in your history. Then I rebuild from what you actually manage.</p>
    ${recent ? '<p class="note">You took a clean slate recently. Before restarting, be honest on the minutes below: a smaller, believable number beats an ambitious one.</p>' : ''}
    <label class="field-l">${hasOwn ? 'Default exam date <span class="tiny muted">(for subjects without their own)</span>' : 'Exam date'}<input class="field" type="date" name="examDate" value="${esc(hasOwn ? s.examDate || '' : exam)}" ${hasOwn ? '' : 'required'}></label>
    <label class="field-l">Minutes you can realistically give on a normal office day<input class="field" type="number" name="weekdayMin" min="15" max="600" value="${Math.round(plan.capacity.value)}" required></label>
    <fieldset><legend>Park these for now <span class="muted">(suggested lowest-yield topics are ticked)</span></legend>
      <div class="checklist">${open.map((t) => `<label class="check"><input type="checkbox" name="skip" value="${t.id}" ${suggested.includes(t.id) ? 'checked' : ''}> ${esc(t.name)} <span class="tiny muted">· ${esc(t.subject)} · ${t.weightage}%</span></label>`).join('') || '<p class="muted">No open topics.</p>'}</div>
    </fieldset>
    <label class="check"><input type="checkbox" name="ack" required> I understand my streak resets to zero.</label>
    <div class="row"><button class="btn warn big" type="submit">Start fresh</button><button class="btn ghost" type="button" data-act="sheet-close">Not now</button></div>
  </form>`;
}

export function topicSheet({ topic }) {
  const t = topic || { subject: '', chapter: '', name: '', estMin: 60, weightage: 5, difficulty: 3, confidence: 3, status: 'todo', skip: false };
  return `<form data-form="topic" class="sheet-form">${close}
    <h2 class="serif">${topic ? 'Edit topic' : 'Add a topic'}</h2>
    <input type="hidden" name="id" value="${esc(topic?.id || '')}">
    <label class="field-l">Subject<input class="field" name="subject" required value="${esc(t.subject)}" placeholder="e.g. FAR"></label>
    <label class="field-l">Chapter<input class="field" name="chapter" value="${esc(t.chapter)}" placeholder="optional"></label>
    <label class="field-l">Topic name<input class="field" name="name" required value="${esc(t.name)}"></label>
    <div class="grid3">
      <label class="field-l">First pass (min)<input class="field" type="number" name="estMin" min="5" value="${t.estMin}"></label>
      <label class="field-l">Marks %<input class="field" type="number" name="weightage" min="0" max="100" step="0.5" value="${t.weightage}"></label>
      <label class="field-l">Difficulty 1–5<input class="field" type="number" name="difficulty" min="1" max="5" value="${t.difficulty}"></label>
    </div>
    <label class="field-l">Confidence 1–5<input class="field" type="number" name="confidence" min="1" max="5" value="${t.confidence}"></label>
    <label class="field-l">Status<select class="field" name="status">
      ${[['todo', 'Not started'], ['doing', 'In progress'], ['done', 'First pass done'], ['revised', 'Revised']].map(([v, l]) => `<option value="${v}" ${t.status === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <label class="check"><input type="checkbox" name="skip" ${t.skip ? 'checked' : ''}> Park this topic (leave it out of the route)</label>
    <div class="row"><button class="btn primary" type="submit">Save topic</button>${topic ? `<button class="btn ghost" type="button" data-act="topic-delete" data-id="${topic.id}">Delete</button>` : ''}</div>
  </form>`;
}

export function importSheet() {
  return `<form data-form="import" class="sheet-form">${close}
    <h2 class="serif">Import topics</h2>
    <p class="muted">Paste CSV with these columns (header row optional):<br><code>subject, chapter, name, estMin, weightage, difficulty</code><br>Optional last two columns: <code>status</code> (todo, doing, done, revised) and <code>confidence</code> (1-5). Handy if you are already mid-way.</p>
    <textarea class="field" name="csv" rows="9" placeholder="FAR,Leases,IFRS 16 Leases,210,8,4,done,3"></textarea>
    <div class="row"><button class="btn primary" type="submit">Import</button></div>
  </form>`;
}

export function onboardSheet({ st }) {
  const s = st.meta.settings;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const hasTopics = liveTopics(st).length > 0;
  return `<form data-form="onboard" class="sheet-form">
    <h2 class="serif">Let’s set your route</h2>
    <p class="muted">Four answers. You can change all of them later.</p>
    <p><button class="btn ghost" type="button" data-act="connect-open">I already use this app on another device</button></p>
    <label class="field-l">When is your exam? <span class="tiny muted">(each subject can get its own date later, in Settings)</span><input class="field" type="date" name="examDate" value="${esc(s.examDate)}" required></label>
    <label class="field-l">On a normal office day, how many minutes can you realistically study?<input class="field" type="number" name="baselineWeekdayMin" min="15" max="600" value="${s.baselineWeekdayMin}" required></label>
    <label class="field-l">Weekly rest day<select class="field" name="weeklyRestDay"><option value="-1">None</option>${days.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select></label>
    <label class="field-l">Your if-then sentence<input class="field" name="ifThen" maxlength="200" placeholder="If I finish dinner, then I tap START before picking up my phone."></label>
    ${hasTopics ? '' : '<label class="check"><input type="checkbox" name="sample" checked> Start with the sample syllabus (replace it with yours any time)</label>'}
    <div class="row"><button class="btn primary big" type="submit">Build my route</button></div>
  </form>`;
}

/** Connect to a Google Sheet before (or instead of) onboarding, for a second device. */
export function connectSheet({ conn }) {
  return `<form data-form="conn" class="sheet-form">
    ${close}
    <h2 class="serif">Connect your Google Sheet</h2>
    <p class="muted">Use the same Web App URL and token as on your other device. Your settings, topics and sessions will come from the Sheet, and you will not have to set anything up again.</p>
    <label class="field-l">Web App URL (ends with /exec)<input class="field" name="url" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(conn.url)}" required></label>
    <label class="field-l">Token (same as API_TOKEN in Code.gs)<input class="field" type="password" name="token" autocomplete="off" value="${esc(conn.token)}" required></label>
    <div class="row"><button class="btn primary big" type="submit">Connect</button><button class="btn ghost" type="button" data-act="onboard-open">Back</button></div>
  </form>`;
}

/** Both the Sheet and this device already hold data: never guess which one wins. */
export function firstConnectSheet() {
  return `<div class="sheet-form">
    <h2 class="serif">Your Sheet already has data</h2>
    <p class="muted">This device has data of its own too. Which one should I keep?</p>
    <p class="note">“Use the Sheet” replaces the topics, sessions and settings on this device with the ones in your Sheet. If you want a copy of what is here first, download a backup.</p>
    <div class="row"><button class="btn primary big" data-act="first-use-sheet">Use the Sheet</button></div>
    <div class="row"><button class="btn ghost" data-act="export">Download backup of this device</button><button class="btn ghost" data-act="first-cancel">Not now</button></div>
  </div>`;
}
