// Builds data/conjugations.json.gz: every conjugated form of ~8,000 French verbs, from the
// Dicollecte / Grammalecte lexicon (MPL 2.0). Compound tenses are built at request time.
// Usage: node scripts/build-conj.mjs <dicollecte.txt>
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

const [dicoPath] = process.argv.slice(2);
if (!dicoPath) { console.error('Usage: node scripts/build-conj.mjs <dicollecte.txt>'); process.exit(1); }

const TENSES = ['ipre', 'iimp', 'ipsi', 'ifut', 'cond', 'spre', 'simp', 'impe'];
const PERSONS = ['1sg', '2sg', '3sg', '1pl', '2pl', '3pl'];
const verbs = new Map(); // lemma -> { flags, occ, t: {tense: [Set x6]}, pp: [Set x4], pr: Set }

const rl = readline.createInterface({ input: fs.createReadStream(dicoPath, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  const c = line.split('\t');
  if (!/^\d+$/.test(c[0])) continue;
  const tags = c[4].split(' ');
  if (!/^v[0-3]/.test(tags[0])) continue;
  const form = c[2].replace(/’/g, "'"), lemma = c[3].replace(/’/g, "'");
  let v = verbs.get(lemma);
  if (!v) { v = { flags: tags[0], occ: 0, t: {}, pp: [new Set(), new Set(), new Set(), new Set()], pr: new Set() }; verbs.set(lemma, v); }
  if (tags.includes('infi')) v.occ = Math.max(v.occ, Number(c[15]) || 0);
  if (tags.includes('ppre')) v.pr.add(form);
  if (tags.includes('ppas')) {
    const fem = tags.includes('fem'), pl = tags.includes('pl'), inv = tags.includes('inv');
    if (inv) v.pp.forEach(s => s.add(form));
    else v.pp[(fem ? 1 : 0) + (pl ? 2 : 0)].add(form);
  }
  const persons = tags.map(t => t.replace('!', '')).filter(t => PERSONS.includes(t));
  for (const tense of tags.filter(t => TENSES.includes(t))) {
    const slots = v.t[tense] ||= PERSONS.map(() => new Set());
    for (const p of persons) slots[PERSONS.indexOf(p)].add(form);
  }
}

const MIN_OCC = 20; // skip ultra-rare verbs to keep the file small
const out = {};
for (const [lemma, v] of verbs) {
  if (v.occ < MIN_OCC && !lemma.includes("'")) continue;
  if (!v.t.ipre) continue;
  const join = s => [...s].join('/');
  out[lemma] = {
    f: v.flags,
    o: v.occ,
    t: Object.fromEntries(Object.entries(v.t).map(([k, slots]) => [k, slots.map(join)])),
    pp: v.pp.map(join),
    pr: join(v.pr)
  };
}
const json = JSON.stringify({ v: 1, source: 'Dicollecte/Grammalecte lexicon v6.4.1 (MPL 2.0)', verbs: out });
fs.writeFileSync(new URL('../data/conjugations.json.gz', import.meta.url), zlib.gzipSync(json, { level: 9 }));
console.log('verbs:', Object.keys(out).length, 'raw MB:', (json.length / 1e6).toFixed(1));
