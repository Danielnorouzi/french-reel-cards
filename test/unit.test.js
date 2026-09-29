import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, preview, newCardState } from '../public/sm2.js';
import { toAnkiCsv, frontText } from '../public/anki.js';
import { extractVocab, tokenize } from '../server/vocab.js';
import { dedupeLines, parseTsv, looksLikeText } from '../server/ocr.js';

const DAY = 86_400_000;

test('SM-2: new card intervals for each button', () => {
  const now = 1_000_000;
  const c = newCardState(now);
  assert.equal(schedule(c, 'again', now).due - now, 60_000);
  assert.equal(schedule(c, 'hard', now).interval, 1);
  assert.equal(schedule(c, 'good', now).interval, 2);
  assert.equal(schedule(c, 'easy', now).interval, 4);
});

test('SM-2: intervals grow and ease adjusts', () => {
  let c = newCardState(0);
  c = { ...c, ...schedule(c, 'good', 0) };
  c = { ...c, ...schedule(c, 'good', 0) };
  assert.equal(c.interval, 6);
  const next = schedule(c, 'good', 0);
  assert.equal(next.interval, 15); // 6 * 2.5
  assert.equal(schedule(c, 'hard', 0).ease, 2.36);
  assert.equal(schedule(c, 'easy', 0).ease, 2.6);
  const lapse = schedule(c, 'again', 0);
  assert.equal(lapse.reps, 0);
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.ease, 2.3);
  assert.ok(schedule({ ...c, ease: 1.3 }, 'again', 0).ease >= 1.3);
  assert.deepEqual(preview(c, 0), { again: '1m', hard: '7d', good: '15d', easy: '20d' });
});

test('Anki CSV has headers, articles and escaped fields', () => {
  const csv = toAnkiCsv([
    { lemma: 'maison', word: 'maison', pos: 'noun', gender: 'f', meaning: 'house', example: 'à la maison, "chez nous"' },
    { lemma: 'aller', word: 'allait', pos: 'verb', gender: '', meaning: 'to go', example: 'on allait au cinéma', deck: 'Films' }
  ]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], '#separator:Comma');
  assert.ok(lines.includes('#html:true'));
  assert.ok(lines.includes('#deck column:4'));
  assert.ok(lines[5].startsWith('"une maison","house<br><i>noun · feminine</i>'));
  assert.ok(lines[5].includes('""chez nous""'));
  assert.ok(lines[5].endsWith('"Reel Cards"'));
  assert.ok(lines[6].includes('on <b>allait</b> au cinéma'));
  assert.ok(lines[6].endsWith('"Reel Cards::Films"'));
  assert.equal(frontText({ lemma: 'chat', pos: 'noun', gender: 'm' }), 'un chat');
});

test('vocab: lemmatizes, drops stopwords, keeps example sentence', () => {
  const cards = extractVocab(['Hier soir, on allait au cinéma', "mais ma copine était fatiguée"]);
  const byLemma = Object.fromEntries(cards.map(c => [c.lemma, c]));
  assert.ok(byLemma.aller, 'allait → aller');
  assert.equal(byLemma.aller.word, 'allait');
  assert.equal(byLemma.aller.example, 'Hier soir, on allait au cinéma');
  assert.equal(byLemma.copine.gender, 'f');
  assert.equal(byLemma.cinéma.gender, 'm');
  assert.match(byLemma.soir.meaning, /evening/);
  for (const stop of ['on', 'au', 'mais', 'ma', 'être', 'était']) assert.ok(!byLemma[stop], `${stop} should be skipped`);
});

test('vocab: skips words already known and uses context', () => {
  const cards = extractVocab(["Il fait beau et j'adore le fait", 'nos voisins'], { known: ['beau'] });
  const lemmas = cards.map(c => c.lemma);
  assert.ok(!lemmas.includes('beau'));
  assert.ok(lemmas.includes('faire'));   // "il fait" → verb
  assert.ok(lemmas.includes('fait'));    // "le fait" → noun
  assert.ok(lemmas.includes('adorer'));  // "j'adore" → elision handled
  assert.equal(cards.find(c => c.lemma === 'voisin').pos, 'noun');
});

