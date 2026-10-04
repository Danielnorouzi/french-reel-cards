import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, backupToText, readBackup, lockBackup, unlockBackup, mergeData, sanitizeData, summarize, isEmptyData, backupFileName, BackupError, BACKUP_FORMAT } from '../public/backup.js';

const DAY = 86_400_000;
const card = (lemma, extra = {}) => ({ id: 'id-' + lemma, lemma, word: lemma, pos: 'noun', gender: 'f', meaning: 'm-' + lemma, example: '',
  createdAt: 1000, setId: null, ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 1000, lastReview: null, ...extra });
const phone = () => ({
  cards: [card('maison', { setId: 's1', interval: 30, reps: 5, lastReview: 50 * DAY, due: 80 * DAY }), card('chat'), card('aller', { pos: 'verb', gender: '' })],
  meta: {
    profile: { avatar: 'panda', name: 'Daniel', age: '20', native: 'English', level: 'B1 · Intermediate', goal: 30, location: 'Vancouver', why: 'Paris', since: 500 },
    activity: { '2026-09-30': { r: 12, a: 2, n: 3 }, '2026-10-01': { r: 20, a: 1, n: 0 }, '2026-10-03': { r: 5, a: 0, n: 1 } },
    sets: [{ id: 's1', name: 'Home', createdAt: 900 }],
    grammar: { 'a1-etre_avoir-001': { c: 3, w: 1, l: 777, k: 1 } },
    direction: 'en-fr', reviewSet: 's1', lastSetId: 's1', grammarPane: 'vocab', quizLen: 20, verbRecent: ['aller', 'être']
  }
});

test('backup: a file carries cards, schedule, stats and profile and reads back identical', () => {
  const backup = buildBackup(phone(), { now: 123456, from: 'french-reel-cards.onrender.com' });
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.deepEqual(backup.summary, { cards: 3, mastered: 1, sets: 1, reviews: 37, daysStudied: 3, longestStreak: 2, grammarAnswers: 4, name: 'Daniel' });
  const read = readBackup(backupToText(backup));
  assert.equal(read.locked, false);
  assert.equal(read.backup.createdAt, 123456);
  assert.equal(read.backup.from, 'french-reel-cards.onrender.com');
  assert.deepEqual(read.backup.data, phone());
  assert.match(backupFileName(new Date(2026, 9, 4).getTime()), /^reel-cards-backup-2026-10-04\.json$/);
});

test('backup: password lock hides the data and only the right password opens it', async () => {
  const backup = buildBackup(phone(), { now: 5 });
  const text = backupToText(await lockBackup(backup, 'croissant', { iterations: 1000 }));
  assert.ok(!text.includes('maison') && !text.includes('Daniel') && !text.includes('Vancouver'));
  const read = readBackup(text);
  assert.equal(read.locked, true);
  await assert.rejects(unlockBackup(read.file, 'baguette'), e => e instanceof BackupError && e.code === 'wrong-password');
  const opened = await unlockBackup(read.file, 'croissant');
  assert.deepEqual(opened.data, phone());
  assert.equal(opened.summary.cards, 3);
  await assert.rejects(lockBackup(backup, ''), BackupError);
});

test('backup: files that are not backups are refused with a clear message', () => {
  for (const [text, code] of [['', 'empty'], ['Front,Back\nmaison,house', 'not-json'], ['{"cards":[]}', 'not-backup'], ['[1,2]', 'not-backup'],
    [JSON.stringify({ app: 'french-reel-cards', kind: 'backup', format: 99, data: {} }), 'too-new'],
    [JSON.stringify({ app: 'french-reel-cards', kind: 'backup', format: 1 }), 'no-data']]) {
    assert.throws(() => readBackup(text), e => e instanceof BackupError && e.code === code, code);
  }
});

