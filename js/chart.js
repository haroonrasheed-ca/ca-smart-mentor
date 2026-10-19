// Trajectory Reality Check: Ideal vs Actual vs Forecast (with an honest ±30% band), drawn as inline SVG.
// No chart library on purpose — works offline, themes via CSS variables.

import { addDays, diffDays, fmtDate, esc } from './utils.js';

export function paceChart(sr) {
  if (!sr) return '';
  const W = 640;
  const H = 300;
  const m = { l: 44, r: 14, t: 14, b: 30 };
  const x0 = sr.start;
  const lastPt = [...sr.forecast, ...sr.hi, ...sr.lo].map((p) => p.d).reduce((a, b) => (diffDays(a, b) > 0 ? b : a), sr.exam);
  let end = diffDays(sr.exam, lastPt) > 0 ? lastPt : sr.exam;
  if (diffDays(sr.exam, end) > 14) end = addDays(sr.exam, 14);
  const span = Math.max(1, diffDays(x0, end));
  const lastActual = sr.actual.length ? sr.actual[sr.actual.length - 1].y : 0;
  const yMax = Math.max(sr.total, sr.scope, lastActual, 60) * 1.08;
  const sx = (d) => m.l + (Math.max(0, Math.min(span, diffDays(x0, d))) / span) * (W - m.l - m.r);
  const sy = (y) => m.t + (1 - Math.min(y, yMax) / yMax) * (H - m.t - m.b);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.d).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');

  // y ticks in hours
  const hoursMax = yMax / 60;
  const rough = hoursMax / 4;
  const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => s >= rough) || 100;
  let grid = '';
  for (let h = 0; h <= hoursMax; h += step) {
    const y = sy(h * 60);
    grid += `<line class="ch-grid" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/><text class="ch-text" x="${m.l - 8}" y="${y + 4}" text-anchor="end">${h}h</text>`;
  }
  const ticks = [x0, addDays(x0, Math.round(span / 2)), sr.exam].filter((d, i, a) => a.indexOf(d) === i);
  const xl = ticks
    .map((d, i) => `<text class="ch-text" x="${sx(d)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}">${fmtDate(d)}</text>`)
    .join('');

  const band = sr.hi.length > 1 && sr.lo.length > 1 ? `<path class="ch-band" d="${path(sr.hi)}${[...sr.lo].reverse().map((p) => `L${sx(p.d).toFixed(1)},${sy(p.y).toFixed(1)}`).join('')}Z"/>` : '';
  const todayPt = sr.actual[sr.actual.length - 1];
  const aria = `Pace chart. Ideal reaches ${Math.round(sr.total / 60)} hours by ${fmtDate(sr.endIdeal)}. You have logged ${Math.round(lastActual / 60)} hours so far.`;

  return `<svg class="pace-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${aria}" preserveAspectRatio="xMidYMid meet">
  ${grid}
  <line class="ch-scope" x1="${m.l}" x2="${W - m.r}" y1="${sy(sr.scope)}" y2="${sy(sr.scope)}"/>
  <line class="ch-exam" x1="${sx(sr.exam)}" x2="${sx(sr.exam)}" y1="${m.t}" y2="${H - m.b}"/>
  <text class="ch-text ch-exam-label" x="${sx(sr.exam) - 6}" y="${m.t + 10}" text-anchor="end">${sr.exams && sr.exams.length > 1 ? esc(sr.exams[sr.exams.length - 1].subjects.join(' + ')) : 'Exam'}</text>
  ${(sr.exams || [])
    .slice(0, -1)
    .map((e, i) => `<line class="ch-exam" x1="${sx(e.d)}" x2="${sx(e.d)}" y1="${m.t}" y2="${H - m.b}"/><text class="ch-text ch-exam-label" x="${sx(e.d) - 6}" y="${m.t + 10 + 12 * (i + 1)}" text-anchor="end">${esc(e.subjects.join(' + '))}</text>`)
    .join('')}
  ${band}
  <path class="ch-ideal" d="${path(sr.ideal)}"/>
  <path class="ch-forecast" d="${path(sr.forecast)}"/>
  ${sr.actual.length > 1 ? `<path class="ch-actual" d="${path(sr.actual)}"/>` : ''}
  ${todayPt ? `<circle class="ch-now" cx="${sx(todayPt.d)}" cy="${sy(todayPt.y)}" r="5"/>` : ''}
  ${xl}
</svg>`;
}
