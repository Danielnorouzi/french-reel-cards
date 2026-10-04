// Builds public/vocab.json (the level word decks shown in Learn → Vocab) from data/vocab/*.txt.
// Run: npm run build-vocab            (add --check to compare genders and spellings with the lexicon)
//
// File format, one file per level (a1.txt, a2.txt…):
//   ## theme-id | Theme title | emoji
//   french | english | type | example sentence      (nouns with their article: le pain, l'eau, les gens)
// type: m, f, mf (nouns) · v · adj · adv · phr (phrase) · prep · conj · pron · num · intj
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'vocab');
const OUT = path.join(ROOT, 'public', 'vocab.json');
const CHECK = process.argv.includes('--check');
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const TYPES = { m: ['noun', 'm'], f: ['noun', 'f'], mf: ['noun', 'm/f'], v: ['verb', ''], adj: ['adj', ''], adv: ['adv', ''], phr: ['phrase', ''],
  prep: ['prep', ''], conj: ['conj', ''], pron: ['pron', ''], num: ['num', ''], intj: ['intj', ''] };
const typo = s => s.replace(/'/g, '’').replace(/\s+/g, ' ').trim();

const lex = CHECK ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'lexicon.json.gz')))) : null;
const genders = w => { // genders the lexicon lists for this noun
  const f = lex.forms[w]; if (f === undefined) return null;
  return [].concat(f).map(i => lex.records[i]).filter(r => r[0] === w && r[1] === 'noun').map(r => r[2]);
};

const levels = [];
const seen = new Map();
let problems = 0;
const warn = m => { problems++; console.warn(m); };
for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.txt')).sort()) {
  const level = path.basename(file, '.txt').toUpperCase();
  if (!LEVELS.includes(level)) { warn(`skip ${file}: not a level`); continue; }
  const themes = [];
  let theme = null;
  fs.readFileSync(path.join(SRC, file), 'utf8').split('\n').forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;
    const at = `${file}:${n + 1}`;
    if (line.startsWith('##')) {
      const [id, title, icon = ''] = line.slice(2).split('|').map(s => s.trim());
      theme = { id: `${level}:${id}`, title, icon, words: [] };
      themes.push(theme);
      return;
    }
    const p = line.split('|').map(s => s.trim());
    if (p.length < 3 || !theme) return warn(`${at} bad line: ${line}`);
    let [fr, en, type, ex = ''] = p;
    if (!TYPES[type]) return warn(`${at} unknown type "${type}"`);
    // nouns are written with their article for readability: "le pain" is stored as pain (m).
    // Plural-only nouns ("les gens") keep the article and get no un / une on the card.
    const plural = /^les /i.test(fr);
    if (TYPES[type][0] === 'noun' && !plural) fr = fr.replace(/^(le |la |l['’])/i, '');
    const key = fr.toLowerCase().replace(/'/g, '’');
    if (seen.has(key)) return warn(`${at} "${fr}" is already in ${seen.get(key)}`);
    seen.set(key, at);
    const [pos, gender] = plural ? ['noun', ''] : TYPES[type];
    if (CHECK) {
      const w = fr.toLowerCase();
      if (pos === 'noun' && !plural && !/[ ’'-]/.test(w)) {
        const g = genders(w);
        if (g === null) console.log(`${at} not in lexicon: ${fr}`);
        else if (g.length && !g.some(x => x === gender || x === 'm/f' || gender === 'm/f')) console.log(`${at} gender? ${fr} is ${gender} here, lexicon says ${g.join(', ')}`);
      } else if (!/[ ’']/.test(w) && lex.forms[w.replace(/^se /, '')] === undefined) console.log(`${at} not in lexicon: ${fr}`);
    }
    theme.words.push([typo(fr), en, pos, gender, typo(ex)]);
  });
  levels.push({ level, themes });
}
levels.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
fs.writeFileSync(OUT, JSON.stringify({ version: 1, levels }));
for (const l of levels) console.log(`${l.level}: ${l.themes.length} themes, ${l.themes.reduce((n, t) => n + t.words.length, 0)} words  (${l.themes.map(t => t.words.length).join(' ')})`);
console.log(`vocab.json: ${seen.size} words, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB` + (problems ? `, ${problems} PROBLEMS` : ''));
