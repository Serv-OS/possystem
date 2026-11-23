// src/lib/hq/checkinWeek.js
//
// Weekly check ins: which week a check in belongs to, the default questions, and the shape
// of an answer set. Pure, tested in checkinWeek.test.js.
//
// A week starts on Monday (ISO) unless the company says otherwise. The owner reads every
// check in; a director reads only their own. That rule lives in the database
// (hq_checkins_select); canReadCheckin mirrors it for the screen.

/** 'YYYY-MM-DD' of the week's first day for a date, weeks starting on startDow (1 = Monday). */
export function weekStartIso(date = new Date(), startDow = 1) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(`${String(date).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getDay();
  const back = (dow - startDow + 7) % 7;
  d.setDate(d.getDate() - back);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

/** "Week of Nov 16 to Nov 22" (en-US) or "Week of 16 Nov to 22 Nov" (en-GB). */
export function weekLabel(weekStart, locale = 'en-US') {
  if (!weekStart) return '';
  const a = new Date(`${weekStart}T12:00:00`);
  const b = new Date(a.getTime()); b.setDate(b.getDate() + 6);
  const f = (x) => x.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return `Week of ${f(a)} to ${f(b)}`;
}

/** The six questions Mozz asked for. The owner can change them on the inbox screen. */
export const DEFAULT_QUESTIONS = Object.freeze([
  { id: 'needle', label: 'What moved the needle this week?', hint: 'Wins, numbers, momentum.', type: 'text' },
  { id: 'off_plan', label: 'Where are we off plan, and what is your fix?', hint: 'Be specific about the number and the correction.', type: 'text' },
  { id: 'shout_out', label: 'Who on your team earned a shout out?', hint: '', type: 'text' },
  { id: 'need', label: 'What do you need from me this week?', hint: '', type: 'text' },
  { id: 'confidence', label: "Confidence in hitting this month's prime cost target", hint: '1 = no chance, 5 = locked in.', type: 'score5' },
  { id: 'issue', label: 'Any guest or team issue I should hear from you first?', hint: 'Answer what applies, leave the rest blank.', type: 'text' },
]);

/** Questions as stored, or the defaults when the company has none. Drops rows with no label. */
export function normaliseQuestions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = list
    .map((q, i) => ({
      id: String(q?.id || `q${i + 1}`).trim(),
      label: String(q?.label || '').trim(),
      hint: String(q?.hint || '').trim(),
      type: q?.type === 'score5' ? 'score5' : 'text',
    }))
    .filter((q) => q.label);
  return out.length ? out : [...DEFAULT_QUESTIONS];
}

/** Answers cleaned for saving: text trimmed, scores whole numbers 1 to 5, unknown keys dropped. */
export function cleanAnswers(answers, questions) {
  const out = {};
  for (const q of questions || []) {
    const v = answers?.[q.id];
    if (q.type === 'score5') {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= 5) out[q.id] = n;
    } else {
      const s = String(v ?? '').trim();
      if (s) out[q.id] = s;
    }
  }
  return out;
}

/** The score the card and the morale figure read: the first score5 answer, or null. */
export function scoreOf(answers, questions) {
  const q = (questions || []).find((x) => x.type === 'score5');
  const n = q ? Number(answers?.[q.id]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/** True when at least one answer was given. */
export function hasAnswers(cleaned) {
  return Object.keys(cleaned || {}).length > 0;
}

/** The screen's copy of the database rule. */
export function canReadCheckin(row, userId, isOwner) {
  if (!row) return false;
  return Boolean(isOwner) || (Boolean(userId) && row.author_id === userId);
}
