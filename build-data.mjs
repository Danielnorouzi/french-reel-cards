// Builds data/lexicon.json.gz from two free, openly licensed sources:
//   1. Dicollecte / Grammalecte French lexicon (MPL 2.0) — inflected form → lemma, part of speech, gender, frequency
//      https://grammalecte.net  (copy used: github.com/chrplr/openlexicon datasets-info/Dicollecte)
//   2. English Wiktionary French→English dictionary (CC BY-SA), exported as TSV by
//      github.com/Vuizur/Wiktionary-Dictionaries (data from kaikki.org / wiktextract)
//
// Usage: node scripts/build-data.mjs <dicollecte.txt> <wiktionary.tsv>
// The output maps every common French word form to 1–3 possible readings:
//   [lemma, pos, gender, meaning]
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

const [dicoPath, wiktPath] = process.argv.slice(2);
if (!dicoPath || !wiktPath) {
  console.error('Usage: node scripts/build-data.mjs <dicollecte.txt> <wiktionary.tsv>');
  process.exit(1);
}
const MIN_OCCURRENCES = 10; // drop ultra-rare forms to keep the file small

// ---------- Wiktionary ----------
const POS_MAP = { noun: 'noun', verb: 'verb', adj: 'adj', adv: 'adv', intj: 'intj', phrase: 'phrase', prep: 'prep', conj: 'conj', pron: 'pron', num: 'num' };
const heads = new Map(); // headword -> { pos: [senses] , forms:Set }
const formHeads = new Map(); // form -> Set(headword)

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
const FORM_OF = /^(\(.*?\)\s*)*(plural|feminine|masculine|singular|inflection|alternative|obsolete|archaic|dated|nonstandard|misspelling|superseded|eye dialect|pronunciation spelling|past participle|present participle|first-person|second-person|third-person|simple past|imperfect|future|conditional|subjunctive|imperative|abbreviation|initialism|synonym|clipping|contraction|elongated|apocopic|aphetic)\b.*\bof\b/i;

function cleanSense(s) {
  let t = stripHtml(s);
  // drop leading qualifier labels like "(transitive)" or "(informal, Quebec)"
  t = t.replace(/^(\([^)]*\)\s*)+/, '');
  // "Ellipsis of petite copine.: girlfriend" -> "girlfriend"
  t = t.replace(/^[^:]{0,60}\bof [^:]{1,40}\.?:\s*/, '');
  // drop usage notes in brackets and long explanatory parentheses
  t = t.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\([^)]{22,}\)/g, '');
  t = t.replace(/\s+/g, ' ').replace(/\s+([,;.])/g, '$1').trim();
  return t;
}

const wiktLines = fs.readFileSync(wiktPath, 'utf8').split('\n');
for (const line of wiktLines) {
  const tab = line.indexOf('\t');
  if (tab < 0) continue;
  const names = line.slice(0, tab).split('|');
  const head = names[0];
  if (!head || /\s/.test(head) && head.split(' ').length > 3) continue;
  const html = line.slice(tab + 1);
  let entry = heads.get(head);
  if (!entry) { entry = { pos: {}, forms: new Set() }; heads.set(head, entry); }
  const re = /<i>([a-z ]+)<\/i><br><ol>(.*?)<\/ol>/g;
  let m;
  while ((m = re.exec(html))) {
    const pos = POS_MAP[m[1]];
    if (!pos) continue;
    const senses = [...m[2].matchAll(/<li>(.*?)<\/li>/g)].map(x => x[1]);
    const clean = senses.map(stripHtml).filter(s => !FORM_OF.test(s)).map(cleanSense).filter(Boolean);
    if (!clean.length) continue;
    (entry.pos[pos] ||= []).push(...clean);
  }
  for (const f of names.slice(1)) {
    if (!f || /\s/.test(f) || f.includes('+')) continue;
    entry.forms.add(f);
    if (!formHeads.has(f)) formHeads.set(f, new Set());
    formHeads.get(f).add(head);
  }
}
console.log('wiktionary headwords:', heads.size);

function gloss(senses) {
  const out = [];
  let len = 0;
  for (const s of senses) {
    if (out.includes(s)) continue;
    if (out.length && len + s.length > 70) break;
    out.push(s.length > 90 ? s.slice(0, 88).replace(/[ ,;]+\S*$/, '') + '…' : s);
    len += s.length;
    if (out.length >= 3) break;
  }
  return out.join('; ');
}

// ---------- Dicollecte ----------
const analyses = new Map(); // form -> [{lemma, cats:[...], gender, occ}]
const nounGender = new Map(); // lemma -> 'm'|'f'|'m/f'

function catsFromTags(tags) {
  const t = tags.split(' ');
  const cats = [];
  if (t[0].startsWith('v') && /^v[0-3]/.test(t[0])) cats.push('verb');
  if (t.includes('ppas') || t.includes('ppre')) return cats; // participles: treat as the verb
  if (t.includes('nom')) cats.push('noun');
  if (t.includes('adj')) cats.push('adj');
  if (t.includes('adv') || t.includes('loc.adv')) cats.push('adv');
  if (t.includes('interj')) cats.push('intj');
  return cats;
}
function genderFromTags(tags) {
  const t = tags.split(' ');
  if (t.includes('epi')) return 'm/f';
  if (t.includes('mas')) return 'm';
  if (t.includes('fem')) return 'f';
  return '';
}

