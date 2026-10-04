import { db } from './db.js';
import { schedule, preview, newCardState, formatInterval } from './sm2.js';
import { toAnkiCsv, article, frontText, posLabel } from './anki.js';
import { recommend, topicProgress, levelProgress, mistakes, pickQuestions, pickMixed, pickMistakes, shuffleOptions, record, levelCode, nearestLevel, MASTERED } from './grammar.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const API = location.origin; // the server also hosts this app
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const haptic = () => { try { navigator.vibrate?.(8); } catch {} };

let cards = [];
let currentView = 'add';
let sets = [];              // [{ id, name, createdAt }]
let libFilter = 'all';      // 'all' | 'none' | setId
let reviewSet = 'all';      // same shape
let direction = 'fr-en';    // 'fr-en' | 'en-fr'
let saveToSet = null;       // set chosen on the results screen

const setName = id => sets.find(s => s.id === id)?.name;
const inFilter = (c, f) => f === 'all' || (f === 'none' ? !setName(c.setId) : c.setId === f);
const filterLabel = f => f === 'all' ? 'All Cards' : f === 'none' ? 'No Set' : (setName(f) || 'All Cards');
// ---- activity log: { 'YYYY-MM-DD': { r: reviews, a: again, n: added } } ----
let activity = {};
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
async function loadActivity() {
  activity = await db.getMeta('activity');
  if (!activity) { // first run after this update: rebuild what we can from the cards themselves
    activity = {};
    for (const c of cards) {
      const k = dayKey(c.createdAt); (activity[k] ||= { r: 0, a: 0, n: 0 }).n++;
      if (c.lastReview) { const r = dayKey(c.lastReview); (activity[r] ||= { r: 0, a: 0, n: 0 }).r++; }
    }
    await db.setMeta('activity', activity);
  }
}
async function logActivity(field, n = 1) {
  const k = dayKey();
  const day = (activity[k] ||= { r: 0, a: 0, n: 0 });
  day[field] = (day[field] || 0) + n;
  await db.setMeta('activity', activity);
}
async function loadSets() { sets = (await db.getMeta('sets')) || []; }
async function saveSets() { await db.setMeta('sets', sets); }

// ---------------------------------------------------------------- utilities
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: opts.signal || ctl.signal }); }
  finally { clearTimeout(t); }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function uid() {
  return (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');
}

async function reloadCards() {
  cards = await db.allCards();
  updateBadges();
}

function dueCards(now = Date.now(), filter = 'all') {
  return cards.filter(c => c.due <= now && inFilter(c, filter)).sort((a, b) => a.due - b.due);
}

function updateBadges() {
  const n = dueCards().length;
  const b = $('#review-badge');
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : n;
}

// ---------------------------------------------------------------- navigation
function showView(name) {
  if (name === currentView && !$(`#view-${name}`).hidden) return;
  currentView = name;
  for (const v of $$('.view')) v.hidden = v.id !== `view-${name}`;
  for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.view === name);
  window.scrollTo(0, 0);
  onScroll();
  if (name === 'review') startReview();
  if (name === 'library') renderLibrary();
  if (name === 'profile') renderProfile();
  if (name === 'grammar') renderGrammar();
  if (name !== 'library' && selecting) setSelecting(false);
}
$$('.tab').forEach(t => t.addEventListener('click', () => { haptic(); showView(t.dataset.view); }));

function onScroll() {
  const nav = $(`#view-${currentView} .navbar`);
  nav?.classList.toggle('scrolled', window.scrollY > 38);
}
window.addEventListener('scroll', onScroll, { passive: true });

// ---------------------------------------------------------------- server wake-up
// Render's free tier sleeps after 15 idle minutes; the first request wakes it (~30–60 s).
let serverAwake = false;
async function ping(ms) {
  try {
    const r = await fetchWithTimeout(`${API}/api/health`, { cache: 'no-store' }, ms);
    serverAwake = r.ok;
  } catch { serverAwake = false; }
  return serverAwake;
}
async function ensureAwake(onWaking, isCancelled) {
  if (await ping(4000)) return true;
  onWaking();
  const start = Date.now();
  while (Date.now() - start < 150_000) {
    if (isCancelled()) return false;
    if (await ping(15000)) return true;
    await sleep(2500);
  }
  throw new Error("The server didn't wake up. Check your connection and try again.");
}

// ---------------------------------------------------------------- ADD
const addStates = ['idle', 'working', 'results', 'done', 'error'];
function setAddState(s) {
  for (const n of addStates) $(`#add-${n}`).hidden = n !== s;
  window.scrollTo({ top: 0 });
  renderInboxBanner();
}

let activeUpload = null; // { xhr, cancelled }
let lastFile = null;

// The dachshund acts out each step: asleep while the free server wakes, hopping while it reads.
const MOODS = {
  connect: ['standing', 'On y va\u00a0!'], waking: ['sleeping', 'Chut… il fait la sieste.'],
  upload: ['standing', 'J\u2019arrive\u00a0!'], queued: ['coffee', 'Patience…'], reading: ['standing', 'Je lis…']
};
function setWorking(title, sub, progress /* 0..1 or null for spinner */, mood = 'reading') {
  $('#work-title').textContent = title;
  $('#work-sub').textContent = sub;
  const [art, line] = MOODS[mood] || MOODS.reading;
  const m = $('#work-mascot');
  if (!m.classList.contains(`m-${art}`)) {
    m.className = `mascot m-${art}`;
    $('#work-art').src = `art/${art}.webp`;
    const b = $('#work-bubble'); b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
  }
  $('#work-bubble').textContent = line;
  const bar = $('#work-bar');
  bar.classList.toggle('indeterminate', progress == null);
  $('#work-fill').style.width = progress == null ? '' : `${Math.max(3, Math.min(100, progress * 100))}%`;
}

function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeUpload.xhr = xhr;
    xhr.open('POST', `${API}/api/jobs`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.onabort = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    xhr.send(file);
  });
}

async function processFile(file) {
  lastFile = file;
  const job = { cancelled: false, xhr: null };
  activeUpload = job;
  setAddState('working');
  setWorking('Connecting…', 'Getting things ready.', null, 'connect');
  try {
    const ok = await ensureAwake(
      () => setWorking('Waking up…', 'The free server takes a quick nap when nobody is using it. The first upload can take up to a minute.', null, 'waking'),
      () => job.cancelled
    );
    if (!ok || job.cancelled) return;
    const isVideo = file.type.startsWith('video') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
    setWorking('Uploading…', isVideo ? 'Sending your reel.' : 'Sending your screenshot.', 0, 'upload');
    const created = await upload(file, p => setWorking('Uploading…', `${Math.round(p * 100)}%`, p, 'upload'));
    let res;
    while (!job.cancelled) {
      await sleep(1200);
      const r = await fetchWithTimeout(`${API}/api/jobs/${created.id}`, {}, 15000).catch(() => null);
      if (!r) continue;
      res = await r.json();
      if (!r.ok) throw new Error(res.error || 'Lost track of the upload.');
      if (res.status === 'done' || res.status === 'error') break;
      const { done, total } = res.progress || {};
      if (res.status === 'queued') setWorking('Waiting…', 'Another reel is being read first.', null, 'queued');
      else setWorking('Reading the text…', res.stage || '', total ? done / total : null, 'reading');
    }
    if (job.cancelled) return;
    if (res.status === 'error') throw new Error(res.error);
    showResults([res.result]);
  } catch (e) {
    if (e.cancelled || job.cancelled) return;
    showError(e.message);
  } finally {
    if (activeUpload === job) activeUpload = null;
  }
}

function showError(msg) {
  $('#error-sub').textContent = msg || 'Please try again.';
  setAddState('error');
}

$('#file-input').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) processFile(f);
});
$('#cancel-work').addEventListener('click', () => {
  if (activeUpload) { activeUpload.cancelled = true; activeUpload.xhr?.abort(); }
  setAddState('idle');
});
$('#error-retry').addEventListener('click', () => lastFile ? processFile(lastFile) : setAddState('idle'));
$('#add-another').addEventListener('click', () => setAddState('idle'));
$('#go-review').addEventListener('click', () => showView('review'));

// ----- results
let pendingResult = null; // { cards, lines, fromInbox }
function showResults(results, fromInbox = false, opts = {}) {
  const known = new Set(cards.map(c => c.lemma.toLowerCase()));
  const seen = new Set();
  const found = [];
  let skipped = 0;
  const lines = [];
  for (const r of results) {
    lines.push(...(r.lines || []));
    for (const c of r.cards || []) {
      const k = c.lemma.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      if (known.has(k)) { skipped++; continue; }
      found.push({ ...c, selected: c.selected !== false });
    }
  }
  pendingResult = { cards: found, lines, fromInbox };

  const summary = opts.summary ? opts.summary(found.length, skipped) : found.length
    ? `Found ${found.length} new word${found.length === 1 ? '' : 's'}` + (skipped ? `. Skipped ${skipped} already in your library.` : '.')
    : lines.length
      ? `No new words this time${skipped ? ` (${skipped} already in your library)` : ''}.`
      : "Couldn't find any French text on screen. Try a clearer frame or a screenshot.";
  $('#results-summary').textContent = summary;

  const list = $('#results-list');
  list.hidden = !found.length;
  list.innerHTML = found.map((c, i) => `
    <button class="row${c.selected ? ' on' : ''}" data-i="${i}">
      <span class="toggle"><svg viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10"/></svg></span>
      <span class="row-main">
        <span class="row-title">${article(c) ? `<span class="art">${esc(article(c))} </span>` : ''}${esc(c.lemma)}</span>
        <span class="row-sub${c.meaning ? '' : ' missing'}">${c.meaning ? esc(c.meaning) : 'No meaning found. Add one later in Library.'}</span>
      </span>
      <span class="row-meta">${esc(c.pos)}</span>
    </button>`).join('');
  $('#caption-lines').innerHTML = lines.map(l => `<p>${esc(l)}</p>`).join('') || '<p>No text found.</p>';
  $('.captions').open = !found.length && lines.length > 0;
  $('#results-set-wrap').hidden = !found.length;
  renderSaveTo();
  updateAddButton();
  setAddState('results');
}

function renderSaveTo() {
  if (saveToSet && !setName(saveToSet)) saveToSet = null;
  $('#results-set-name').textContent = setName(saveToSet) || 'No set';
}
$('#results-set').addEventListener('click', async () => {
  const picked = await pickSet({ title: 'Save to Set', current: saveToSet ?? 'none', allowNone: true });
  if (picked === undefined) return;
  saveToSet = picked === 'none' ? null : picked;
  await db.setMeta('lastSetId', saveToSet);
  renderSaveTo();
});

$('#results-list').addEventListener('click', e => {
  const row = e.target.closest('.row');
  if (!row) return;
  haptic();
  const c = pendingResult.cards[+row.dataset.i];
  c.selected = !c.selected;
  row.classList.toggle('on', c.selected);
  updateAddButton();
});

function updateAddButton() {
  const n = pendingResult.cards.filter(c => c.selected).length;
  const btn = $('#add-cards');
  btn.hidden = !pendingResult.cards.length;
  btn.textContent = n ? `Add ${n} Card${n === 1 ? '' : 's'}` : 'Select Words to Add';
  btn.disabled = !n;
  btn.style.opacity = n ? '' : '0.5';
  $('#discard-results').textContent = pendingResult.cards.length ? 'Discard' : 'Done';
}

