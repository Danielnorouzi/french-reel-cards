// Combines the grammar quiz files in data/grammar/*.json into one compact public/grammar.json
// that the app downloads once and keeps offline. Run: npm run build-grammar
// Drop a new file with the same shape into data/grammar/ and rebuild: new topics appear automatically.
// Titles, hints, tile glyphs and the mini lessons live in scripts/grammar-topics.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPICS, CATEGORIES } from './grammar-topics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'grammar');
const OUT = path.join(ROOT, 'public', 'grammar.json');

const ORDER = Object.keys(TOPICS);
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const titleCase = s => s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

const topics = new Map();
const questions = [];
const seen = new Set();
const explanations = [];           // each distinct explanation is stored once
const explIndex = new Map();
const expl = text => {
  if (!explIndex.has(text)) { explIndex.set(text, explanations.length); explanations.push(text); }
  return explIndex.get(text);
};

for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.json')).sort()) {
  const { questions: qs = [] } = JSON.parse(fs.readFileSync(path.join(SRC, file), 'utf8'));
  for (const q of qs) {
    const ok = q.id && q.topic && q.question && Array.isArray(q.options) && q.options.length >= 2
      && new Set(q.options).size === q.options.length
      && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length && LEVELS.includes(q.level);
    if (!ok) { console.warn(`skip ${file}: ${q.id || '(no id)'}`); continue; }
    if (seen.has(q.id)) { console.warn(`skip duplicate id ${q.id}`); continue; }
    seen.add(q.id);
    const key = `${q.level}:${q.topic}`;
    if (!topics.has(key)) {
      const m = TOPICS[q.topic] || {};
      if (!TOPICS[q.topic]) console.warn(`no entry in grammar-topics.mjs for "${q.topic}"`);
      topics.set(key, { id: key, topic: q.topic, level: q.level, title: m.t || titleCase(q.topic), hint: m.h || '',
        cat: m.c || 'sentence', glyph: m.g || q.topic.slice(0, 3), points: m.p || [], examples: m.x || [], count: 0 });
    }
    topics.get(key).count++;
    questions.push({ id: q.id, t: key, q: q.question, o: q.options, a: q.answer, e: expl(q.explanation || '') });
  }
}
const rank = t => [LEVELS.indexOf(t.level), ORDER.includes(t.topic) ? ORDER.indexOf(t.topic) : 999, t.topic];
const list = [...topics.values()].sort((x, y) => {
  const a = rank(x), b = rank(y);
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
});
// keep each topic's questions together, in topic order (smaller file, faster lookups)
const pos = new Map(list.map((t, i) => [t.id, i]));
questions.sort((a, b) => pos.get(a.t) - pos.get(b.t));

const out = { version: 2, categories: CATEGORIES, topics: list, x: explanations, questions };
fs.writeFileSync(OUT, JSON.stringify(out));
const perLevel = LEVELS.map(l => [l, list.filter(t => t.level === l)]).filter(([, ts]) => ts.length)
  .map(([l, ts]) => `${l}: ${ts.length} topics / ${ts.reduce((n, t) => n + t.count, 0)} questions`).join(' · ');
console.log(`grammar.json: ${list.length} topics, ${questions.length} questions, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
console.log(perLevel);
