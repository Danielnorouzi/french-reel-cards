import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { levelCode, nearestLevel, recommend, pickQuestions, shuffleOptions, record, topicProgress, levelProgress, mistakes, pickMistakes, pickMixed, MASTERED } from '../public/grammar.js';

const data = JSON.parse(fs.readFileSync(new URL('../public/grammar.json', import.meta.url)));
const inTopic = id => data.questions.filter(q => q.t === id);
const masterTopic = (stats, id, share = 1) => { const qs = inTopic(id); qs.slice(0, Math.ceil(qs.length * share)).forEach((q, i) => record(stats, q.id, true, 1000 + i)); };

test('grammar.json: every question is valid and belongs to a topic', () => {
  const topics = new Set(data.topics.map(t => t.id));
  assert.ok(data.questions.length >= 4000);
  const ids = new Set();
  for (const q of data.questions) {
    assert.ok(topics.has(q.t), q.id);
    assert.ok(!ids.has(q.id), `duplicate id ${q.id}`); ids.add(q.id);
    assert.ok(q.a >= 0 && q.a < q.o.length, q.id);
    assert.equal(new Set(q.o).size, q.o.length, `repeated option in ${q.id}`);
    assert.match(q.q, /_{2,}|:/, q.id);
    assert.ok(typeof data.x[q.e] === 'string' && data.x[q.e].length > 10, `explanation for ${q.id}`);
    const blanks = (q.q.match(/_{2,}/g) || []).length;
    if (blanks > 1) assert.equal(q.o[q.a].split(' / ').length, blanks, `two blanks need "a / b" answers: ${q.id}`);
  }
  for (const t of data.topics) assert.equal(t.count, inTopic(t.id).length);
});

test('grammar.json: five levels, every topic has 80+ questions, a lesson and a category', () => {
  assert.deepEqual([...new Set(data.topics.map(t => t.level))], ['A1', 'A2', 'B1', 'B2', 'C1']);
  assert.ok(data.topics.length >= 55);
  for (const t of data.topics) {
    assert.ok(t.count >= 80, `${t.id} has ${t.count}`);
    assert.ok(t.title && t.hint && t.glyph, t.id);
    assert.ok(data.categories[t.cat], `${t.id} category`);
    assert.ok(t.points.length >= 2 && t.examples.length >= 2, `${t.id} lesson`);
    const seen = new Set();
    for (const q of inTopic(t.id)) { const k = q.q + '|' + q.o[q.a]; assert.ok(!seen.has(k), `repeated question in ${t.id}: ${q.q}`); seen.add(k); }
  }
});

test('levels: profile text maps to the nearest level with questions', () => {
  assert.equal(levelCode('B1 · Intermediate'), 'B1');
  assert.equal(levelCode(''), null);
  const lv = ['A2', 'B1', 'B2'];
  assert.equal(nearestLevel('A1', lv), 'A2');
  assert.equal(nearestLevel('C2', lv), 'B2');
  assert.equal(nearestLevel(null, lv), 'A2');
});

test('recommend: starts at the profile level with its first topic', () => {
  const r = recommend(data, {}, 'B1 · Intermediate');
  assert.equal(r.level, 'B1');
  assert.equal(r.topic.id, data.topics.find(t => t.level === 'B1').id);
  assert.equal(recommend(data, {}, '').level, 'A1');
  assert.equal(recommend(data, {}, 'C1 · Advanced').level, 'C1');
  assert.equal(recommend(data, {}, 'C2 · Mastery').level, 'C1');
});

test('recommend: weak topic first, then moves up a level when all are mastered', () => {
  const stats = {};
  const a2 = data.topics.filter(t => t.level === 'A2');
  // 6 wrong answers in the 3rd A2 topic → it becomes the pick
  inTopic(a2[2].id).slice(0, 6).forEach(q => record(stats, q.id, false));
  assert.equal(recommend(data, stats, 'A2 · Elementary').topic.id, a2[2].id);
  for (const t of a2) masterTopic(stats, t.id);
  const r = recommend(data, stats, 'A2 · Elementary');
  assert.equal(r.level, 'B1');
  assert.match(r.reason, /A2/);
});