$('#add-cards').addEventListener('click', async () => {
  const now = Date.now();
  const chosen = pendingResult.cards.filter(c => c.selected).map((c, i) => ({
    id: uid(), lemma: c.lemma, word: c.word, pos: c.pos, gender: c.gender, meaning: c.meaning,
    example: c.example, createdAt: now + i, setId: saveToSet || null, ...newCardState(now)
  }));
  const added = await db.addCards(chosen);
  if (added) await logActivity('n', added);
  if (pendingResult.fromInbox) await clearInboxResults();
  pendingResult = null;
  await reloadCards();
  haptic();
  $('#done-title').textContent = `${added} card${added === 1 ? '' : 's'} added` + (setName(saveToSet) ? ` to ${setName(saveToSet)}` : '');
  setAddState('done');
});
$('#discard-results').addEventListener('click', async () => {
  if (pendingResult?.fromInbox) await clearInboxResults();
  pendingResult = null;
  setAddState('idle');
});

// ----- import a word list (paste or file: plain list, "word - meaning", Quizlet/Anki CSV or TSV)
function cleanField(s) {
  return String(s || '').split(/<br\s*\/?>/i)[0]            // Anki backs: keep the first line (the meaning)
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function splitCsv(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
export function parseWordList(text) {
  const items = [];
  const lines = text.replace(/\r/g, '').split('\n');
  // a file where most lines have commas/semicolons outside quotes is a CSV
  const csvSep = [',', ';'].find(sep => lines.filter(l => l.includes(sep)).length > lines.filter(Boolean).length * 0.6);
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let parts;
    if (line.includes('\t')) parts = line.split('\t');
    else if (line.startsWith('"') || (csvSep && /^[^"]*$/.test(line) === false)) parts = splitCsv(line, csvSep || ',');
    else {
      const m = line.match(/^(.+?)\s+(?:=|-|–|—|:)\s+(.+)$/) || (csvSep ? null : line.match(/^(.+?)\s*[;,]\s*(.+)$/));
      parts = m ? [m[1], m[2]] : csvSep ? splitCsv(line, csvSep) : [line];
    }
    const fr = cleanField(parts[0]).replace(/^\d+[.)]\s*/, '');   // "1. la maison" numbered lists
    if (!fr || /^(front|french|word|mot|term)$/i.test(fr)) continue;  // header rows
    items.push({ fr, en: cleanField(parts[1] || '') });
  }
  return items;
}

function openImport() {
  openSheet('Import Words', `
    <p class="note" style="margin:4px 4px 14px">Paste words, one per line. Add a meaning after a dash if you want your own. Otherwise the app looks it up and finds the base form and gender.</p>
    <div class="import-box"><textarea id="import-text" spellcheck="false" autocapitalize="off" placeholder="la maison&#10;connaître - to know (a person)&#10;avoir le cafard = to feel down&#10;allait"></textarea></div>
    <p class="import-count" id="import-count"></p>
    <div class="import-actions">
      <label class="btn btn-secondary" for="import-file">Choose File</label>
      <button class="btn btn-primary" id="import-go" disabled>Look Up Words</button>
    </div>
    <input type="file" id="import-file" accept=".csv,.txt,.tsv,text/plain,text/csv,text/tab-separated-values" hidden>
    <p class="note">Works with plain lists, “word - meaning”, and CSV or TSV exports from Anki, Quizlet or a spreadsheet (French in the first column, English in the second).</p>`);
  const ta = $('#import-text'), go = $('#import-go');
  const update = () => {
    const n = parseWordList(ta.value).length;
    go.disabled = !n;
    go.textContent = n ? `Look Up ${n} Word${n === 1 ? '' : 's'}` : 'Look Up Words';
    $('#import-count').textContent = n ? `${n} word${n === 1 ? '' : 's'} ready` : '';
  };
  ta.addEventListener('input', update);
  $('#import-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    ta.value = (await f.text()).slice(0, 500_000);
    update();
  });
  go.addEventListener('click', async () => {
    const items = parseWordList(ta.value);
    if (!items.length) return;
    haptic();
    await closeSheet();
    importWords(items);
  });
}
$('#open-import').addEventListener('click', openImport);
$('#open-import-2').addEventListener('click', () => { showView('add'); openImport(); });

async function importWords(items) {
  const job = { cancelled: false, xhr: null };
  activeUpload = job;
  setAddState('working');
  setWorking('Looking up words…', `${items.length} word${items.length === 1 ? '' : 's'}`, null, 'reading');
  $('#work-bubble').textContent = 'Je cherche…';
  const summary = (n, skipped) => n
    ? `Ready to add ${n} word${n === 1 ? '' : 's'}` + (skipped ? `. Skipped ${skipped} already in your library.` : '.')
    : `All ${skipped} word${skipped === 1 ? ' is' : 's are'} already in your library.`;
  let cardsOut;
  try {
    const ok = await ensureAwake(
      () => setWorking('Waking up…', 'The free server takes a quick nap. The first lookup can take up to a minute.', null, 'waking'),
      () => job.cancelled);
    if (!ok || job.cancelled) return;
    setWorking('Looking up words…', `${items.length} word${items.length === 1 ? '' : 's'}`, null, 'reading');
    const r = await fetchWithTimeout(`${API}/api/lookup`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }) }, 60_000);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || 'Lookup failed.');
    cardsOut = body.cards.map(c => ({ ...c, selected: !!c.meaning }));
  } catch (e) {
    if (job.cancelled) return;
    // offline: still import the words that came with a meaning
    const withMeaning = items.filter(i => i.en);
    if (!withMeaning.length) { showError(e.message || 'Could not reach the server to look the words up.'); return; }
    cardsOut = withMeaning.map(i => ({ lemma: i.fr, word: i.fr, pos: '', gender: '', meaning: i.en, example: '' }));
    toast('Offline: imported words that had a meaning');
  } finally {
    if (activeUpload === job) activeUpload = null;
  }
  if (job.cancelled) return;
  showResults([{ lines: [], cards: cardsOut }], false, { summary });
}

// ----- iOS Shortcut inbox
async function inboxCode() {
  let code = await db.getMeta('inboxCode');
  if (!code) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    code = [...bytes].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
    await db.setMeta('inboxCode', code);
  }
  return code;
}
const inboxURL = code => `${API}/api/inbox/${code}`;

let inboxTimer = null;
async function checkInbox() {
  clearTimeout(inboxTimer);
  const code = await inboxCode();
  let processing = 0;
  try {
    const r = await fetchWithTimeout(inboxURL(code), { cache: 'no-store' }, 70_000);
    if (r.ok) {
      const { jobs } = await r.json();
      const stored = (await db.getMeta('inboxResults')) || [];
      for (const j of jobs) {
        if (j.status === 'done' && j.result) {
          if (!stored.some(s => s.id === j.id)) stored.push({ id: j.id, ...j.result });
        }
        if (j.status === 'done' || j.status === 'error') {
          fetch(`${inboxURL(code)}/${j.id}`, { method: 'DELETE' }).catch(() => {});
        } else processing++;
      }
      await db.setMeta('inboxResults', stored);
    }
  } catch {}
  await renderInboxBanner(processing);
  if (processing && document.visibilityState === 'visible') inboxTimer = setTimeout(checkInbox, 4000);
}
async function renderInboxBanner(processing = 0) {
  const stored = (await db.getMeta('inboxResults')) || [];
  const banner = $('#inbox-banner');
  const idle = !$('#add-idle').hidden;
  banner.hidden = !(stored.length || processing) || !idle;
  $('#add-dot').hidden = !stored.length;
  if (stored.length) {
    $('#inbox-title').textContent = `New words from ${stored.length} shared reel${stored.length === 1 ? '' : 's'}`;
    $('#inbox-sub').textContent = processing ? 'More still being read… Tap to see these.' : 'Tap to review and add them.';
  } else if (processing) {
    $('#inbox-title').textContent = 'Reading your shared reel…';
    $('#inbox-sub').textContent = 'This can take a minute on the free server.';
  }
}
async function clearInboxResults() {
  await db.setMeta('inboxResults', []);
  renderInboxBanner();
}
$('#inbox-banner').addEventListener('click', async () => {
  const stored = (await db.getMeta('inboxResults')) || [];
  if (!stored.length) return;
  $('#inbox-banner').hidden = true;
  showResults(stored, true);
});

// ---------------------------------------------------------------- REVIEW
let queue = [];
let reviewed = 0;
let current = null;
let flipped = false;

function startReview() {
  if (reviewSet !== 'all' && reviewSet !== 'none' && !setName(reviewSet)) reviewSet = 'all';
  $('#review-set-name').textContent = filterLabel(reviewSet);
  for (const b of $$('#dir-toggle button')) {
    b.classList.toggle('on', b.dataset.dir === direction);
    b.setAttribute('aria-checked', b.dataset.dir === direction);
  }
  queue = dueCards(Date.now(), reviewSet);
  reviewed = 0;
  nextCard();
}

$('#dir-toggle').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b || b.dataset.dir === direction) return;
  haptic();
  direction = b.dataset.dir;
  await db.setMeta('direction', direction);
  for (const x of $$('#dir-toggle button')) {
    x.classList.toggle('on', x === b);
    x.setAttribute('aria-checked', x === b);
  }
  if (current) { queue.unshift(current); current = null; nextCard(); } // redraw the current card
});

$('#review-set').addEventListener('click', async () => {
  const picked = await pickSet({ title: 'Review', current: reviewSet, allowAll: true, allowNone: true, showDue: true });
  if (picked === undefined) return;
  reviewSet = picked;
  await db.setMeta('reviewSet', reviewSet);
  startReview();
});

function renderEmpty() {
  $('#review-area').hidden = true;
  $('#review-empty').hidden = false;
  $('#review-count').textContent = '';
  const btn = $('#empty-action');
  const pool = cards.filter(c => inFilter(c, reviewSet));
  if (cards.length && !pool.length) {
    $('#empty-title').textContent = 'This set is empty';
    $('#empty-sub').textContent = 'Move cards into it from the Library, or pick another set above.';
    btn.hidden = true;
  } else if (!cards.length) {
    $('#empty-title').textContent = 'No cards yet';
    $('#empty-sub').textContent = 'Add a reel and your new words will show up here.';
    btn.hidden = false;
  } else {
    const next = Math.min(...pool.map(c => c.due));
    $('#empty-title').textContent = reviewed ? 'Nice work!' : 'All caught up';
    $('#empty-sub').textContent = reviewed
      ? `You reviewed ${reviewed} card${reviewed === 1 ? '' : 's'}. Next review in ${formatInterval(next - Date.now())}.`
      : `No cards are due. Next review in ${formatInterval(next - Date.now())}.`;
    btn.hidden = true;
  }
}
$('#empty-action').addEventListener('click', () => showView('add'));

