// Combines the grammar quiz files in data/grammar/*.json into one compact public/grammar.json
// that the app downloads once and keeps offline. Run: npm run build-grammar
// Drop a new file with the same shape into data/grammar/ and rebuild: new topics appear automatically.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'data', 'grammar');
const OUT = path.join(ROOT, 'public', 'grammar.json');

// Friendly names, a one-line hint, and the order a learner would meet them in.
const META = {
  // A2
  present: ['Present tense', 'Everyday verbs: je parle, tu finis, il prend'],
  articles: ['Articles', 'du, de la, de l’, des'],
  adjective_agreement: ['Adjective agreement', 'petit → petite, cher → chère'],
  negation: ['Negation', 'ne … pas and friends'],
  place_prepositions: ['Places: à, en, au, aux', 'à Paris, en France, au Canada'],
  futur_proche: ['Futur proche', 'aller + infinitive: je vais parler'],
  passe_compose: ['Passé composé', 'avoir or être + past participle'],
  object_pronouns: ['Object pronouns', 'le, la, les, lui, leur'],
  // B1
  imparfait_vs_passe_compose: ['Imparfait vs passé composé', 'Background vs single events'],
  futur_simple: ['Futur simple', 'je parlerai, tu finiras'],
  conditionnel_present: ['Conditionnel présent', 'Would: je parlerais'],
  plus_que_parfait: ['Plus-que-parfait', 'The past before the past: j’avais parlé'],
  pronoun_y: ['The pronoun y', 'Replaces à + thing, or a place'],
  pronoun_en: ['The pronoun en', 'Replaces de + noun, or a quantity'],
  relative_pronouns: ['Relative pronouns', 'qui, que, où, dont'],
  subjonctif_present: ['Subjonctif présent', 'il faut que je fasse'],
  // B2
  double_object_pronouns: ['Double pronouns', 'le lui, la leur, les lui'],
  compound_relative_pronouns: ['lequel, auquel, duquel', 'Relative pronouns after prepositions'],
  conditionnel_passe: ['Conditionnel passé', 'Would have: j’aurais parlé'],
  connectors: ['Connectors', 'bien que, malgré, puisque, pour que']
};
const ORDER = Object.keys(META);
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const titleCase = s => s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

const topics = new Map();
const questions = [];
const seen = new Set();
for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.json')).sort()) {
  const { questions: qs = [] } = JSON.parse(fs.readFileSync(path.join(SRC, file), 'utf8'));
  for (const q of qs) {
    const ok = q.id && q.topic && q.question && Array.isArray(q.options) && q.options.length >= 2
      && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length && LEVELS.includes(q.level);
    if (!ok) { console.warn(`skip ${file}: ${q.id || '(no id)'}`); continue; }
    if (seen.has(q.id)) { console.warn(`skip duplicate id ${q.id}`); continue; }
    seen.add(q.id);
    const key = `${q.level}:${q.topic}`;
    if (!topics.has(key)) {
      const [title, hint] = META[q.topic] || [titleCase(q.topic), ''];
      topics.set(key, { id: key, topic: q.topic, level: q.level, title, hint, count: 0 });
    }
    topics.get(key).count++;
    questions.push({ id: q.id, t: key, q: q.question, o: q.options, a: q.answer, e: q.explanation || '' });
  }
}
const rank = t => [LEVELS.indexOf(t.level), ORDER.includes(t.topic) ? ORDER.indexOf(t.topic) : 999, t.topic];
const list = [...topics.values()].sort((x, y) => {
  const a = rank(x), b = rank(y);
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
});
const out = { version: 1, topics: list, questions };
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`grammar.json: ${list.length} topics, ${questions.length} questions, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
