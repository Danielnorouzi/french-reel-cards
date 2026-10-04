// Backup and restore: one file that carries everything the app keeps on the phone
// (cards with their review schedule, sets, activity log, grammar progress, profile and settings),
// so you can move to another phone, browser or address and carry on where you left off.
// Nothing here talks to a server. The optional password locks the file with AES-256.
// This file has no DOM code, so the same functions run in the tests under Node.

export const BACKUP_APP = 'french-reel-cards';
export const BACKUP_FORMAT = 1;
// What travels in a backup. Left out on purpose: the Shortcut inbox code and its waiting results
// (they belong to one phone and one address) and the verb cache (it refills itself).
export const BACKUP_KEYS = ['profile', 'activity', 'sets', 'grammar', 'direction', 'reviewSet', 'lastSetId', 'grammarPane', 'quizLen', 'verbRecent'];
export const MAX_BACKUP_BYTES = 40 * 1024 * 1024;
const KDF_ITERATIONS = 600_000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 2000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const count = v => Math.max(0, Math.round(num(v)));
const newId = () => (globalThis.crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export class BackupError extends Error {
  constructor(message, code) { super(message); this.name = 'BackupError'; this.code = code; }
}

// ------------------------------------------------------------------ cleaning
// A backup is a file from outside the app, so every value is checked before it reaches the database.
function cleanCard(c, now) {
  if (!isObj(c)) return null;
  const lemma = str(c.lemma, 200).trim();
  if (!lemma) return null;
  const out = {};
  for (const [k, v] of Object.entries(c)) {               // keep extra simple fields a newer version may add
    if (k === 'relearning' || k === '__proto__') continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
  }
  const createdAt = num(c.createdAt, now);
  return {
    ...out,
    id: str(c.id, 80) || newId(),
    lemma,
    word: str(c.word ?? lemma, 200),
    pos: str(c.pos, 20),
    gender: str(c.gender, 10),
    meaning: str(c.meaning),
    example: str(c.example),
    setId: c.setId ? str(c.setId, 80) : null,
    createdAt,
    ease: Math.min(5, Math.max(1.3, num(c.ease, 2.5))),
    interval: Math.max(0, num(c.interval)),
    reps: count(c.reps),
    lapses: count(c.lapses),
    due: num(c.due, createdAt),
    lastReview: c.lastReview ? num(c.lastReview, null) : null
  };
}

function cleanMeta(meta) {
  const m = isObj(meta) ? meta : {};
  const out = {};
  if (isObj(m.profile)) {
    const p = m.profile;
    out.profile = {
      avatar: str(p.avatar, 20) || 'dog', name: str(p.name, 40), age: str(p.age, 3), native: str(p.native, 30),
      level: str(p.level, 40), goal: Math.min(1000, Math.max(1, count(p.goal) || 20)),
      location: str(p.location, 40), why: str(p.why, 200), since: num(p.since, Date.now())
    };
  }
  if (isObj(m.activity)) {
    out.activity = {};
    for (const [k, d] of Object.entries(m.activity)) {
      if (DAY_KEY.test(k) && isObj(d)) out.activity[k] = { r: count(d.r), a: count(d.a), n: count(d.n) };
    }
  }
  if (Array.isArray(m.sets)) {
    const seen = new Set();
    out.sets = [];
    for (const s of m.sets) {
      const id = isObj(s) ? str(s.id, 80) : '', name = isObj(s) ? str(s.name, 40).trim() : '';
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      out.sets.push({ id, name, createdAt: num(s.createdAt, Date.now()) });
    }
  }
  if (isObj(m.grammar)) {
    out.grammar = {};
    for (const [id, s] of Object.entries(m.grammar)) {
      if (id !== '__proto__' && id.length <= 80 && isObj(s)) out.grammar[id] = { c: count(s.c), w: count(s.w), l: num(s.l), k: s.k ? 1 : 0 };
    }
  }
  if (m.direction === 'fr-en' || m.direction === 'en-fr') out.direction = m.direction;
  if (typeof m.reviewSet === 'string') out.reviewSet = str(m.reviewSet, 80);
  if (typeof m.lastSetId === 'string') out.lastSetId = str(m.lastSetId, 80);
  if (typeof m.grammarPane === 'string') out.grammarPane = str(m.grammarPane, 20);
  if (Number.isFinite(m.quizLen)) out.quizLen = m.quizLen;
  if (Array.isArray(m.verbRecent)) out.verbRecent = m.verbRecent.filter(v => typeof v === 'string').map(v => v.slice(0, 60)).slice(0, 20);
  return out;
}

// Returns clean { cards, meta }. Cards without a word are dropped; a word can only appear once.
export function sanitizeData(data, now = Date.now()) {
  const d = isObj(data) ? data : {};
  const cards = [], lemmas = new Set(), ids = new Set();
  for (const raw of Array.isArray(d.cards) ? d.cards : []) {
    const c = cleanCard(raw, now);
    if (!c || lemmas.has(c.lemma)) continue;
    if (ids.has(c.id)) c.id = newId();
    lemmas.add(c.lemma); ids.add(c.id);
    cards.push(c);
  }
  const meta = cleanMeta(d.meta);
  const known = new Set((meta.sets || []).map(s => s.id));
  for (const c of cards) if (c.setId && !known.has(c.setId)) c.setId = null;
  return { cards, meta };
}

// ------------------------------------------------------------------ summary
function longestStreak(days) {
  let longest = 0, run = 0, prev = null;
  for (const k of [...days].sort()) {
    const t = new Date(k + 'T12:00:00').getTime();
    run = prev !== null && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run); prev = t;
  }
  return longest;
}