function nextCard() {
  // cards marked "Again" come back once their minute is up (or at the end of the queue)
  queue.sort((a, b) => a.due - b.due);
  if (!queue.length) { current = null; renderEmpty(); updateBadges(); return; }
  current = queue.shift();
  $('#review-empty').hidden = true;
  $('#review-area').hidden = false;
  flipped = false;
  const fc = $('#flashcard');
  fc.className = 'flashcard';
  fc.style.transform = '';
  fc.style.opacity = '';
  void fc.offsetWidth;
  fc.classList.add('enter');
  const a = article(current);
  const enFirst = direction === 'en-fr';
  $('#fc-pos').textContent = posLabel(current);
  $('#fc-pos-back').textContent = posLabel(current);
  // FR → EN: French word on the front. EN → FR: English meaning on the front, French on the back.
  $('#fc-article').textContent = enFirst ? '' : a;
  $('#fc-article').hidden = enFirst || !a;
  $('#fc-lemma').textContent = enFirst ? current.meaning : current.lemma;
  $('#fc-lemma').parentElement.classList.toggle('en', enFirst);
  $('#fc-lemma-back').textContent = enFirst ? current.meaning : frontText(current);
  $('#fc-meaning').textContent = enFirst ? frontText(current) : current.meaning;
  const ex = $('#fc-example');
  ex.hidden = !current.example;
  ex.innerHTML = highlightExample(current.example || '', current.word);
  $('#show-answer').hidden = false;
  $('#grades').hidden = true;
  const total = reviewed + queue.length + 1;
  $('#progress-bar').style.width = `${(reviewed / total) * 100}%`;
  $('#review-count').textContent = `${queue.length + 1} left`;
}

function highlightExample(example, word) {
  const e = esc(example);
  if (!word) return e;
  const re = new RegExp(`(^|[^\\p{L}])(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}])`, 'iu');
  return e.replace(re, '$1<b>$2</b>');
}

function flip() {
  if (!current) return;
  flipped = !flipped;
  $('#flashcard').classList.toggle('flipped', flipped);
  if (flipped) {
    const p = preview(current);
    for (const b of $$('.grade')) b.querySelector('small').textContent = p[b.dataset.grade];
    $('#show-answer').hidden = true;
    $('#grades').hidden = false;
  }
}
$('#show-answer').addEventListener('click', () => { haptic(); flip(); });

async function grade(g, dir) {
  if (!current) return;
  haptic();
  const card = current;
  const upd = schedule(card, g);
  logActivity('r');
  if (g === 'again') logActivity('a');
  Object.assign(card, upd, { relearning: g === 'again' });
  current = null;
  await db.putCard(stripTransient(card));
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx >= 0) cards[idx] = card;
  if (g === 'again') queue.push(card); else reviewed++;
  updateBadges();
  // fly the card away: left for Again, right otherwise
  const fc = $('#flashcard');
  const x = (dir ?? (g === 'again' ? -1 : 1)) * (window.innerWidth + 200);
  fc.classList.remove('dragging');
  fc.classList.add('fly');
  fc.style.transform = `translateX(${x}px) rotate(${x / 40}deg) rotateY(180deg)`;
  fc.style.opacity = '0';
  $('#grades').hidden = true;
  await sleep(300);
  nextCard();
}
function stripTransient(c) { const { relearning, ...rest } = c; return rest; }
$('#grades').addEventListener('click', e => {
  const b = e.target.closest('.grade');
  if (b) grade(b.dataset.grade);
});