test('tokenize handles apostrophes and aujourd’hui', () => {
  const toks = tokenize("Aujourd’hui c'est l'été").map(t => t.token);
  assert.deepEqual(toks, ["aujourd'hui", "c'", 'est', "l'", 'été']);
});

test('OCR helpers: TSV parsing, noise filter, dedupe', () => {
  const tsv = ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t96\tBonjour', '5\t1\t1\t1\t1\t2\t0\t0\t1\t1\t94\ttout', '5\t1\t1\t1\t1\t3\t0\t0\t1\t1\t91\tle',
    '5\t1\t1\t1\t1\t4\t0\t0\t1\t1\t90\tmonde', '5\t1\t2\t1\t1\t1\t0\t0\t1\t1\t20\tzzq', '5\t1\t2\t1\t1\t2\t0\t0\t1\t1\t80\tar'].join('\n');
  const lines = parseTsv(tsv);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Bonjour tout le monde');
  assert.ok(!looksLikeText('| — _ 1 2'));
  assert.ok(looksLikeText('Salut à tous'));
  const d = dedupeLines([
    { text: 'On allait au cinéma', conf: 90 }, { text: 'On allait au cinema', conf: 95 },
    { text: 'Mais ma copine', conf: 92 }, { text: 'On allait au cinéma ce soir', conf: 93 },
    { text: 'Alors on mangé une pizza', conf: 96 }, { text: 'Alors on a mangé une pizza', conf: 94 },
    { text: 'Alors on a mangé une pizza', conf: 95 }, { text: 'Alors on a mangé une p une pizza', conf: 95 }]);
  assert.deepEqual(d, ['On allait au cinéma ce soir', 'Mais ma copine', 'Alors on a mangé une pizza']);
  // short lines are not swallowed by longer ones, fragments whose words are all in a caption are
  assert.deepEqual(dedupeLines([{ text: 'le problème', conf: 90 }, { text: 'que je veux', conf: 90 }, { text: 'est que', conf: 80 },
    { text: "c'est que je veux", conf: 90 }]), ['le problème', "c'est que je veux"]);
});

test('OCR: stacked one-word lines merge into one caption', () => {
  const row = (block, y, h, conf, text) => `5\t1\t${block}\t1\t1\t1\t100\t${y}\t200\t${h}\t${conf}\t${text}`;
  const tsv = ['header', row(1, 250, 60, 48, 'le'), row(2, 348, 80, 95, 'problème'), row(3, 447, 60, 92, "c'est"),
    row(4, 742, 46, 73, 'un'), row(5, 640, 78, 96, 'toujours'), row(6, 1500, 60, 20, 'zz')].join('\n');
  assert.deepEqual(parseTsv(tsv).map(l => l.text), ["le problème c'est", 'toujours un']);
});

test('word-list import: base forms, gender from article, phrases, own meanings win', async () => {
  const { lookupWords } = await import('../server/vocab.js');
  const out = Object.fromEntries(lookupWords([
    { fr: 'la maison' }, { fr: 'allait' }, { fr: 'chats', en: 'cats!' }, { fr: 'avoir le cafard' }, { fr: 'zzqxw' }, { fr: 'la maison' }
  ]).map(c => [c.lemma, c]));
  assert.equal(out.maison.gender, 'f');
  assert.match(out.maison.meaning, /house/);
  assert.equal(out.aller.pos, 'verb');
  assert.equal(out.chat.meaning, 'cats!');
  assert.match(out['avoir le cafard'].meaning, /blue/);
  assert.equal(out.zzqxw.meaning, '');
  assert.equal(Object.keys(out).length, 5); // duplicate removed
});
