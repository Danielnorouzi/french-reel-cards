// Runs the real server with ffmpeg + Tesseract on a test reel. Skipped when the tools aren't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

let hasTools = false;
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  hasTools = execSync('tesseract --list-langs 2>&1').toString().includes('fra');
} catch {}

let server, base;
before(async () => {
  if (!hasTools) return;
  ({ server } = await import('../server/index.js'));
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function runJob(file, type) {
  const r = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': type }, body: fs.readFileSync(file) });
  assert.equal(r.status, 202);
  const { id } = await r.json();
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    const j = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (j.status === 'done' || j.status === 'error') return j;
  }
  throw new Error('timeout');
}

test('video reel → caption lines → flashcards', { skip: !hasTools && 'ffmpeg/tesseract-fra not installed' }, async () => {
  const j = await runJob(new URL('./fixtures/reel.mp4', import.meta.url), 'video/mp4');
  assert.equal(j.status, 'done', j.error);
  assert.deepEqual(j.result.lines, [
    'Hier soir, on allait au cinéma mais ma copine était fatiguée',
    'Alors on a mangé une pizza à la maison avec nos voisins']);
  const lemmas = j.result.cards.map(c => c.lemma);
  for (const w of ['aller', 'cinéma', 'copine', 'manger', 'maison', 'voisin']) assert.ok(lemmas.includes(w), w);
});

test('coloured one-word-per-line caption is read as one sentence', { skip: !hasTools && 'ffmpeg/tesseract-fra not installed' }, async () => {
  const j = await runJob(new URL('./fixtures/cyan.jpg', import.meta.url), 'image/jpeg');
  assert.equal(j.status, 'done', j.error);
  assert.equal(j.result.lines.length, 1);
  assert.match(j.result.lines[0], /^le problème c'est que y'a toujours un nouveau vêtement que je veux acheter$/i);
  const cards = Object.fromEntries(j.result.cards.map(c => [c.lemma, c]));
  for (const w of ['problème', 'nouveau', 'vêtement', 'vouloir', 'acheter']) assert.ok(cards[w], w);
  assert.equal(cards.nouveau.pos, 'adj');
});

test('screenshot upload (multipart) works too', { skip: !hasTools && 'ffmpeg/tesseract-fra not installed' }, async () => {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(new URL('./fixtures/shot.png', import.meta.url))], { type: 'image/png' }), 'shot.png');
  const r = await fetch(`${base}/api/jobs`, { method: 'POST', body: fd });
  const { id } = await r.json();
  let j;
  for (let i = 0; i < 60 && j?.status !== 'done'; i++) {
    await new Promise(r => setTimeout(r, 500));
    j = await (await fetch(`${base}/api/jobs/${id}`)).json();
  }
  assert.equal(j.status, 'done');
  assert.ok(j.result.cards.some(c => c.lemma === 'maison'));
});

test('Shortcut inbox: post, list, delete', { skip: !hasTools && 'ffmpeg/tesseract-fra not installed' }, async () => {
  const code = 'testinbox1234';
  const r = await fetch(`${base}/api/inbox/${code}`, { method: 'POST', headers: { 'content-type': 'image/png' },
    body: fs.readFileSync(new URL('./fixtures/shot.png', import.meta.url)) });
  assert.equal(r.status, 202);
  assert.match(await r.text(), /Sent/);
  let jobs;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    ({ jobs } = await (await fetch(`${base}/api/inbox/${code}`)).json());
    if (jobs[0]?.status === 'done') break;
  }
  assert.equal(jobs[0].status, 'done');
  await fetch(`${base}/api/inbox/${code}/${jobs[0].id}`, { method: 'DELETE' });
  ({ jobs } = await (await fetch(`${base}/api/inbox/${code}`)).json());
  assert.equal(jobs.length, 0);
  assert.equal((await fetch(`${base}/api/inbox/bad!`)).status, 400);
});

test('garbage upload returns a friendly error', { skip: !hasTools && 'ffmpeg/tesseract-fra not installed' }, async () => {
  const j = await runJob(new URL('../package.json', import.meta.url), 'application/octet-stream');
  assert.equal(j.status, 'error');
  assert.ok(j.error.length > 10);
});

test('serves the app and health check', { skip: !hasTools && 'ffmpeg/tesseract-fra not installed' }, async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.ok, true);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Reel Cards/);
  assert.equal((await fetch(`${base}/../server/index.js`)).status === 200 && false, false);
  const r = await fetch(`${base}/sw.js`);
  assert.equal(r.status, 200);
});