test('backup: odd values in a file are cleaned before they reach the database', () => {
  const { cards, meta } = sanitizeData({
    cards: [card('maison'), card('maison', { id: 'dupe' }), { lemma: '' }, null, 'x',
      { id: 'id-maison', lemma: 'pomme', ease: 'abc', interval: -4, reps: '3', due: null, setId: 'ghost', meaning: { evil: 1 }, relearning: true, extra: 'kept', nested: { a: 1 } }],
    meta: { profile: { name: 'x'.repeat(100), goal: 'lots' }, activity: { 'not-a-day': { r: 5 }, '2026-10-01': { r: -3, a: 'x', n: 2.6 } },
      sets: [{ id: 's1', name: ' Home ' }, { id: 's1', name: 'Again' }, { name: 'no id' }], grammar: { q1: { c: '2', w: null }, q2: 'bad' },
      direction: 'sideways', inboxCode: 'secret', conjCache: { a: 1 } }
  }, 42);
  assert.equal(cards.length, 2);
  const pomme = cards[1];
  assert.notEqual(pomme.id, 'id-maison');                       // ids stay unique
  assert.deepEqual([pomme.ease, pomme.interval, pomme.reps, pomme.due, pomme.setId, pomme.extra], [2.5, 0, 3, 42, null, 'kept']);
  assert.equal(typeof pomme.meaning, 'string');
  assert.ok(!('relearning' in pomme) && !('nested' in pomme));
  assert.equal(meta.profile.name.length, 40);
  assert.equal(meta.profile.goal, 20);
  assert.deepEqual(meta.activity, { '2026-10-01': { r: 0, a: 0, n: 3 } });
  assert.deepEqual(meta.sets.map(s => s.name), ['Home']);
  assert.deepEqual(meta.grammar, { q1: { c: 2, w: 0, l: 0, k: 0 } });
  assert.ok(!('direction' in meta) && !('inboxCode' in meta) && !('conjCache' in meta));
  assert.ok(isEmptyData({ cards: [], meta: { profile: {} } }) && !isEmptyData({ cards, meta }));
});

test('backup: merging adds new words, keeps the newer progress and never double counts', () => {
  const here = {
    cards: [card('maison', { id: 'local1', lastReview: 60 * DAY, interval: 45, setId: null, meaning: '' }), card('pain', { id: 'id-chat', setId: 'L1' })],
    meta: {
      profile: { avatar: 'dog', name: '', age: '', native: '', level: '', goal: 20, location: '', why: '', since: 9000 },
      activity: { '2026-10-01': { r: 8, a: 4, n: 1 }, '2026-10-04': { r: 6, a: 0, n: 1 } },
      sets: [{ id: 'L1', name: 'home', createdAt: 1 }],
      grammar: { 'a1-etre_avoir-001': { c: 1, w: 0, l: 999, k: 1 }, 'a1-x-002': { c: 1, w: 1, l: 1, k: 0 } },
      direction: 'fr-en', verbRecent: ['être', 'faire']
    }
  };
  const { data, report } = mergeData(here, phone());
  assert.deepEqual(report, { added: 2, updated: 0, kept: 1, setsAdded: 0 });
  assert.equal(data.cards.length, 4);
  assert.equal(new Set(data.cards.map(c => c.id)).size, 4);
  const maison = data.cards.find(c => c.lemma === 'maison');
  assert.deepEqual([maison.id, maison.interval, maison.setId, maison.meaning], ['local1', 45, 'L1', 'm-maison']); // newer review wins, gaps filled, sets joined by name
  assert.deepEqual(data.meta.sets, [{ id: 'L1', name: 'home', createdAt: 1 }]);
  assert.deepEqual(data.meta.activity['2026-10-01'], { r: 20, a: 4, n: 1 });
  assert.deepEqual(Object.keys(data.meta.activity).sort(), ['2026-09-30', '2026-10-01', '2026-10-03', '2026-10-04']);
  assert.deepEqual(data.meta.grammar['a1-etre_avoir-001'], { c: 3, w: 1, l: 777, k: 1 });
  assert.equal(data.meta.profile.name, 'Daniel');           // this phone's profile was blank, so the backup's is used
  assert.equal(data.meta.profile.avatar, 'panda');
  assert.equal(data.meta.profile.since, 500);
  assert.equal(data.meta.direction, 'fr-en');                // this phone's settings stay
  assert.deepEqual(data.meta.verbRecent, ['être', 'faire', 'aller']);

  // the other way round: the backup has the newer review of "maison"
  const older = structuredClone(here); older.cards[0].lastReview = 10 * DAY; older.meta.profile.name = 'Dan';
  const second = mergeData(older, phone());
  assert.equal(second.report.updated, 1);
  assert.equal(second.data.cards.find(c => c.lemma === 'maison').interval, 30);
  assert.equal(second.data.meta.profile.name, 'Dan');
  assert.equal(second.data.meta.profile.location, 'Vancouver');

  // merging the same backup twice changes nothing
  const twice = mergeData(data, phone());
  assert.deepEqual(twice.data, data);
  assert.deepEqual(summarize(twice.data), summarize(data));
});
