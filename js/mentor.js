// The mentor's voice. Rule: Observation → Normalisation → One action.
// Never says "failed". Never shames. Numbers are shown in "days of pace", not "hours of debt".

import { fmtMin, fmtDate, plural } from './utils.js';

const days = (n) => plural(Math.abs(Math.round(n * 10) / 10), 'day');

/** Main status card on Morning / Pace. tone: good | soft | warm */
export function statusCard(plan) {
  const t = plan.targetToday;
  switch (plan.status) {
    case 'setup':
      return { tone: 'soft', title: 'Let’s plot your route', body: 'Add your exam date and topics. I will do the arithmetic so you never have to.' };
    case 'done':
      return { tone: 'good', title: 'Everything is covered', body: 'All first passes and revisions on your list are done. Keep a few mocks warm.' };
    case 'window_closed':
      return { tone: 'soft', title: 'Revision buffer has started', body: 'No new topics now. Short, steady revision is the whole job from here.' };
    case 'needs_route':
      return {
        tone: 'warm',
        title: 'Your route needs a decision',
        body: `The full syllabus asks for ${fmtMin(plan.unitPace)} a day. You’ve shown you can sustain ${fmtMin(plan.capacity.value)}. That is a plan problem, not a you problem. Pick a route.`
      };
    case 'ahead':
      return { tone: 'good', title: 'Ahead of plan', body: `About ${days(plan.gapDays)} ahead. Keep the rhythm: ${fmtMin(t)} tonight is plenty.` };
    case 'behind':
      if (plan.multi && plan.worst && Math.abs(plan.gapDays) < 1) {
        return {
          tone: 'warm',
          title: 'One exam is tight',
          body: `${plan.worst.subjects.join(' + ')} (exam ${fmtDate(plan.worst.examDate)}) is the one at risk. ${fmtMin(plan.unitTarget)} a day keeps it safe.`
        };
      }
      return {
        tone: 'warm',
        title: 'Route recalculated',
        body: `About ${days(plan.gapDays)} of pace behind. That’s normal in audit season and it’s fixable: ${fmtMin(plan.unitTarget)} a day closes it.`
      };
    default:
      return { tone: 'good', title: 'On track', body: `Route unchanged. Tonight’s target is ${fmtMin(t)}.` };
  }
}

export function headline(plan) {
  if (plan.status === 'setup') return 'Set your exam date to see your forecast.';
  if (plan.status === 'done') return 'Syllabus covered. Revision is the only job left.';
  if (!plan.etaDate) {
    if (plan.velocity.provisional) return 'Log a few sessions and I’ll forecast your finish date.';
    if (plan.multi && plan.worst) return `At this pace ${plan.worst.subjects.join(' + ')} finishes far after its exam. Your route options can fix that.`;
    return 'At this pace the finish date is far out. Your route options can fix that.';
  }
  const margin = Math.round((new Date(plan.examDate) - new Date(plan.etaDate)) / 86400000);
  if (plan.multi && plan.worst) {
    const who = plan.worst.subjects.join(' + ');
    if (margin > 0) return `At this pace ${who} finishes ${days(margin)} before its exam, the tightest of your exams.`;
    if (margin === 0) return `At this pace ${who} finishes right on its exam day.`;
    return `At this pace ${who} finishes about ${days(margin)} after its exam. Your route can close that.`;
  }
  if (margin > 0) return `At this pace you finish ${days(margin)} before your exam.`;
  if (margin === 0) return 'At this pace you finish right on exam day.';
  return `At this pace you finish about ${days(margin)} after your exam. Your route can close that.`;
}

export function eveningMessage(energy, target, plan) {
  if (energy === 'red') return `Battery empty, noted. Maintenance mode: ${fmtMin(target)} keeps your streak alive and nothing more is expected.`;
  if (energy === 'amber') return `Half battery. Tonight is scaled to about ${fmtMin(target)}, and that is still a real win.`;
  if (energy === 'green') return `Full battery. Tonight’s target is ${fmtMin(target)}. Starting is the only hard part.`;
  if (plan.targetToday === 0) return 'Rest day on your route. Tap START only if you feel like it.';
  return 'Tap START. Choose your battery after, or not at all.';
}

export function nightMessage(todayMin, target, energy) {
  if (target > 0 && todayMin >= target) return `Target done: ${fmtMin(todayMin)} banked today. Sleep well, your brain files it overnight.`;
  if (todayMin > 0) return `You showed up for ${fmtMin(todayMin)}${energy === 'red' ? ' on an empty battery' : ''}. The route adjusts itself tomorrow.`;
  return 'No session today, and that is data, not a verdict. Tell me what got in the way and tomorrow’s route adjusts.';
}

export function milestone(sec) {
  if (sec >= 600) return '10 minutes banked. Keep going or stop, both count.';
  if (sec >= 300) return '5 minutes in. You’re officially studying.';
  if (sec >= 120) return '2 minutes in. The hardest part is behind you.';
  return '';
}

export function completeMessage(minutes) {
  if (minutes >= 45) return `${fmtMin(minutes)} of real work. That moves the finish line.`;
  if (minutes >= 20) return `${fmtMin(minutes)} banked. Solid.`;
  return `${fmtMin(minutes)} banked. Starting is what counts.`;
}

/** Compare today's plan with the previous day's snapshot. */
export function recalcNotice(plans) {
  const list = Object.values(plans || {}).filter((p) => !p.deleted).sort((a, b) => a.createdAt - b.createdAt);
  if (list.length < 2) return 'Route is set. I’ll update it every night.';
  const prev = list[list.length - 2];
  const cur = list[list.length - 1];
  const delta = Math.round((cur.targetMin || 0) - (prev.targetMin || 0));
  if (delta >= 5) return `Tomorrow’s route updated: +${delta} min a day${cur.eta ? `, forecast finish ${fmtDate(cur.eta)}` : ''}.`;
  if (delta <= -5) return `Tomorrow’s route updated: ${delta} min a day. You’re making it easier on yourself.`;
  return 'Route unchanged. Same plan tomorrow.';
}
