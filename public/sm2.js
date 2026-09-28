// SM-2 spaced repetition (SuperMemo 2), with the four Anki-style buttons.
// Again = 1, Hard = 3, Good = 4, Easy = 5 on the SM-2 0–5 quality scale.
export const GRADES = { again: 1, hard: 3, good: 4, easy: 5 };
const DAY = 86_400_000;
const RELEARN_MS = 60_000; // "Again" brings the card back in about a minute

export function newCardState(now = Date.now()) {
  return { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: now, lastReview: null };
}

export function schedule(card, grade, now = Date.now()) {
  const q = GRADES[grade];
  if (q === undefined) throw new Error('Unknown grade ' + grade);
  let { ease = 2.5, interval = 0, reps = 0, lapses = 0 } = card;

  if (q < 3) {
    return { ease: Math.max(1.3, +(ease - 0.2).toFixed(2)), interval: 0, reps: 0,
      lapses: lapses + (reps > 0 ? 1 : 0), due: now + RELEARN_MS, lastReview: now };
  }

  // classic SM-2 ease update
  ease = Math.max(1.3, +(ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))).toFixed(2));

  let next;
  if (reps === 0) next = q === 5 ? 4 : 1;
  else if (reps === 1) next = q === 3 ? 3 : q === 4 ? 6 : 8;
  else if (q === 3) next = Math.max(interval + 1, Math.round(interval * 1.2));
  else if (q === 4) next = Math.max(interval + 1, Math.round(interval * ease));
  else next = Math.max(interval + 2, Math.round(interval * ease * 1.3));

  return { ease, interval: next, reps: reps + 1, lapses, due: now + next * DAY, lastReview: now };
}

export function formatInterval(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(ms / DAY);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${+(d / 30).toFixed(1).replace(/\.0$/, '')}mo`;
  return `${+(d / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

// Button labels: how long until the card comes back for each choice.
export function preview(card, now = Date.now()) {
  const out = {};
  for (const g of Object.keys(GRADES)) out[g] = formatInterval(schedule(card, g, now).due - now);
  return out;
}
