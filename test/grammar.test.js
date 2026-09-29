import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { levelCode, nearestLevel, recommend, pickQuestions, shuffleOptions, record, topicProgress } from '../public/grammar.js';

const data = JSON.parse(fs.readFileSync(new URL('../public/grammar.json', import.meta.url)));
const inTopic = id => data.questions.filter(q => q.t === id);
const masterTopic = (stats, id, share = 1) => { const qs = inTopic(id); qs.slice(0, Math.ceil(qs.length * share)).forEach((q, i) => record(stats, q.id, true, 1000 + i)); };

test('grammar.json: every question is valid and belongs to a topic', () => {
  const topics = new Set(data.topics.map(t => t.id));
  assert.ok(data.questions.length >= 1000);
  for (const q of data.questions) {
    assert.ok(topics.has(q.t), q.id);
    assert.ok(q.a >= 0 && q.a < q.o.length, q.id);
    assert.match(q.q, /_{2,}|:/, q.id);
  }
  for (const t of data.topics) assert.equal(t.count, inTopic(t.id).length);
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
  assert.equal(recommend(data, {}, '').level, 'A2');
  assert.equal(recommend(data, {}, 'C1 · Advanced').level, 'B2');
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
  assert.ok(!picked.some(q => q.id === qs[7].id)); // 48 unseen are preferred over one already right
});

test('shuffleOptions keeps the right answer and topicProgress counts mastery', () => {
  const q = data.questions[0];
  for (let i = 0; i < 20; i++) { const s = shuffleOptions(q); assert.equal(s.options[s.answer], q.o[q.a]); }
  const stats = {};
  masterTopic(stats, data.topics[0].id, 0.5);
  const p = topicProgress(data.topics[0], data.questions, stats);
  assert.equal(p.mastered, 25); assert.equal(p.accuracy, 1); assert.equal(p.share, 0.5);
});
