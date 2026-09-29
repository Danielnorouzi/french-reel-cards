import { db } from './db.js';
import { schedule, preview, newCardState, formatInterval } from './sm2.js';
import { toAnkiCsv, article, frontText, posLabel } from './anki.js';

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
  (activity[k] ||= { r: 0, a: 0, n: 0 })[field] += n;
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
function showResults(results, fromInbox = false) {
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
      found.push({ ...c, selected: true });
    }
  }
  pendingResult = { cards: found, lines, fromInbox };

  const summary = found.length
    ? `Found ${found.length} new word${found.length === 1 ? '' : 's'}` + (skipped ? `. Skipped ${skipped} already in your library.` : '.')
    : lines.length
      ? `No new words this time${skipped ? ` (${skipped} already in your library)` : ''}.`
      : "Couldn't find any French text on screen. Try a clearer frame or a screenshot.";
  $('#results-summary').textContent = summary;

  const list = $('#results-list');
  list.hidden = !found.length;
  list.innerHTML = found.map((c, i) => `
    <button class="row on" data-i="${i}">
      <span class="toggle"><svg viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10"/></svg></span>
      <span class="row-main">
        <span class="row-title">${article(c) ? `<span class="art">${esc(article(c))} </span>` : ''}${esc(c.lemma)}</span>
        <span class="row-sub">${esc(c.meaning)}</span>
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
  const tile = (v, label, note = '') => `<div class="stat"><b>${v}</b><span>${label}</span>${note ? `<em>${note}</em>` : ''}</div>`;
  $('#stat-grid').innerHTML = [
    tile(reviews.toLocaleString(), 'Cards reviewed', 'every flip you graded'),
    tile(studied.toLocaleString(), 'Words studied', `of ${cards.length} in your library`),
    tile(added.toLocaleString(), 'Words added', 'from reels & screenshots'),
    tile(acc === null ? '–' : `${acc}%`, 'Recall rate', 'answers not marked Again'),
    tile(st.longest, 'Longest streak', st.longest === 1 ? 'day' : 'days'),
    tile(st.activeDays, 'Active days', 'days with a review')
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
  showView(new URLSearchParams(location.search).get('tab') || (dueCards().length ? 'review' : 'add'));
  ping(60_000); // start waking the free server right away, in the background
  checkInbox();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