const rl = readline.createInterface({ input: fs.createReadStream(dicoPath, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  const c = line.split('\t');
  if (!/^\d+$/.test(c[0])) continue;
  const form = c[2].replace(/’/g, "'"), lemma = c[3].replace(/’/g, "'"), tags = c[4];
  // corpora split words on apostrophes, so aujourd'hui etc. show 0 occurrences — always keep those
  const occ = form.includes("'") ? MIN_OCCURRENCES : Number(c[15]) || 0;
  if (!form || !lemma) continue;
  // proper nouns and pronouns are never vocabulary cards
  if (tags.startsWith('npr') || tags.startsWith('prn')) continue;
  const cats = catsFromTags(tags);
  if (cats.includes('noun') && form === lemma) {
    const g = genderFromTags(tags);
    const prev = nounGender.get(lemma);
    if (g && (!prev || (prev !== g && g === 'm/f'))) nounGender.set(lemma, prev && prev !== g ? 'm/f' : g);
  }
  if (occ < MIN_OCCURRENCES || !cats.length) continue;
  if (!analyses.has(form)) analyses.set(form, []);
  analyses.get(form).push({ lemma, cats, occ });
}
console.log('dicollecte forms:', analyses.size);

// ---------- Join ----------
function resolve(form, lemma, pos) {
  // Pick the Wiktionary headword that best explains this form with this part of speech.
  const cands = new Set([lemma, form]);
  for (const h of formHeads.get(form) || []) cands.add(h);
  for (const h of formHeads.get(lemma) || []) cands.add(h);
  let best = null, bestScore = -1;
  const inflected = form !== lemma;
  for (const h of cands) {
    const e = heads.get(h);
    if (!e || !e.pos[pos]) continue;
    let score = 2;
    if (h === form || e.forms.has(form)) score += 2;
    if (h === lemma) score += 1;
    if ((h !== form) === inflected) score += 1;
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}

const records = [];
const recIndex = new Map();
const forms = {};
const ORDER = { noun: 0, adj: 1, verb: 2, adv: 3, intj: 4 };
for (const [form, list] of analyses) {
  const seen = new Set();
  const out = [];
  const flat = [];
  for (const a of list) {
    const both = a.cats.includes('noun') && a.cats.includes('adj');
    for (const pos of a.cats) flat.push({ lemma: a.lemma, pos, rank: ORDER[pos] - (both && pos === 'adj' ? 1.5 : 0) });
  }
  flat.sort((x, y) => x.rank - y.rank);
  for (const { lemma, pos } of flat) {
    const head = resolve(form, lemma, pos);
    if (!head) continue;
    const key = head + '|' + pos;
    if (seen.has(key)) continue;
    seen.add(key);
    const g = pos === 'noun' ? (nounGender.get(head) || nounGender.get(lemma) || '') : '';
    const meaning = gloss(heads.get(head).pos[pos]);
    if (!meaning) continue;
    const rec = [head, pos, g, meaning];
    const rk = rec.join('\u0001');
    let idx = recIndex.get(rk);
    if (idx === undefined) { idx = records.length; records.push(rec); recIndex.set(rk, idx); }
    out.push(idx);
    if (out.length >= 3) break;
  }
  if (out.length) forms[form] = out.length === 1 ? out[0] : out;
}
// Words Wiktionary knows but the lexicon doesn't (slang, newer words): add as a fallback.
let extra = 0;
const WORD = /^[a-zàâäçéèêëîïôöùûüÿœæ'-]+$/;
function addRec(rec) {
  const rk = rec.join('\u0001');
  let idx = recIndex.get(rk);
  if (idx === undefined) { idx = records.length; records.push(rec); recIndex.set(rk, idx); }
  return idx;
}
for (const [head, e] of heads) {
  if (!WORD.test(head)) continue;
  const pos = ['noun', 'verb', 'adj', 'adv', 'intj'].find(p => e.pos[p]);
  if (!pos) continue;
  const idx = addRec([head, pos, pos === 'noun' ? (nounGender.get(head) || '') : '', gloss(e.pos[pos])]);
  for (const f of [head, ...e.forms]) {
    if (!WORD.test(f) || forms[f] !== undefined) continue;
    forms[f] = idx; extra++;
  }
}
console.log('wiktionary-only forms added:', extra);
console.log('records:', records.length, 'forms:', Object.keys(forms).length);

// Multi-word expressions ("avoir le cafard", "coup de foudre") for the word-list import.
const phrases = {};
for (const [head, e] of heads) {
  if (!/\s/.test(head) || head.length > 40 || head.split(' ').length > 5 || !/^[a-zàâäçéèêëîïôöùûüÿœæ' -]+$/i.test(head)) continue;
  const pos = ['phrase', 'noun', 'verb', 'adj', 'adv', 'intj', 'prep', 'conj'].find(p => e.pos[p]);
  if (!pos) continue;
  phrases[head.toLowerCase()] = [pos, gloss(e.pos[pos])];
}
console.log('phrases:', Object.keys(phrases).length);

const json = JSON.stringify({
  v: 1,
  sources: {
    lemmas: 'Dicollecte/Grammalecte lexicon v6.4.1 (MPL 2.0)',
    meanings: 'English Wiktionary via kaikki.org / Vuizur Wiktionary-Dictionaries (CC BY-SA 4.0)'
  },
  records,
  forms,
  phrases
});
fs.writeFileSync(new URL('../data/lexicon.json.gz', import.meta.url), zlib.gzipSync(json, { level: 9 }));
console.log('wrote data/lexicon.json.gz', (json.length / 1e6).toFixed(1), 'MB raw');