// The numbers shown on the Backup and Restore screens.
export function summarize(data) {
  const cards = data?.cards || [], meta = data?.meta || {};
  const days = Object.values(meta.activity || {});
  const studied = Object.keys(meta.activity || {}).filter(k => (meta.activity[k].r || 0) > 0);
  const grammar = Object.values(meta.grammar || {});
  return {
    cards: cards.length,
    mastered: cards.filter(c => c.interval >= 21).length,
    sets: (meta.sets || []).length,
    reviews: days.reduce((n, d) => n + (d.r || 0), 0),
    daysStudied: studied.length,
    longestStreak: longestStreak(studied),
    grammarAnswers: grammar.reduce((n, s) => n + (s.c || 0) + (s.w || 0), 0),
    name: meta.profile?.name || ''
  };
}
export const isEmptyData = data => !data?.cards?.length && !Object.keys(data?.meta?.activity || {}).length
  && !Object.keys(data?.meta?.grammar || {}).length && !(data?.meta?.sets || []).length;

// ------------------------------------------------------------------ building the file
export function buildBackup(data, { now = Date.now(), from = '' } = {}) {
  const clean = sanitizeData(data, now);
  return { app: BACKUP_APP, kind: 'backup', format: BACKUP_FORMAT, createdAt: now, from: str(from, 200), summary: summarize(clean), data: clean };
}
export function backupFileName(now = Date.now()) {
  const d = new Date(now), p = n => String(n).padStart(2, '0');
  return `reel-cards-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}
export const backupToText = backup => JSON.stringify(backup);

// ------------------------------------------------------------------ password lock (AES-256-GCM, key from PBKDF2-SHA256)
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new BackupError('Password locking needs a secure (https) address.', 'no-crypto');
  return s;
};
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text) {
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Only the date stays readable in a locked file; cards, stats and profile are all inside the locked part.
export async function lockBackup(backup, password, { iterations = KDF_ITERATIONS } = {}) {
  if (!password) throw new BackupError('Enter a password to lock the backup.', 'no-password');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const plain = new TextEncoder().encode(JSON.stringify({ from: backup.from, summary: backup.summary, data: backup.data }));
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain));
  return {
    app: BACKUP_APP, kind: 'backup', format: backup.format, createdAt: backup.createdAt,
    locked: { cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations, salt: toBase64(salt), iv: toBase64(iv), text: toBase64(sealed) }
  };
}

export async function unlockBackup(file, password) {
  const l = file?.locked;
  if (!isObj(l) || typeof l.text !== 'string') throw new BackupError('This backup is not password locked.', 'not-locked');
  const iterations = count(l.iterations);
  if (l.cipher !== 'AES-256-GCM' || l.kdf !== 'PBKDF2-SHA256' || iterations < 1 || iterations > 5_000_000) {
    throw new BackupError('This backup uses a lock this version of the app cannot open.', 'unsupported');
  }
  let plain;
  try {
    const key = await deriveKey(password, fromBase64(l.salt), iterations);
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(l.iv) }, key, fromBase64(l.text));
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError('Wrong password, or the file is damaged.', 'wrong-password');
  }
  const inner = JSON.parse(new TextDecoder().decode(plain));
  return finish({ app: file.app, kind: 'backup', format: file.format, createdAt: file.createdAt, ...inner });
}

// ------------------------------------------------------------------ reading a file
function finish(file) {
  const data = sanitizeData(file.data);
  return { app: BACKUP_APP, kind: 'backup', format: file.format, createdAt: num(file.createdAt, 0), from: str(file.from, 200), summary: summarize(data), data };
}

// Returns { locked: true, file } when a password is needed, otherwise { locked: false, backup }.
export function readBackup(text) {
  if (typeof text !== 'string' || !text.trim()) throw new BackupError('That file is empty.', 'empty');
  if (text.length > MAX_BACKUP_BYTES) throw new BackupError('That file is too large to be a Reel Cards backup.', 'too-large');
  let file;
  try { file = JSON.parse(text.replace(/^﻿/, '')); }
  catch { throw new BackupError('That is not a Reel Cards backup file. (For a word list or an Anki file, use Import Words.)', 'not-json'); }
  if (!isObj(file) || file.app !== BACKUP_APP || file.kind !== 'backup') {
    throw new BackupError('That is not a Reel Cards backup file.', 'not-backup');
  }
  if (!Number.isInteger(file.format) || file.format < 1) throw new BackupError('That backup file is damaged.', 'bad-format');
  if (file.format > BACKUP_FORMAT) throw new BackupError('This backup was made by a newer version of the app. Update the app, then try again.', 'too-new');
  if (file.locked) return { locked: true, file };
  if (!isObj(file.data)) throw new BackupError('That backup file is damaged.', 'no-data');
  return { locked: false, backup: finish(file) };
}

// ------------------------------------------------------------------ merging
// Combines a backup with what is already on the phone, without counting anything twice:
//  - a word on both sides keeps the copy that was reviewed most recently
//  - sets with the same name become one set
//  - each day keeps the higher count; each grammar question keeps the record with more answers
//  - profile fields already filled in on this phone stay; blanks are filled from the backup
export function mergeData(current, incoming) {
  const cur = sanitizeData(current), inc = sanitizeData(incoming);
  const report = { added: 0, updated: 0, kept: 0, setsAdded: 0 };

  const sets = [...(cur.meta.sets || [])];
  const setMap = new Map();
  for (const s of inc.meta.sets || []) {
    const same = sets.find(x => x.id === s.id) || sets.find(x => x.name.toLowerCase() === s.name.toLowerCase());
    if (same) setMap.set(s.id, same.id);
    else { sets.push(s); setMap.set(s.id, s.id); report.setsAdded++; }
  }

  const cards = cur.cards.map(c => ({ ...c }));
  const byLemma = new Map(cards.map((c, i) => [c.lemma, i]));
  const ids = new Set(cards.map(c => c.id));
  for (const raw of inc.cards) {
    const c = { ...raw, setId: raw.setId ? setMap.get(raw.setId) ?? null : null };
    const i = byLemma.get(c.lemma);
    if (i === undefined) {
      if (ids.has(c.id)) c.id = newId();
      ids.add(c.id); byLemma.set(c.lemma, cards.length); cards.push(c);
      report.added++;
    } else if ((c.lastReview || 0) > (cards[i].lastReview || 0)) {
      const mine = cards[i];
      cards[i] = { ...c, id: mine.id, setId: c.setId || mine.setId, meaning: c.meaning || mine.meaning,
        example: c.example || mine.example, createdAt: Math.min(c.createdAt, mine.createdAt) };
      report.updated++;
    } else {
      const mine = cards[i];
      cards[i] = { ...mine, setId: mine.setId || c.setId, meaning: mine.meaning || c.meaning, example: mine.example || c.example,
        createdAt: Math.min(c.createdAt, mine.createdAt) };
      report.kept++;
    }
  }

  const activity = { ...(cur.meta.activity || {}) };
  for (const [k, d] of Object.entries(inc.meta.activity || {})) {
    const m = activity[k] || { r: 0, a: 0, n: 0 };
    activity[k] = { r: Math.max(m.r, d.r), a: Math.max(m.a, d.a), n: Math.max(m.n, d.n) };
  }

  const grammar = { ...(cur.meta.grammar || {}) };
  for (const [id, s] of Object.entries(inc.meta.grammar || {})) {
    const m = grammar[id];
    if (!m || s.c + s.w > m.c + m.w || (s.c + s.w === m.c + m.w && s.l > m.l)) grammar[id] = s;
  }

  const meta = { ...inc.meta, ...cur.meta, sets, activity, grammar };
  const a = cur.meta.profile, b = inc.meta.profile;
  if (a && b) {
    const blank = !a.name && !a.age && !a.native && !a.level && !a.location && !a.why; // never filled in on this phone
    meta.profile = blank ? { ...b } : { ...a };
    for (const k of ['name', 'age', 'native', 'level', 'location', 'why']) meta.profile[k] = meta.profile[k] || b[k] || '';
    meta.profile.since = Math.min(a.since, b.since);
  }
  meta.verbRecent = [...new Set([...(cur.meta.verbRecent || []), ...(inc.meta.verbRecent || [])])].slice(0, 20);
  if (!meta.verbRecent.length) delete meta.verbRecent;

  return { data: { cards, meta }, report };
}