test('pickQuestions: missed ones come back, no duplicates', () => {
  const t = data.topics[0].id;
  const stats = {};
  const qs = inTopic(t);
  record(stats, qs[3].id, false, 5); record(stats, qs[7].id, true, 6);
  const picked = pickQuestions(t, data.questions, stats, 10);
  assert.equal(picked.length, 10);
  assert.equal(new Set(picked.map(q => q.id)).size, 10);
  assert.ok(picked.some(q => q.id === qs[3].id));
  assert.ok(!picked.some(q => q.id === qs[7].id)); // the unseen ones are preferred over one already right
});

test('shuffleOptions keeps the right answer and topicProgress counts mastery', () => {
  const q = data.questions[0];
  for (let i = 0; i < 20; i++) { const s = shuffleOptions(q); assert.equal(s.options[s.answer], q.o[q.a]); }
  const stats = {};
  masterTopic(stats, data.topics[0].id, 0.5);
  const p = topicProgress(data.topics[0], data.questions, stats);
  assert.equal(p.mastered, data.topics[0].count / 2); assert.equal(p.accuracy, 1); assert.equal(p.share, 0.5);
});

test('levelProgress counts mastered topics and partial progress', () => {
  const stats = {};
  const a1 = data.topics.filter(t => t.level === 'A1');
  assert.deepEqual(levelProgress('A1', data, stats), { topics: a1.length, mastered: 0, started: 0, share: 0 });
  masterTopic(stats, a1[0].id);            // fully mastered
  masterTopic(stats, a1[1].id, MASTERED / 2); // halfway to mastered
  const p = levelProgress('A1', data, stats);
  assert.equal(p.mastered, 1); assert.equal(p.started, 2);
  assert.ok(Math.abs(p.share - 1.5 / a1.length) < 0.01);
});

test('mistakes and mixed sessions', () => {
  const stats = {};
  const a1 = data.topics.filter(t => t.level === 'A1');
  const b1 = data.topics.find(t => t.level === 'B1');
  inTopic(a1[0].id).slice(0, 4).forEach((q, i) => record(stats, q.id, false, 10 + i));
  inTopic(a1[0].id).slice(4, 8).forEach((q, i) => record(stats, q.id, true, 20 + i));
  record(stats, inTopic(b1.id)[0].id, false, 5);
  assert.equal(mistakes(data, stats).length, 5);
  assert.equal(mistakes(data, stats, 'A1').length, 4);
  assert.equal(mistakes(data, stats)[0].t, b1.id); // oldest first
  assert.equal(pickMistakes(data, stats, 10, 'A1').length, 4);
  const mixed = pickMixed('A1', data, stats, 10);
  assert.equal(mixed.length, 10);
  assert.equal(new Set(mixed.map(q => q.id)).size, 10);
  const a1ids = new Set(a1.map(t => t.id));
  assert.ok(mixed.every(q => a1ids.has(q.t)));
  assert.equal(mixed.filter(q => stats[q.id] && !stats[q.id].k).length, 4); // all four mistakes come back
  assert.ok(mixed.filter(q => !stats[q.id]).every(q => q.t === a1[0].id)); // new ones come from the topic already started
  assert.equal(pickMixed('C1', data, {}, 10).length, 10); // nothing started: still a full session
});

const vocab = JSON.parse(fs.readFileSync(new URL('../public/vocab.json', import.meta.url)));
test('vocab.json: about 500 words per level, no repeats, valid types', () => {
  assert.deepEqual(vocab.levels.map(l => l.level), ['A1', 'A2', 'B1', 'B2', 'C1']);
  const seen = new Set(), themeIds = new Set();
  for (const l of vocab.levels) {
    const n = l.themes.reduce((s, t) => s + t.words.length, 0);
    assert.ok(n >= 480 && n <= 560, `${l.level} has ${n} words`);
    for (const t of l.themes) {
      assert.ok(t.title && t.icon && t.words.length >= 20, t.id);
      assert.ok(!themeIds.has(t.id), t.id); themeIds.add(t.id);
      for (const [fr, en, pos, gender, ex] of t.words) {
        assert.ok(fr && en && ex, `${t.id}: ${fr}`);
        assert.ok(['noun', 'verb', 'adj', 'adv', 'phrase', 'prep', 'conj', 'pron', 'num', 'intj'].includes(pos), `${fr}: ${pos}`);
        assert.ok(['', 'm', 'f', 'm/f'].includes(gender), fr);
        assert.ok(!seen.has(fr.toLowerCase()), `repeated word ${fr}`); seen.add(fr.toLowerCase());
      }
    }
  }
});
