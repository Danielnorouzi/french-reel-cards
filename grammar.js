// Grammar practice logic (pure functions, no DOM) so it can be unit-tested in Node.
// stats: { [questionId]: { c: timesCorrect, w: timesWrong, l: lastAnsweredMs, k: 1|0 lastResult } }

export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
export const MASTERED = 0.8; // a topic counts as done at 80% of its questions last answered right

// "B1 · Intermediate" → "B1"; empty → null
export function levelCode(profileLevel) {
  const m = String(profileLevel || '').match(/\b([ABC][12])\b/i);
  return m ? m[1].toUpperCase() : null;
}

// the closest level we actually have questions for (A1 → A2, C1 → B2)
export function nearestLevel(code, available) {
  if (!available.length) return null;
  if (!code) return available[0];
  if (available.includes(code)) return code;
  const i = LEVELS.indexOf(code);
  return [...available].sort((a, b) => Math.abs(LEVELS.indexOf(a) - i) - Math.abs(LEVELS.indexOf(b) - i)
    || LEVELS.indexOf(a) - LEVELS.indexOf(b))[0];
}

export function topicProgress(topic, questions, stats) {
  let seen = 0, mastered = 0, right = 0, total = 0, last = 0;
  for (const q of questions) {
    if (q.t !== topic.id) continue;
    const s = stats[q.id];
    if (!s) continue;
    seen++;
    if (s.k) mastered++;
    right += s.c; total += s.c + s.w;
    last = Math.max(last, s.l || 0);
  }
  return {
    seen, mastered, count: topic.count,
    share: topic.count ? mastered / topic.count : 0,
    accuracy: total ? right / total : null,
    last
  };
}

// Picks one topic for "Recommended for you" and says why.
export function recommend(data, stats, profileLevel) {
  const levels = [...new Set(data.topics.map(t => t.level))].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
  const start = nearestLevel(levelCode(profileLevel), levels);
  if (!start) return null;
  const prog = new Map(data.topics.map(t => [t.id, topicProgress(t, data.questions, stats)]));
  const unfinished = lvl => data.topics.filter(t => t.level === lvl && prog.get(t.id).share < MASTERED);

  let level = start, pool = unfinished(level), movedUp = false;
  for (let i = levels.indexOf(start) + 1; !pool.length && i < levels.length; i++) { level = levels[i]; pool = unfinished(level); movedUp = true; }
  if (!pool.length) { // everything mastered: review the topic answered longest ago at their level
    const t = data.topics.filter(x => x.level === start).sort((a, b) => prog.get(a.id).last - prog.get(b.id).last)[0];
    return { topic: t, progress: prog.get(t.id), level: start, reason: 'You’ve mastered every topic. Keep it fresh.' };
  }
  const pick = (topic, reason) => ({ topic, progress: prog.get(topic.id), level, reason });
  const weak = pool.filter(t => { const p = prog.get(t.id); return p.seen >= 5 && p.accuracy !== null && p.accuracy < 0.7; })
    .sort((a, b) => prog.get(a.id).accuracy - prog.get(b.id).accuracy)[0];
  if (weak) return pick(weak, `Your trickiest topic so far: ${Math.round(prog.get(weak.id).accuracy * 100)}% correct.`);
  const going = pool.filter(t => prog.get(t.id).seen > 0).sort((a, b) => prog.get(b.id).last - prog.get(a.id).last)[0];
  if (going) return pick(going, 'Pick up where you left off.');
  const fresh = pool[0];
  if (movedUp) return pick(fresh, `You’ve got ${start} down. Time for ${level}.`);
  return pick(fresh, levelCode(profileLevel) ? `Next up for ${level}.` : `A good place to start. Set your level in Profile for better picks.`);
}

// n questions for one topic: ones you got wrong, then unseen, then the ones answered longest ago.
export function pickQuestions(topicId, questions, stats, n = 10, rand = Math.random) {
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pool = questions.filter(q => q.t === topicId);
  const wrong = pool.filter(q => stats[q.id] && !stats[q.id].k).sort((a, b) => stats[a.id].l - stats[b.id].l);
  const unseen = shuffle(pool.filter(q => !stats[q.id]));
  const right = pool.filter(q => stats[q.id]?.k).sort((a, b) => stats[a.id].l - stats[b.id].l);
  const take = [...wrong.slice(0, Math.ceil(n / 2)), ...unseen, ...wrong.slice(Math.ceil(n / 2)), ...right].slice(0, n);
  return shuffle(take);
}

// Shuffled option order that remembers which one is right.
export function shuffleOptions(q, rand = Math.random) {
  const idx = q.o.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return { options: idx.map(i => q.o[i]), answer: idx.indexOf(q.a) };
}

export function record(stats, id, correct, now = Date.now()) {
  const s = stats[id] || { c: 0, w: 0, l: 0, k: 0 };
  if (correct) s.c++; else s.w++;
  s.l = now; s.k = correct ? 1 : 0;
  stats[id] = s;
  return stats;
}