// tap to flip, swipe (after flipping) right = Good, left = Again
(() => {
  const fc = $('#flashcard');
  const back = fc.querySelector('.back');
  const tagL = Object.assign(document.createElement('span'), { className: 'swipe-tag left', textContent: 'Again' });
  const tagR = Object.assign(document.createElement('span'), { className: 'swipe-tag right', textContent: 'Good' });
  back.append(tagL, tagR);
  let sx = 0, sy = 0, dx = 0, dragging = false, moved = false, pid = null;
  fc.addEventListener('pointerdown', e => {
    sx = e.clientX; sy = e.clientY; dx = 0; moved = false; pid = e.pointerId;
    dragging = flipped;
  });
  fc.addEventListener('pointermove', e => {
    if (e.pointerId !== pid) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!moved && Math.hypot(mx, my) > 8) moved = true;
    if (!dragging || !moved || Math.abs(my) > Math.abs(mx) * 1.2 && Math.abs(dx) < 10) return;
    dx = mx;
    fc.classList.add('dragging');
    try { fc.setPointerCapture(pid); } catch {}
    fc.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg) rotateY(180deg)`;
    // mirrored because the back face is rotated
    tagR.style.opacity = String(Math.max(0, Math.min(1, dx / 90)));
    tagL.style.opacity = String(Math.max(0, Math.min(1, -dx / 90)));
  });
  const end = e => {
    if (e.pointerId !== pid) return;
    pid = null;
    tagL.style.opacity = tagR.style.opacity = '0';
    if (!moved) { flip(); return; }
    if (!dragging) return;
    dragging = false;
    if (Math.abs(dx) > 100) { grade(dx > 0 ? 'good' : 'again', Math.sign(dx)); return; }
    fc.classList.remove('dragging');
    fc.style.transform = '';
  };
  fc.addEventListener('pointerup', end);
  fc.addEventListener('pointercancel', end);
})();

// ---------------------------------------------------------------- LIBRARY
let selecting = false;
const picked = new Set();

function renderChips() {
  if (libFilter !== 'all' && libFilter !== 'none' && !setName(libFilter)) libFilter = 'all';
  const count = f => cards.filter(c => inFilter(c, f)).length;
  const chips = [['all', 'All'], ...sets.map(s => [s.id, s.name])];
  if (sets.length && count('none')) chips.push(['none', 'No Set']);
  $('#set-chips').innerHTML = chips.map(([id, name]) =>
    `<button class="chip${libFilter === id ? ' on' : ''}" data-f="${esc(id)}">${esc(name)} <small>${count(id)}</small></button>`).join('') +
    `<button class="chip add" data-new="1">+ New Set</button>`;
}
$('#set-chips').addEventListener('click', async e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  haptic();
  if (b.dataset.new) {
    const id = await pickSet({ title: 'New Set', current: null, onlyCreate: true });
    if (id && id !== 'none') { libFilter = id; }
  } else libFilter = b.dataset.f;
  renderLibrary();
});

function renderLibrary() {
  renderChips();
  const q = $('#search').value.trim().toLowerCase();
  const inSet = cards.filter(c => inFilter(c, libFilter));
  const sorted = [...inSet].sort((a, b) => b.createdAt - a.createdAt);
  const list = q ? sorted.filter(c => c.lemma.toLowerCase().includes(q) || c.meaning.toLowerCase().includes(q) || (c.word || '').includes(q)) : sorted;
  const now = Date.now();
  const due = inSet.filter(c => c.due <= now).length;
  const learned = inSet.filter(c => c.interval >= 21).length;
  $('#stats').innerHTML = `
    <div class="stat"><b>${inSet.length}</b><span>Cards</span></div>
    <div class="stat"><b>${due}</b><span>Due now</span></div>
    <div class="stat"><b>${learned}</b><span>Mastered</span></div>`;
  $('#library-empty').hidden = cards.length > 0;
  const el = $('#library-list');
  el.hidden = !list.length;
  el.classList.toggle('selecting', selecting);
  const tick = '<span class="toggle sel"><svg viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10"/></svg></span>';
  el.innerHTML = list.slice(0, 400).map(c => `
    <button class="row tappable${picked.has(c.id) ? ' picked' : ''}" data-id="${c.id}">
      ${selecting ? tick : ''}
      <span class="row-main">
        <span class="row-title">${article(c) ? `<span class="art">${esc(article(c))} </span>` : ''}${esc(c.lemma)}</span>
        <span class="row-sub">${esc(c.meaning)}${libFilter === 'all' && setName(c.setId) ? ` · ${esc(setName(c.setId))}` : ''}</span>
      </span>
      <span class="row-meta">${c.due <= now ? 'due' : formatInterval(c.due - now)}</span>
      <svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
    </button>`).join('');
}
$('#search').addEventListener('input', renderLibrary);
$('#library-list').addEventListener('click', e => {
  const row = e.target.closest('.row');
  if (!row) return;
  if (selecting) {
    haptic();
    const id = row.dataset.id;
    picked.has(id) ? picked.delete(id) : picked.add(id);
    row.classList.toggle('picked', picked.has(id));
    renderSelectBar();
    return;
  }
  openCardSheet(cards.find(c => c.id === row.dataset.id));
});

function setSelecting(on) {
  selecting = on;
  picked.clear();
  $('#select-btn').textContent = on ? 'Done' : 'Select';
  $('#select-bar').hidden = !on;
  document.body.classList.toggle('selecting', on);
  renderSelectBar();
  renderLibrary();
}
function renderSelectBar() {
  $('#sel-count').textContent = `${picked.size} selected`;
  $('#sel-move').disabled = $('#sel-delete').disabled = !picked.size;
}
$('#select-btn').addEventListener('click', () => { haptic(); setSelecting(!selecting); });
$('#sel-move').addEventListener('click', async () => {
  if (!picked.size) return;
  const target = await pickSet({ title: `Move ${picked.size} Card${picked.size === 1 ? '' : 's'}`, current: null, allowNone: true });
  if (target === undefined) return;
  const n = picked.size;
  for (const c of cards) if (picked.has(c.id)) { c.setId = target === 'none' ? null : target; await db.putCard(stripTransient(c)); }
  setSelecting(false);
  toast(`Moved ${n} card${n === 1 ? '' : 's'} to ${target === 'none' ? 'No Set' : setName(target)}`);
});
$('#sel-delete').addEventListener('click', async () => {
  const b = $('#sel-delete');
  if (!picked.size) return;
  if (!b.dataset.confirm) {
    b.dataset.confirm = '1'; b.textContent = `Delete ${picked.size}?`; haptic();
    setTimeout(() => { delete b.dataset.confirm; b.textContent = 'Delete'; }, 3000);
    return;
  }
  delete b.dataset.confirm; b.textContent = 'Delete';
  const n = picked.size;
  for (const id of picked) await db.deleteCard(id);
  await reloadCards();
  setSelecting(false);
  toast(`Deleted ${n} card${n === 1 ? '' : 's'}`);
});

// ---------------------------------------------------------------- sheets
function openSheet(title, html) {
  sheetOnClose = null;
  sheetToken++;
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').scrollTop = 0;
  const s = $('#sheet'), b = $('#sheet-backdrop');
  s.classList.remove('out'); b.classList.remove('out');
  s.hidden = b.hidden = false;
  document.body.style.overflow = 'hidden';
}
let sheetOnClose = null;
let sheetToken = 0;
async function closeSheet() {
  const s = $('#sheet'), b = $('#sheet-backdrop');
  if (s.hidden) return;
  if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; f(); return; }
  const token = ++sheetToken;
  s.classList.add('out'); b.classList.add('out');
  await sleep(260);
  if (token !== sheetToken) return; // another sheet opened meanwhile
  s.hidden = b.hidden = true;
  document.body.style.overflow = '';
}
$('#sheet-close').addEventListener('click', closeSheet);
$('#sheet-backdrop').addEventListener('click', closeSheet);

function openCardSheet(c) {
  if (!c) return;
  const now = Date.now();
  openSheet('Card', `
    <div class="detail-word">
      <div class="word">${article(c) ? `<span class="article">${esc(article(c))}</span>` : ''}${esc(c.lemma)}</div>
      <p>${esc(posLabel(c))}${c.word && c.word !== c.lemma ? ` · seen as “${esc(c.word)}”` : ''}</p>
    </div>
    <div class="list inset" style="margin-top:14px">
      <button class="row row-button" id="card-set"><span class="row-main">Set</span><span class="row-value">${esc(setName(c.setId) || 'No set')}</span><svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button>
    </div>
    <h3>Meaning</h3>
    <div class="list inset"><div class="field"><textarea id="edit-meaning" rows="2">${esc(c.meaning)}</textarea></div></div>
    <h3>From the reel</h3>
    <div class="list inset"><div class="field"><textarea id="edit-example" rows="3">${esc(c.example || '')}</textarea></div></div>
    <h3>Progress</h3>
    <div class="list inset">
      <div class="row"><span class="row-main">Next review</span><span class="row-meta">${c.due <= now ? 'Now' : 'in ' + formatInterval(c.due - now)}</span></div>
      <div class="row"><span class="row-main">Times reviewed</span><span class="row-meta">${c.reps + c.lapses}</span></div>
      <div class="row"><span class="row-main">Ease</span><span class="row-meta">${c.ease.toFixed(2)}</span></div>
    </div>
    <button class="btn btn-danger" id="delete-card">Delete Card</button>`);
  const save = async () => {
    c.meaning = $('#edit-meaning').value.trim() || c.meaning;
    c.example = $('#edit-example').value.trim();
    await db.putCard(stripTransient(c));
  };
  $('#card-set').addEventListener('click', async () => {
    await save();
    const target = await pickSet({ title: 'Move to Set', current: c.setId || 'none', allowNone: true });
    if (target !== undefined) {
      c.setId = target === 'none' ? null : target;
      await db.putCard(stripTransient(c));
      if (currentView === 'library') renderLibrary();
    }
    openCardSheet(c);
  });
  $('#edit-meaning').addEventListener('change', save);
  $('#edit-example').addEventListener('change', save);
  const del = $('#delete-card');
  del.addEventListener('click', async () => {
    if (!del.dataset.confirm) { del.dataset.confirm = '1'; del.textContent = 'Tap Again to Delete'; haptic(); return; }
    await db.deleteCard(c.id);
    await reloadCards();
    renderLibrary();
    closeSheet();
    toast('Card deleted');
  });
}

// Pick a set in a sheet. Resolves to a set id, 'none', 'all', or undefined if dismissed.
// Also lets you create a new set on the spot.
function pickSet({ title, current, allowNone = false, allowAll = false, showDue = false, onlyCreate = false }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; sheetOnClose = null; closeSheet(); resolve(v); };
    const now = Date.now();
    const meta = f => showDue
      ? `${cards.filter(c => inFilter(c, f) && c.due <= now).length} due`
      : `${cards.filter(c => inFilter(c, f)).length}`;
    const check = '<svg class="tick" viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10"/></svg>';
    const row = (id, name) => `<button class="row row-button" data-pick="${esc(id)}"><span class="row-main">${esc(name)}</span>
      <span class="count">${meta(id)}</span>${current === id ? check : '<span style="width:22px"></span>'}</button>`;
    const rows = [
      ...(allowAll ? [row('all', 'All Cards')] : []),
      ...sets.map(s => row(s.id, s.name)),
      ...(allowNone ? [row('none', 'No Set')] : [])
    ];
    openSheet(title, `
      ${onlyCreate ? '' : `<div class="list inset set-list" style="margin-top:8px">${rows.join('')}</div>`}
      <h3>${onlyCreate ? 'Name' : 'New Set'}</h3>
      <form class="new-set" id="new-set-form"><input id="new-set-name" maxlength="40" placeholder="e.g. Clothes, Food, Reel slang" autocomplete="off">
        <button id="new-set-btn" disabled>Create</button></form>`);
    sheetOnClose = () => finish(undefined);
    const input = $('#new-set-name'), btn = $('#new-set-btn');
    input.addEventListener('input', () => { btn.disabled = !input.value.trim(); });
    if (onlyCreate || !sets.length) setTimeout(() => input.focus(), 350);
    $('#new-set-form').addEventListener('submit', async e => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      const existing = sets.find(s => s.name.toLowerCase() === name.toLowerCase());
      const s = existing || { id: uid(), name, createdAt: Date.now() };
      if (!existing) { sets.push(s); await saveSets(); }
      haptic();
      finish(s.id);
    });
    for (const b of $$('#sheet-body [data-pick]')) b.addEventListener('click', () => { haptic(); finish(b.dataset.pick); });
  });
}

function openSetManager() {
  const count = id => cards.filter(c => c.setId === id).length;
  openSheet('Sets', `
    <p class="note" style="margin-top:4px">Tap a name to rename it. Deleting a set keeps its cards; they move to “No Set”.</p>
    ${sets.length ? `<div class="list inset" style="margin-top:14px">${sets.map(s => `
      <div class="row set-edit" data-id="${s.id}"><input value="${esc(s.name)}" maxlength="40" aria-label="Set name">
        <span class="count" style="color:var(--label-2)">${count(s.id)}</span><button class="del">Delete</button></div>`).join('')}</div>`
      : '<p class="note">No sets yet. Create one below.</p>'}
    <h3>New Set</h3>
    <form class="new-set" id="mgr-new"><input id="mgr-name" maxlength="40" placeholder="Set name" autocomplete="off"><button>Create</button></form>`);
  for (const r of $$('#sheet-body .set-edit')) {
    const s = sets.find(x => x.id === r.dataset.id);
    r.querySelector('input').addEventListener('change', async e => {
      const v = e.target.value.trim();
      if (v) { s.name = v; await saveSets(); toast('Renamed'); } else e.target.value = s.name;
    });
    const del = r.querySelector('.del');
    del.addEventListener('click', async () => {
      if (!del.dataset.confirm) { del.dataset.confirm = '1'; del.textContent = 'Sure?'; haptic(); return; }
      sets = sets.filter(x => x.id !== s.id);
      await saveSets();
      for (const c of cards) if (c.setId === s.id) { c.setId = null; await db.putCard(stripTransient(c)); }
      openSetManager();
      toast(`Deleted “${s.name}”`);
    });
  }
  $('#mgr-new').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#mgr-name').value.trim();
    if (!name || sets.some(s => s.name.toLowerCase() === name.toLowerCase())) return;
    sets.push({ id: uid(), name, createdAt: Date.now() });
    await saveSets();
    openSetManager();
  });
}
$('#manage-sets').addEventListener('click', openSetManager);

async function openGuide() {
  const code = await inboxCode();
  const url = inboxURL(code);
  openSheet('Share from Instagram', `
    <p class="note" style="margin-top:4px">Set this up once. Then you can share a saved reel from Photos straight into Reel Cards. It takes about 2 minutes.</p>
    <h3>Build the Shortcut</h3>
    <ol class="steps">
      <li>Open the <b>Shortcuts</b> app and tap <b>+</b> to make a new shortcut. Tap its name at the top and call it <b>Reel Cards</b>.</li>
      <li>Tap the <b>ⓘ</b> button at the bottom and turn on <b>Show in Share Sheet</b>. Tap <b>Done</b>.</li>
      <li>At the top it now says <b>Receive … input from Share Sheet</b>. Tap the blue word (e.g. “Images and 18 more”), tap <b>Clear</b>, then tick only <b>Images</b> and <b>Media</b>.</li>
      <li>Tap <b>Search Actions</b>, find <b>Get Contents of URL</b> and add it. Tap the blue <b>URL</b> and paste this:
        <div class="copy-box"><code id="inbox-url">${esc(url)}</code><button data-copy="${esc(url)}">Copy</button></div>
      </li>
      <li>Tap the <b>›</b> arrow on that action. Set <b>Method</b> to <b>POST</b> and <b>Request Body</b> to <b>File</b>. Tap <b>File</b> and choose <b>Shortcut Input</b>.</li>
      <li>Add the action <b>Show Notification</b> and set its text to <b>Contents of URL</b>. Tap <b>Done</b>.</li>
    </ol>
    <h3>Use it</h3>
    <ol class="steps">
      <li>In Instagram, save the reel to your phone: tap <b>Share</b> (paper plane) → <b>Download</b>, or use <b>Screen Recording</b> if download isn't offered. A screenshot works too.</li>
      <li>In <b>Photos</b>, open the video or screenshot, tap <b>Share</b> → <b>Reel Cards</b>.</li>
      <li>Open this app. The new words appear at the top of the <b>Add</b> tab within a minute or two.</li>
    </ol>
    <p class="note">If the server was asleep, the Shortcut may say it timed out. Wait 30 seconds and share again. Results wait on the server for about 15 minutes, so open the app soon after sharing.</p>
    <p class="note">This link is private to your phone. Keep it to yourself.</p>`);
  $('#sheet-body').addEventListener('click', onCopy);
}
async function onCopy(e) {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; haptic(); }
  catch { const r = document.createRange(); r.selectNodeContents(b.previousElementSibling); getSelection().removeAllRanges(); getSelection().addRange(r); b.textContent = 'Selected'; }
  setTimeout(() => { b.textContent = 'Copy'; }, 1600);
}
$('#open-guide').addEventListener('click', openGuide);
$('#open-guide-2').addEventListener('click', openGuide);

// ---------------------------------------------------------------- VERBS (conjugation)
// Uses this app's own free /api/conjugate endpoint (open Grammalecte data, no third-party API).
// Every verb you look up is kept on the phone, so it still works offline later.
let verbData = null;
let verbMood = 0;
const VERB_CACHE_MAX = 80;

async function renderVerbHome() {
  const recent = (await db.getMeta('verbRecent')) || [];
  $('#verb-recent').innerHTML = recent.slice(0, 12).map(v => `<button class="chip" data-verb="${esc(v)}">${esc(v)}</button>`).join('');
  if (!verbData) { $('#verb-empty').hidden = false; $('#verb-result').hidden = true; }
}
$('#verb-recent').addEventListener('click', e => { const b = e.target.closest('[data-verb]'); if (b) { haptic(); lookupVerb(b.dataset.verb); } });

let suggestTimer = null, suggestSeq = 0;
$('#verb-q').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('#verb-q').value.trim();
  if (q.length < 2) { $('#verb-suggest').hidden = true; return; }
  suggestTimer = setTimeout(async () => {
    const seq = ++suggestSeq;
    try {
      const r = await fetchWithTimeout(`${API}/api/verbs?q=${encodeURIComponent(q)}`, {}, 6000);
      const { verbs } = await r.json();
      if (seq !== suggestSeq || $('#verb-q').value.trim() !== q) return;
      const box = $('#verb-suggest');
      box.hidden = !verbs.length;
      box.innerHTML = verbs.map(v => `<button class="row row-button" type="button" data-verb="${esc(v)}"><span class="row-main"><span><b>${esc(v.slice(0, q.length))}</b>${esc(v.slice(q.length))}</span></span></button>`).join('');
    } catch { /* offline or asleep: suggestions are optional */ }
  }, 180);
});
$('#verb-suggest').addEventListener('click', e => { const b = e.target.closest('[data-verb]'); if (b) lookupVerb(b.dataset.verb); });
$('#verb-form').addEventListener('submit', e => { e.preventDefault(); const q = $('#verb-q').value.trim(); if (q) lookupVerb(q); });

async function lookupVerb(q) {
  clearTimeout(suggestTimer); suggestSeq++; // drop any suggestion request still in flight
  verbMood = 0;
  $('#verb-q').value = q;
  $('#verb-q').blur();
  $('#verb-suggest').hidden = true;
  const key = q.toLowerCase().trim();
  const cache = (await db.getMeta('conjCache')) || {};
  if (cache[key]) return showVerb(cache[key]);
  $('#verb-empty').hidden = true; $('#verb-result').hidden = true;
  const loading = $('#verb-loading');
  let result = null, error = '';
  try {
    const quick = await fetchWithTimeout(`${API}/api/conjugate?v=${encodeURIComponent(q)}`, {}, 4000).catch(() => null);
    let r = quick;
    if (!r) { // probably the free server is asleep
      loading.hidden = false;
      $('#verb-loading-text').textContent = 'Waking up the free server… this can take up to a minute.';
      await ensureAwake(() => {}, () => false);
      r = await fetchWithTimeout(`${API}/api/conjugate?v=${encodeURIComponent(q)}`, {}, 20000);
    }
    const body = await r.json();
    if (r.ok) result = body;
    else error = body.error + (body.suggestions?.length ? ` Did you mean ${body.suggestions.slice(0, 3).join(', ')}?` : '');
  } catch { error = "Couldn't reach the server. Verbs you've looked up before still work offline."; }
  loading.hidden = true;
  if (!result) { $('#verb-empty').hidden = false; $('#verb-empty p').textContent = error; return; }
  cache[key] = result; cache[result.infinitive.toLowerCase()] = result;
  const keys = Object.keys(cache);
  if (keys.length > VERB_CACHE_MAX) for (const k of keys.slice(0, keys.length - VERB_CACHE_MAX)) delete cache[k];
  await db.setMeta('conjCache', cache);
  showVerb(result);
}

async function showVerb(v) {
  verbData = v;
  const recent = ((await db.getMeta('verbRecent')) || []).filter(x => x !== v.infinitive);
  recent.unshift(v.infinitive);
  await db.setMeta('verbRecent', recent.slice(0, 20));
  renderVerbHome();
  $('#verb-empty').hidden = true;
  $('#verb-result').hidden = false;
  $('#verb-inf').textContent = v.infinitive;
  $('#verb-meaning').textContent = v.meaning || '';
  $('#verb-tags').innerHTML = [`<span>${esc(v.group)}</span>`, `<span class="aux">with ${esc(v.auxiliary)}</span>`, v.reflexive ? '<span>reflexive</span>' : '']
    .join('');
  $('#verb-parts').innerHTML = `<div>Present participle: <b>${esc(v.participles.present || '–')}</b></div><div>Past participle: <b>${esc(v.participles.past || '–')}</b></div>`;
  $('#verb-note').hidden = !v.auxNote; $('#verb-note').textContent = v.auxNote;
  const refl = $('#verb-reflexive');
  refl.hidden = !(v.canBeReflexive || (v.reflexive && v.infinitive !== v.base));
  refl.textContent = v.reflexive ? v.base : (/^[aeiouyâàéèêh]/i.test(v.base) ? `s'${v.base}` : `se ${v.base}`);
  const exists = cards.some(c => c.lemma.toLowerCase() === v.infinitive.toLowerCase() || c.lemma.toLowerCase() === v.base);
  $('#verb-add').textContent = exists ? 'In Your Cards ✓' : 'Add to Cards';
  $('#verb-add').disabled = exists;
  $('#verb-add').style.opacity = exists ? '0.6' : '';
  verbMood = Math.min(verbMood, v.moods.length - 1);
  renderMoods();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const PRONOUN_BITS = new Set(['je', "j'", 'tu', 'il/elle', 'il', 'nous', 'vous', 'ils/elles', 'que', "qu'", 'me', "m'", 'te', "t'", 'se', "s'"]);
function formatConj(text) {
  // mute the pronouns, bold the verb itself
  const parts = text.match(/[^\s']+'|[^\s]+/g) || [];
  let html = '', done = false;
  for (const p of parts) {
    const isPron = !done && PRONOUN_BITS.has(p.toLowerCase());
    if (!isPron) done = true;
    html += `<span class="${isPron ? 'pr' : 'vb'}">${esc(p)}</span>${p.endsWith("'") ? '' : ' '}`;
  }
  return html.trim();
}
function renderMoods() {
  const v = verbData;
  $('#mood-tabs').innerHTML = v.moods.map((m, i) => `<button role="tab" class="${i === verbMood ? 'on' : ''}" data-mood="${i}">${esc(m.name)}</button>`).join('');
  $('#tense-list').innerHTML = v.moods[verbMood].tenses.map((t, ti) => `
    <div class="tense" style="animation-delay:${ti * 40}ms">
      <h4>${esc(t.name)} <small>${esc(t.en)}</small></h4>
      <ul>${t.rows.map(r => `<li>${formatConj(r.text)}${r.alt?.length ? `<span class="alt">or ${esc(r.alt.map(a => a.split(' ').pop()).join(', '))}</span>` : ''}</li>`).join('')}</ul>
    </div>`).join('');
}
$('#mood-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-mood]');
  if (!b) return;
  haptic();
  verbMood = +b.dataset.mood;
  renderMoods();
});
$('#verb-reflexive').addEventListener('click', () => {
  if (!verbData) return;
  haptic();
  lookupVerb(verbData.reflexive ? verbData.base : $('#verb-reflexive').textContent);
});
$('#verb-add').addEventListener('click', async () => {
  const v = verbData;
  if (!v) return;
  const now = Date.now();
  const present = v.moods[0].tenses[0].rows.map(r => r.text).join(', ');
  const added = await db.addCards([{ id: uid(), lemma: v.infinitive, word: v.infinitive, pos: 'verb', gender: '', meaning: v.meaning || '',
    example: present, createdAt: now, setId: saveToSet || null, ...newCardState(now) }]);
  if (added) await logActivity('n', added);
  await reloadCards();
  haptic();
  toast(added ? `Added “${v.infinitive}” to your cards` : 'Already in your cards');
  showVerb(v);
});

// ---------------------------------------------------------------- LEARN (grammar practice + vocab decks + verbs)
// About 4,400 multiple-choice questions in public/grammar.json (built from data/grammar/*.json) and
// about 2,500 level words in public/vocab.json (built from data/vocab/*.txt).
// Everything runs on the phone: both files are cached offline and your answers live in IndexedDB.
let grammarPane = 'practice';
let gramData = null;
let gramStats = {};
let gramLevel = null;    // level shown in the topic list
let gramLevelFor = null; // profile level it was chosen for
let quiz = null;         // { spec, topic, title, items, i, right, streak, answered, results }
let quizLen = 10;
const QUIZ_LENGTHS = [5, 10, 20];
const LEVEL_NAMES = { A1: 'Beginner', A2: 'Elementary', B1: 'Intermediate', B2: 'Upper intermediate', C1: 'Advanced', C2: 'Fluent' };
const CHECK = '<svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg>';

async function loadGrammar() {
  if (gramData) return gramData;
  const r = await fetch('grammar.json');
  if (!r.ok) throw new Error('grammar.json');
  const d = await r.json();
  d.byId = new Map(d.topics.map(t => [t.id, t]));
  d.byTopic = new Map(d.topics.map(t => [t.id, []]));
  for (const q of d.questions) d.byTopic.get(q.t)?.push(q);
  gramData = d;
  return d;
}
const explain = q => (typeof q.e === 'number' ? gramData.x?.[q.e] : q.e) || '';
const progressOf = t => topicProgress(t, gramData.byTopic.get(t.id), gramStats);
const catName = t => gramData.categories?.[t.cat] || '';

function setGrammarPane(pane, save = true) {
  if (!['practice', 'vocab', 'verbs'].includes(pane)) pane = 'practice';
  grammarPane = pane;
  for (const b of $$('#gram-seg button')) { const on = b.dataset.pane === pane; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
  $('#pane-practice').hidden = pane !== 'practice';
  $('#pane-vocab').hidden = pane !== 'vocab';
  $('#pane-verbs').hidden = pane !== 'verbs';
  if (save) db.setMeta('grammarPane', pane);
  if (pane === 'verbs') renderVerbHome(); else if (pane === 'vocab') renderVocab(); else renderPractice();
}
$$('#gram-seg button').forEach(b => b.addEventListener('click', () => { if (b.dataset.pane !== grammarPane) { haptic(); setGrammarPane(b.dataset.pane); } }));

function renderGrammar() { setGrammarPane(grammarPane, false); }

const pct = x => `${Math.round(x * 100)}%`;
const setRing = (el, share) => { requestAnimationFrame(() => el.style.setProperty('--p', Math.round(Math.max(0, Math.min(1, share)) * 100))); };
// "Je ___ là" → the blank, empty or filled. Two blanks take an answer written "a / b".
function blankHtml(text, fill = '', cls = '') {
  const blanks = (text.match(/_{2,}/g) || []).length;
  const parts = fill && blanks > 1 && fill.split(' / ').length === blanks ? fill.split(' / ') : null;
  let i = 0;
  return esc(text).replace(/_{2,}/g, () => {
    const f = parts ? parts[i++] : (i++ === 0 ? fill : '');
    return `<span class="blank ${cls}">${f ? esc(f) : '&nbsp;'}</span>`;
  });
}
// one row of level buttons with a progress ring each (shared by Grammar and Vocab)
function levelPathHtml(levels, current, info) {
  return levels.map(l => {
    const { share, sub } = info(l);
    return `<button role="radio" data-lvl="${l}" class="lvl${l === current ? ' on' : ''}${share >= 1 ? ' full' : ''}" aria-checked="${l === current}">
      <span class="pring lvl-ring" style="--p:${Math.round(Math.min(1, share) * 100)}"><b>${l}</b></span><small>${esc(sub)}</small></button>`;
  }).join('');
}

async function renderPractice() {
  if (quiz) return; // mid-quiz: leave it as it is
  showGramStage('home');
  try { await loadGrammar(); }
  catch {
    $('#rec-title').textContent = 'Couldn’t load the questions';
    $('#rec-reason').textContent = 'Open the app once while online and they’ll be saved for offline use.';
    return;
  }
  gramStats = (await db.getMeta('grammar')) || {};
  const rec = recommend(gramData, gramStats, profile.level);
  const levels = [...new Set(gramData.topics.map(t => t.level))];
  if (gramLevelFor !== profile.level || !levels.includes(gramLevel)) { gramLevel = rec.level; gramLevelFor = profile.level; }

  // glass card: the one topic to do next
  const p = rec.progress;
  $('#rec-card').dataset.cat = rec.topic.cat;
  $('#rec-level').textContent = rec.topic.level;
  $('#rec-title').textContent = rec.topic.title;
  $('#rec-hint').textContent = rec.topic.hint;
  $('#rec-reason').textContent = rec.reason;
  $('#rec-pct').textContent = pct(p.share);
  setRing($('#rec-ring'), p.share);
  const start = $('#rec-start');
  start.disabled = false;
  start.textContent = `${p.seen ? 'Continue' : 'Start'} · ${quizLen} questions`;
  start.onclick = () => { haptic(); startQuiz({ kind: 'topic', topicId: rec.topic.id }); };
  $('#rec-lesson').onclick = () => { haptic(); openTopicSheet(rec.topic); };

  const all = Object.values(gramStats);
  const answered = all.reduce((n, x) => n + x.c + x.w, 0);
  const done = gramData.topics.filter(t => progressOf(t).share >= MASTERED).length;
  $('#gs-mastered').textContent = `${done}/${gramData.topics.length}`;
  $('#gs-acc').textContent = answered ? pct(all.reduce((n, x) => n + x.c, 0) / answered) : '–';
  $('#gs-today').textContent = (activity[dayKey()]?.g || 0).toLocaleString();

  // levels
  $('#gram-levels').innerHTML = levelPathHtml(levels, gramLevel, l => {
    const lp = levelProgress(l, gramData, gramStats);
    return { share: lp.share, sub: `${lp.mastered}/${lp.topics}` };
  });

  // quick sessions
  const wrong = mistakes(gramData, gramStats).length;
  $('#quick-mixed-sub').textContent = `${gramLevel} · all topics together`;
  $('#quick-mistakes-sub').textContent = wrong ? `${wrong} question${wrong === 1 ? '' : 's'} to get right` : 'Nothing to fix';
  $('#quick-mistakes').disabled = !wrong;

  // topics of the chosen level
  const topics = gramData.topics.filter(t => t.level === gramLevel);
  const lp = levelProgress(gramLevel, gramData, gramStats);
  $('#gram-topics-title').textContent = `${gramLevel} · ${LEVEL_NAMES[gramLevel] || 'Topics'}`;
  $('#gram-topics-meta').textContent = `${lp.mastered} of ${lp.topics} mastered`;
  $('#gram-topics').innerHTML = topics.map((t, k) => {
    const tp = progressOf(t);
    const isDone = tp.share >= MASTERED;
    const sub = tp.seen ? `${tp.mastered}/${tp.count} right · ${pct(tp.accuracy)} accuracy` : t.hint;
    const side = isDone ? `<span class="topic-check">${CHECK}</span>` : tp.seen ? `<span class="topic-pct">${pct(tp.share)}</span>` : '<span class="topic-new">New</span>';
    return `<button class="topic cat-${esc(t.cat)}${t.id === rec.topic.id ? ' is-rec' : ''}${isDone ? ' done' : ''}" data-topic="${esc(t.id)}" style="--i:${k}">
      <span class="glyph${t.glyph.length > 4 ? ' sm' : ''}">${esc(t.glyph)}</span>
      <span class="topic-main">
        <span class="topic-title">${esc(t.title)}${t.id === rec.topic.id ? '<em>Up next</em>' : ''}</span>
        <span class="topic-sub">${esc(sub)}</span>
        <span class="meter"><i style="width:${Math.round(Math.min(1, tp.share / MASTERED) * 100)}%"></i></span>
      </span>
      ${side}
    </button>`;
  }).join('');
  const cats = [...new Set(topics.map(t => t.cat))];
  $('#cat-legend').innerHTML = cats.map(c => `<span class="cat-${esc(c)}"><i></i>${esc(gramData.categories?.[c] || c)}</span>`).join('');
}
$('#gram-levels').addEventListener('click', e => {
  const b = e.target.closest('[data-lvl]');
  if (!b || b.dataset.lvl === gramLevel) return;
  haptic(); gramLevel = b.dataset.lvl; renderPractice();
});
$('#gram-topics').addEventListener('click', e => { const b = e.target.closest('[data-topic]'); if (b) { haptic(); openTopicSheet(gramData.byId.get(b.dataset.topic)); } });
$('#quick-mixed').addEventListener('click', () => { haptic(); startQuiz({ kind: 'mixed', level: gramLevel }); });
$('#quick-mistakes').addEventListener('click', () => { haptic(); startQuiz({ kind: 'mistakes' }); });

// A topic's mini lesson: the rule in a few lines, examples, your numbers, and a Start button.
function openTopicSheet(t, { readOnly = false } = {}) {
  const tp = progressOf(t);
  const lens = QUIZ_LENGTHS.map(n => `<button role="radio" data-len="${n}" class="${n === quizLen ? 'on' : ''}" aria-checked="${n === quizLen}">${n}</button>`).join('');
  openSheet(t.title, `
    <div class="lesson cat-${esc(t.cat)}">
      <div class="lesson-head">
        <span class="glyph big${t.glyph.length > 4 ? ' sm' : ''}">${esc(t.glyph)}</span>
        <div><b>${esc(t.title)}</b><small>${esc(t.level)} · ${esc(catName(t))}</small><small>${esc(t.hint)}</small></div>
      </div>
      <div class="lesson-stats">
        <div><b>${tp.mastered}<i>/${tp.count}</i></b><span>right last time</span></div>
        <div><b>${tp.accuracy === null ? '–' : pct(tp.accuracy)}</b><span>accuracy</span></div>
        <div><b>${tp.count - tp.seen}</b><span>not seen yet</span></div>
      </div>
      ${t.points?.length ? `<h3>The rule</h3><ul class="lesson-points">${t.points.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${t.examples?.length ? `<h3>Examples</h3><div class="lesson-examples">${t.examples.map(([fr, en]) => `<div><b lang="fr">${esc(fr)}</b><span>${esc(en)}</span></div>`).join('')}</div>` : ''}
      ${readOnly ? '' : `
        <h3>Questions per session</h3>
        <div class="segmented len-seg" id="len-seg" role="radiogroup" aria-label="Questions per session">${lens}</div>
        <button class="btn btn-primary btn-large lesson-start" id="lesson-start">${tp.seen ? 'Continue' : 'Start'} · ${quizLen} questions</button>`}
    </div>`);
  if (readOnly) return;
  $('#len-seg').addEventListener('click', e => {
    const b = e.target.closest('[data-len]');
    if (!b) return;
    haptic();
    quizLen = Number(b.dataset.len);
    db.setMeta('quizLen', quizLen);
    for (const x of $$('#len-seg button')) { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); }
    $('#lesson-start').textContent = `${tp.seen ? 'Continue' : 'Start'} · ${quizLen} questions`;
  });
  $('#lesson-start').addEventListener('click', async () => { haptic(); await closeSheet(); startQuiz({ kind: 'topic', topicId: t.id }); });
}

function showGramStage(stage) {
  $('#gram-home').hidden = stage !== 'home';
  $('#gram-quiz').hidden = stage !== 'quiz';
  $('#gram-done').hidden = stage !== 'done';
  $('#view-grammar').classList.toggle('quizzing', stage !== 'home');
  window.scrollTo(0, 0);
}

// spec: { kind: 'topic', topicId } | { kind: 'mixed', level } | { kind: 'mistakes' }
function startQuiz(spec) {
  const topic = spec.kind === 'topic' ? gramData.byId.get(spec.topicId) : null;
  const picked = spec.kind === 'topic' ? pickQuestions(spec.topicId, gramData.byTopic.get(spec.topicId), gramStats, quizLen)
    : spec.kind === 'mixed' ? pickMixed(spec.level, gramData, gramStats, quizLen)
    : pickMistakes(gramData, gramStats, quizLen);
  if (!picked.length) { toast('Nothing to practise here yet'); return; }
  const title = topic ? topic.title : spec.kind === 'mixed' ? `${spec.level} level mix` : 'Fix mistakes';
  quiz = { spec, topic, title, items: picked.map(q => ({ q, ...shuffleOptions(q) })), i: 0, right: 0, streak: 0, answered: false, results: [] };
  $('#grammar-nav-title').textContent = title;
  showGramStage('quiz');
  showQuestion();
}

function renderDots() {
  const { items, i, results } = quiz;
  $('#quiz-dots').innerHTML = items.map((_, k) =>
    `<i class="${results[k] === true ? 'ok' : results[k] === false ? 'no' : k === i ? 'now' : ''}"></i>`).join('');
}

function showQuestion() {
  const { items, i } = quiz;
  const it = items[i];
  const t = gramData.byId.get(it.q.t);
  quiz.answered = false;
  $('#quiz-stage').dataset.cat = t.cat;
  $('#quiz-topic').textContent = `${t.level} · ${t.title}`;
  $('#quiz-count').textContent = `${i + 1} / ${items.length}`;
  renderDots();
  const q = $('#quiz-q');
  q.innerHTML = blankHtml(it.q.q);
  q.classList.remove('pop');
  q.classList.toggle('long', it.q.q.length > 90);
  $('#quiz-options').innerHTML = it.options.map((o, k) =>
    `<button class="opt" data-k="${k}" style="--i:${k}"><span class="opt-key">${'ABCD'[k] || k + 1}</span><span class="opt-text" lang="fr">${esc(o)}</span></button>`).join('');
  $('#quiz-feedback').hidden = true;
  $('#quiz-next').hidden = true;
  window.scrollTo(0, 0);
}

$('#quiz-options').addEventListener('click', async e => {
  const b = e.target.closest('.opt');
  if (!b || !quiz || quiz.answered) return;
  quiz.answered = true;
  const it = quiz.items[quiz.i];
  const k = Number(b.dataset.k);
  const ok = k === it.answer;
  try { navigator.vibrate?.(ok ? 10 : [12, 60, 12]); } catch {}
  for (const x of $$('#quiz-options .opt')) {
    const xk = Number(x.dataset.k);
    x.disabled = true;
    x.classList.toggle('right', xk === it.answer);
    x.classList.toggle('wrong', xk === k && !ok);
    x.classList.toggle('dim', xk !== it.answer && xk !== k);
  }
  const answerText = it.options[it.answer];
  // short answers slot into the sentence; whole-sentence answers just get highlighted below
  if (answerText.length <= 30 && answerText !== '∅') $('#quiz-q').innerHTML = blankHtml(it.q.q, answerText, 'filled');
  $('#quiz-q').classList.add('pop');
  quiz.results[quiz.i] = ok;
  if (ok) { quiz.right++; quiz.streak++; } else quiz.streak = 0;
  renderDots();
  const streak = $('#quiz-streak');
  streak.hidden = quiz.streak < 2;
  streak.textContent = `🔥 ${quiz.streak}`;
  if (quiz.streak >= 2) { streak.classList.remove('bump'); void streak.offsetWidth; streak.classList.add('bump'); }
  $('#quiz-verdict').textContent = ok ? (quiz.streak >= 3 ? `Correct! ${quiz.streak} in a row` : 'Correct!') : `Answer: ${answerText === '∅' ? 'nothing (no preposition)' : answerText}`;
  $('#quiz-feedback').className = `quiz-feedback ${ok ? 'good' : 'bad'}`;
  const why = explain(it.q);
  $('#quiz-expl').textContent = why;
  $('#quiz-feedback').hidden = false;
  $('#quiz-next').hidden = false;
  $('#quiz-next').textContent = quiz.i + 1 < quiz.items.length ? 'Continue' : 'See Results';
  requestAnimationFrame(() => $('#quiz-next').scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  record(gramStats, it.q.id, ok);
  await db.setMeta('grammar', gramStats);
  logActivity('g');
});
$('#quiz-rule').addEventListener('click', () => {
  if (!quiz) return;
  haptic();
  openTopicSheet(gramData.byId.get(quiz.items[quiz.i].q.t), { readOnly: true });
});

$('#quiz-next').addEventListener('click', () => {
  haptic();
  if (!quiz) return;
  quiz.i++;
  if (quiz.i < quiz.items.length) showQuestion(); else finishQuiz();
});

function finishQuiz() {
  const { spec, topic, title, right, items, results } = quiz;
  const n = items.length, share = n ? right / n : 0;
  const [art, cls, h, line] = share >= 0.8 ? ['cool', 'm-cool', 150, 'Très bien\u00a0!']
    : share >= 0.5 ? ['coffee', 'm-coffee', 150, 'Pas mal\u00a0!'] : ['belly', 'm-belly', 96, 'On continue\u00a0!'];
  $('#gram-done-mascot').className = `mascot ${cls}`;
  $('#gram-done-mascot').innerHTML = `<img src="art/${art}.webp" alt="" height="${h}"><span class="bubble">${line}</span>`;
  $('#gram-score').innerHTML = `${right}<i>/${n}</i>`;
  const ring = $('#gram-score-ring');
  ring.classList.toggle('great', share >= 0.8);
  ring.style.setProperty('--p', 0);
  setTimeout(() => setRing(ring, share), 120);
  $('#gram-done-title').textContent = share === 1 ? 'Perfect score' : share >= 0.8 ? 'Great session' : share >= 0.5 ? 'Good work' : 'Keep going';
  if (topic) {
    const tp = progressOf(topic);
    $('#gram-done-text').textContent = tp.share >= MASTERED
      ? `${topic.title} is mastered: ${tp.mastered} of ${tp.count} questions right.`
      : `${topic.title}: ${tp.mastered} of ${tp.count} right so far. ${share < 0.8 ? 'The ones you missed come back first next time.' : 'Keep going!'}`;
  } else if (spec.kind === 'mistakes') {
    const left = mistakes(gramData, gramStats).length;
    $('#gram-done-text').textContent = left ? `${right} fixed. ${left} still to get right.` : 'Every mistake is fixed. Nothing left to repair!';
  } else {
    $('#gram-done-text').textContent = `${title}: ${right} of ${n} right across ${new Set(items.map(it => it.q.t)).size} topics.`;
  }
  // the ones to look at again, with the right answer in place
  const missed = items.filter((_, k) => results[k] === false);
  $('#gram-missed').hidden = !missed.length;
  $('#gram-missed-list').innerHTML = missed.map(it => {
    const ans = it.options[it.answer];
    const t = gramData.byId.get(it.q.t);
    const body = ans.length <= 30 && ans !== '∅' && /_{2,}/.test(it.q.q) ? blankHtml(it.q.q, ans, 'filled') : `${blankHtml(it.q.q)}<span class="missed-ans">${esc(ans === '∅' ? 'no preposition' : ans)}</span>`;
    return `<div class="row missed"><span class="row-main"><span class="missed-q" lang="fr">${body}</span><span class="missed-why">${esc(explain(it.q))}</span>${topic ? '' : `<span class="missed-topic">${esc(t.title)}</span>`}</span></div>`;
  }).join('');

  const rec = recommend(gramData, gramStats, profile.level);
  const next = $('#gram-next-topic');
  next.hidden = !rec || (topic && rec.topic.id === topic.id);
  if (rec) { next.textContent = `Next: ${rec.topic.title}`; next.onclick = () => { haptic(); startQuiz({ kind: 'topic', topicId: rec.topic.id }); }; }
  const again = $('#gram-again');
  const canRepeat = spec.kind !== 'mistakes' || mistakes(gramData, gramStats).length > 0;
  again.hidden = !canRepeat;
  again.textContent = spec.kind === 'mistakes' ? 'Fix More' : 'Practice Again';
  again.onclick = () => { haptic(); startQuiz(spec); };
  $('#grammar-nav-title').textContent = 'Learn';
  $('#quiz-streak').hidden = true;
  quiz = null;
  showGramStage('done');
  if (share >= 0.8) confetti($('.gram-done-card'));
}

// a small burst of paper for a good session (pure CSS animation, removed when it ends)
function confetti(host) {
  if (!host || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  host.querySelector('.confetti')?.remove();
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#ff9f43', '#5e8bff', '#ff6b8b', '#06d6a0', '#8f6bff', '#ffd166'];
  box.innerHTML = Array.from({ length: 26 }, (_, k) =>
    `<i style="--x:${Math.round(Math.random() * 100)}%;--d:${(Math.random() * 0.5).toFixed(2)}s;--r:${Math.round(Math.random() * 360)}deg;--dx:${Math.round(Math.random() * 80 - 40)}px;background:${colors[k % colors.length]}"></i>`).join('');
  host.appendChild(box);
  setTimeout(() => box.remove(), 2600);
}

function endQuiz() {
  quiz = null;
  $('#grammar-nav-title').textContent = 'Learn';
  $('#quiz-streak').hidden = true;
  renderPractice();
}
$('#quiz-end').addEventListener('click', () => { haptic(); endQuiz(); });
$('#gram-back').addEventListener('click', () => { haptic(); renderPractice(); });

// ---------------------------------------------------------------- VOCAB (words to know at each level)
// Ready-made decks by level and theme. Adding a deck creates normal cards in a set named after it,
// so they are reviewed, exported and managed exactly like words that came from a reel.
let vocabData = null;
let vocabLevel = null;
let vocabLevelFor = null;

async function loadVocab() {
  if (vocabData) return vocabData;
  const r = await fetch('vocab.json');
  if (!r.ok) throw new Error('vocab.json');
  vocabData = await r.json();
  return vocabData;
}
const cardsByLemma = () => new Map(cards.map(c => [c.lemma.toLowerCase(), c]));
const deckSetName = (level, theme) => `${level} · ${theme.title}`.slice(0, 40);
function deckStats(words, idx, now = Date.now()) {
  let added = 0, learned = 0, due = 0;
  for (const w of words) {
    const c = idx.get(w[0].toLowerCase());
    if (!c) continue;
    added++;
    if (c.interval >= 21) learned++;
    if (c.due <= now) due++;
  }
  return { total: words.length, added, learned, due };
}

async function renderVocab() {
  try { await loadVocab(); }
  catch {
    $('#vocab-title').textContent = 'Couldn’t load the decks';
    $('#vocab-sub').textContent = 'Open the app once while online and they’ll be saved for offline use.';
    return;
  }
  const levels = vocabData.levels.map(l => l.level);
  if (vocabLevelFor !== profile.level || !levels.includes(vocabLevel)) { vocabLevel = nearestLevel(levelCode(profile.level), levels); vocabLevelFor = profile.level; }
  const idx = cardsByLemma();
  const level = vocabData.levels.find(l => l.level === vocabLevel);
  const all = deckStats(level.themes.flatMap(t => t.words), idx);

  $('#vocab-level-badge').textContent = vocabLevel;
  $('#vocab-title').textContent = `${LEVEL_NAMES[vocabLevel] || vocabLevel} essentials`;
  $('#vocab-sub').textContent = all.added === all.total ? `All ${all.total} words are in your cards.`
    : all.added ? `${all.total - all.added} of ${all.total} words still to add.` : `${all.total} words in ${level.themes.length} themed decks.`;
  $('#vocab-pct').textContent = pct(all.total ? all.added / all.total : 0);
  setRing($('#vocab-ring'), all.total ? all.added / all.total : 0);
  $('#vs-added').textContent = all.added.toLocaleString();
  $('#vs-learned').textContent = all.learned.toLocaleString();
  $('#vs-due').textContent = all.due.toLocaleString();

  $('#vocab-levels').innerHTML = levelPathHtml(levels, vocabLevel, l => {
    const s = deckStats(vocabData.levels.find(x => x.level === l).themes.flatMap(t => t.words), idx);
    return { share: s.total ? s.added / s.total : 0, sub: `${s.added}/${s.total}` };
  });
  $('#vocab-meta').textContent = `${level.themes.length} decks`;
  $('#vocab-themes').innerHTML = level.themes.map((t, k) => {
    const s = deckStats(t.words, idx);
    const full = s.added === s.total;
    return `<button class="deck${full ? ' full' : ''}" data-theme="${esc(t.id)}" style="--i:${k}">
      <span class="deck-icon" aria-hidden="true">${esc(t.icon)}</span>
      <b>${esc(t.title)}</b>
      <small>${full ? 'All added' : s.added ? `${s.added} of ${s.total} added` : `${s.total} words`}</small>
      <span class="meter"><i style="width:${Math.round((s.added / s.total) * 100)}%"></i></span>
      ${full ? `<span class="deck-check">${CHECK}</span>` : ''}
    </button>`;
  }).join('');
}
$('#vocab-levels').addEventListener('click', e => {
  const b = e.target.closest('[data-lvl]');
  if (!b || b.dataset.lvl === vocabLevel) return;
  haptic(); vocabLevel = b.dataset.lvl; renderVocab();
});
$('#vocab-themes').addEventListener('click', e => { const b = e.target.closest('[data-theme]'); if (b) { haptic(); openDeckSheet(b.dataset.theme); } });

const wordFront = w => (w[2] === 'noun' && w[3] ? `<span class="art">${w[3] === 'm' ? 'un' : w[3] === 'f' ? 'une' : 'un/une'} </span>` : '') + esc(w[0]);

function openDeckSheet(themeId) {
  const level = vocabData.levels.find(l => l.themes.some(t => t.id === themeId));
  const theme = level.themes.find(t => t.id === themeId);
  const draw = () => {
    const idx = cardsByLemma();
    const s = deckStats(theme.words, idx);
    const missing = s.total - s.added;
    const set = sets.find(x => x.name === deckSetName(level.level, theme));
    $('#sheet-body').innerHTML = `
      <div class="deck-sheet">
        <div class="lesson-head">
          <span class="deck-icon big" aria-hidden="true">${esc(theme.icon)}</span>
          <div><b>${esc(theme.title)}</b><small>${esc(level.level)} · ${s.total} words</small><small>${s.added ? `${s.added} in your cards${s.learned ? ` · ${s.learned} mastered` : ''}` : 'None in your cards yet'}</small></div>
        </div>
        ${missing ? `<button class="btn btn-primary btn-large" id="deck-add">Add ${missing === s.total ? `all ${missing}` : `${missing} more`} to Cards</button>` : ''}
        ${s.added ? `<button class="btn ${missing ? 'btn-secondary' : 'btn-primary btn-large'}" id="deck-review">${s.due ? `Review ${s.due} due now` : 'Open in Review'}</button>` : ''}
        <div class="list inset word-list">${theme.words.map((w, k) => `
          <div class="row word-row${idx.has(w[0].toLowerCase()) ? ' in' : ''}">
            <span class="row-main">
              <span class="row-title" lang="fr">${wordFront(w)}</span>
              <span class="row-sub">${esc(w[1])}</span>
              ${w[4] ? `<span class="word-ex" lang="fr">${esc(w[4])}</span>` : ''}
            </span>
            <button class="word-add" data-w="${k}" aria-label="${idx.has(w[0].toLowerCase()) ? 'In your cards' : `Add ${esc(w[0])}`}" ${idx.has(w[0].toLowerCase()) ? 'disabled' : ''}>${idx.has(w[0].toLowerCase()) ? CHECK : '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>'}</button>
          </div>`).join('')}
        </div>
      </div>`;
    $('#deck-add')?.addEventListener('click', () => addWords(theme.words.filter(w => !idx.has(w[0].toLowerCase()))));
    $('#deck-review')?.addEventListener('click', async () => {
      haptic();
      if (set) { reviewSet = set.id; await db.setMeta('reviewSet', reviewSet); }
      await closeSheet();
      showView('review');
    });
  };
  const addWords = async words => {
    if (!words.length) return;
    haptic();
    const name = deckSetName(level.level, theme);
    let set = sets.find(x => x.name === name);
    if (!set) { set = { id: uid(), name, createdAt: Date.now() }; sets.push(set); await saveSets(); }
    const now = Date.now();
    const added = await db.addCards(words.map((w, i) => ({
      id: uid(), lemma: w[0], word: w[0], pos: w[2], gender: w[3], meaning: w[1], example: w[4] || '',
      createdAt: now + i, setId: set.id, ...newCardState(now)
    })));
    if (added) await logActivity('n', added);
    await reloadCards();
    toast(added ? `${added} card${added === 1 ? '' : 's'} added` : 'Already in your cards');
    const top = $('#sheet-body').scrollTop;
    draw();
    $('#sheet-body').scrollTop = top;
    renderVocab();
  };
  openSheet(theme.title, '');
  draw();
  // one listener for the whole list (the list itself is redrawn after every add)
  $('#sheet-body').onclick = e => {
    const b = e.target.closest('.word-add');
    if (b && !b.disabled && $('#sheet-body .deck-sheet')) addWords([theme.words[Number(b.dataset.w)]]);
  };
}
$('#open-starter').addEventListener('click', () => { haptic(); grammarPane = 'vocab'; db.setMeta('grammarPane', 'vocab'); if (currentView === 'grammar') setGrammarPane('vocab'); else showView('grammar'); });

// ---------------------------------------------------------------- PROFILE
const AVATARS = [
  ['dog', 'Le Teckel'], ['penguin', 'Le Pingouin'], ['seal', 'Le Phoque'],
  ['bunny', 'Le Lapin'], ['panda', 'Le Panda roux'], ['duck', 'Le Canard']
];
let profile = { avatar: 'dog', name: '', age: '', native: '', level: '', goal: 20, location: '', why: '', since: Date.now() };
async function loadProfile() {
  const saved = await db.getMeta('profile');
  if (saved) profile = { ...profile, ...saved };
  else {
    const first = cards.reduce((m, c) => Math.min(m, c.createdAt || m), Date.now());
    profile.since = first;
    await db.setMeta('profile', profile);
  }
  applyAvatar();
}
const saveProfile = () => db.setMeta('profile', profile);
function applyAvatar() {
  const src = `avatars/${AVATARS.some(a => a[0] === profile.avatar) ? profile.avatar : 'dog'}.webp`;
  $('#tab-avatar').src = src;
  $('#profile-avatar').src = src;
}

function streaks() {
  const active = k => (activity[k]?.r || 0) > 0;
  const d = new Date(); d.setHours(12, 0, 0, 0);
  if (!active(dayKey(d))) d.setDate(d.getDate() - 1); // today not studied yet: streak can still continue
  let current = 0;
  while (active(dayKey(d))) { current++; d.setDate(d.getDate() - 1); }
  const days = Object.keys(activity).filter(active).sort();
  let longest = 0, run = 0, prev = null;
  for (const k of days) {
    const t = new Date(k + 'T12:00:00');
    run = prev && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run); prev = t;
  }
  return { current, longest, activeDays: days.length };
}

function renderProfile() {
  const p = profile;
  $('#profile-name').textContent = p.name || 'Add your name';
  $('#profile-name').style.opacity = p.name ? '' : '0.75';
  const since = new Date(p.since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  $('#profile-sub').textContent = [p.level && p.level.split(' · ')[0], p.age && `${p.age} yrs`, p.location, `Learning since ${since}`]
    .filter(Boolean).join(' · ');
  const st = streaks();
  const mastered = cards.filter(c => c.interval >= 21).length;
  $('#pill-streak').textContent = st.current;
  $('#pill-cards').textContent = cards.length;
  $('#pill-mastered').textContent = mastered;
  const today = activity[dayKey()]?.r || 0;
  const goal = Number(p.goal) || 20;
  $('#goal-text').textContent = today >= goal ? `${today} / ${goal} cards · goal met!` : `${today} / ${goal} cards`;
  requestAnimationFrame(() => { $('#goal-fill').style.width = `${Math.min(100, (today / goal) * 100)}%`; });

  // all-time stats
  const vals = Object.values(activity);
  const reviews = vals.reduce((n, d) => n + (d.r || 0), 0);
  const again = vals.reduce((n, d) => n + (d.a || 0), 0);
  const added = vals.reduce((n, d) => n + (d.n || 0), 0);
  const studied = cards.filter(c => c.lastReview).length;
  const acc = reviews ? Math.round(((reviews - again) / reviews) * 100) : null;
  const gStats = Object.values(gramStats);
  const grammarDone = gStats.reduce((n, x) => n + x.c + x.w, 0);
  const grammarAcc = grammarDone ? Math.round((gStats.reduce((n, x) => n + x.c, 0) / grammarDone) * 100) : null;
  const tile = (v, label, note = '') => `<div class="stat"><b>${v}</b><span>${label}</span>${note ? `<em>${note}</em>` : ''}</div>`;
  $('#stat-grid').innerHTML = [
    tile(reviews.toLocaleString(), 'Cards reviewed', 'every flip you graded'),
    tile(studied.toLocaleString(), 'Words studied', `of ${cards.length} in your library`),
    tile(added.toLocaleString(), 'Words added', 'from reels & screenshots'),
    tile(acc === null ? '–' : `${acc}%`, 'Recall rate', 'answers not marked Again'),
    tile(st.longest, 'Longest streak', st.longest === 1 ? 'day' : 'days'),
    tile(st.activeDays, 'Active days', 'days with a review'),
    tile(grammarDone.toLocaleString(), 'Grammar answers', 'practice questions'),
    tile(grammarAcc === null ? '–' : `${grammarAcc}%`, 'Grammar accuracy', 'answers you got right')
  ].join('');

  // form
  $('#pf-name').value = p.name; $('#pf-age').value = p.age; $('#pf-native').value = p.native;
  $('#pf-level').value = p.level; $('#pf-goal').value = String(goal); $('#pf-location').value = p.location; $('#pf-why').value = p.why;
  renderHeatmap();
}

// GitHub-style grid: one column per week (Sun→Sat), newest week on the right, sized to fit the phone.
function renderHeatmap() {
  const wrap = $('#heatmap-wrap');
  const gap = 3;
  const avail = wrap.clientWidth - 30; // minus the weekday labels
  const cell = 13;
  const weeks = Math.max(8, Math.min(53, Math.floor((avail + gap) / (cell + gap))));
  const size = Math.floor((avail - gap * (weeks - 1)) / weeks);
  wrap.style.setProperty('--cell', `${size}px`);
  wrap.style.setProperty('--gap', `${gap}px`);

  const goal = Number(profile.goal) || 20;
  const level = r => !r ? 0 : r >= goal ? 4 : r >= goal / 2 ? 3 : r >= goal / 4 ? 2 : 1;
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - today.getDay() - (weeks - 1) * 7);
  const todayKey = dayKey(today);
  let html = '', months = '', lastMonth = -1, total = 0;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(start); day.setDate(start.getDate() + w * 7 + d);
      const k = dayKey(day);
      const r = activity[k]?.r || 0;
      total += day <= today ? r : 0;
      const cls = [`l${level(r)}`, k === todayKey ? 'today' : '', day > today ? 'future' : ''].filter(Boolean).join(' ');
      html += `<i class="${cls}" data-k="${k}" data-r="${r}" role="gridcell" aria-label="${r} reviews on ${k}"></i>`;
      if (d === 0 && day.getMonth() !== lastMonth && day.getDate() <= 7 && w < weeks - 1) {
        lastMonth = day.getMonth();
        months += `<span style="left:${w * (size + gap)}px">${day.toLocaleDateString(undefined, { month: 'short' })}</span>`;
      }
    }
  }
  $('#heatmap').innerHTML = html;
  $('#heatmap-months').innerHTML = months;
  const span = weeks >= 52 ? 'the last year' : `the last ${Math.round(weeks / 4.35)} months`;
  $('#activity-head').innerHTML = `<b>${total.toLocaleString()}</b> card${total === 1 ? '' : 's'} reviewed in ${span}`;
  $('#heat-tip').textContent = 'Tap a square to see that day.';
}
$('#heatmap').addEventListener('click', e => {
  const c = e.target.closest('i');
  if (!c || c.classList.contains('future')) return;
  for (const x of $$('#heatmap i.sel')) x.classList.remove('sel');
  c.classList.add('sel');
  const r = Number(c.dataset.r);
  const n = activity[c.dataset.k]?.n || 0;
  const date = new Date(c.dataset.k + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  $('#heat-tip').textContent = `${date}: ${r} review${r === 1 ? '' : 's'}${n ? `, ${n} added` : ''}`;
});
window.addEventListener('resize', () => { if (currentView === 'profile') renderHeatmap(); });

function bindProfileField(id, key, transform = v => v) {
  const el = $(id);
  const handler = async () => { profile[key] = transform(el.value.trim()); await saveProfile(); renderProfile(); };
  el.addEventListener('change', handler);
}
bindProfileField('#pf-name', 'name');
bindProfileField('#pf-age', 'age', v => (v && Number(v) > 0 && Number(v) < 121 ? String(Math.round(Number(v))) : ''));
bindProfileField('#pf-native', 'native');
bindProfileField('#pf-level', 'level');
bindProfileField('#pf-goal', 'goal', v => Number(v) || 20);
bindProfileField('#pf-location', 'location');
bindProfileField('#pf-why', 'why');

$('#avatar-btn').addEventListener('click', () => {
  haptic();
  openSheet('Profile Picture', `<div class="avatar-grid">${AVATARS.map(([id, name]) => `
    <button class="avatar-opt${profile.avatar === id ? ' on' : ''}" data-av="${id}"><img src="avatars/${id}.webp" alt="">${esc(name)}</button>`).join('')}</div>`);
  for (const b of $$('#sheet-body [data-av]')) b.addEventListener('click', async () => {
    haptic();
    profile.avatar = b.dataset.av;
    await saveProfile();
    applyAvatar();
    for (const x of $$('#sheet-body .avatar-opt')) x.classList.toggle('on', x === b);
    setTimeout(closeSheet, 250);
  });
});

// ---------------------------------------------------------------- export
async function exportCsv() {
  if (!cards.length) { toast('No cards to export yet'); return; }
  const list = [...cards].sort((a, b) => a.createdAt - b.createdAt).map(c => ({ ...c, deck: setName(c.setId) }));
  const csv = toAnkiCsv(list);
  const name = `french-reel-cards-${new Date().toISOString().slice(0, 10)}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Reel Cards for Anki' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Exported ${cards.length} cards`);
}
$('#export-btn').addEventListener('click', exportCsv);
$('#export-btn-2').addEventListener('click', exportCsv);

// ---------------------------------------------------------------- boot
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    Promise.all([reloadCards(), loadSets()]).then(() => { if (currentView === 'library') renderLibrary(); });
    checkInbox();
  }
});

(async function boot() {
  await Promise.all([reloadCards(), loadSets()]);
  await loadActivity();
  await loadProfile();
  direction = (await db.getMeta('direction')) || 'fr-en';
  reviewSet = (await db.getMeta('reviewSet')) || 'all';
  saveToSet = (await db.getMeta('lastSetId')) || null;
  await renderInboxBanner();
  grammarPane = (await db.getMeta('grammarPane')) || 'practice';
  gramStats = (await db.getMeta('grammar')) || {};
  quizLen = QUIZ_LENGTHS.includes(await db.getMeta('quizLen')) ? await db.getMeta('quizLen') : 10;
  let tab = new URLSearchParams(location.search).get('tab');
  if (tab === 'verbs' || tab === 'practice' || tab === 'vocab') { grammarPane = tab; tab = 'grammar'; }
  if (tab === 'learn') tab = 'grammar';
  showView(tab || (dueCards().length ? 'review' : 'add'));
  ping(60_000); // start waking the free server right away, in the background
  checkInbox();
  if ('serviceWorker' in navigator) {
    // When a new release has been downloaded in the background, switch to it once, cleanly.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      // don't yank the page away mid-upload or mid-review
      const busy = activeUpload || (currentView === 'review' && current) || quiz;
      if (busy) toast('Update ready. It applies next time you open the app.'); else location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  }
})();
