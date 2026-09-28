// Vocabulary extraction without an LLM:
// tokenize → drop stopwords → lemmatize (allait → aller) → look up meaning + gender.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let LEX = null;
export function loadLexicon(file = path.join(here, '..', 'data', 'lexicon.json.gz')) {
  if (!LEX) LEX = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  return LEX;
}

// Common French function words + very high-frequency words that aren't worth a flashcard.
export const STOPWORDS = new Set(`
a à â abord afin ah ai aie aient aies ailleurs ainsi ait alors as assez au aucun aucune aujourd auquel aura aurai auraient aurais aurait auras aurez auriez aurions aurons auront aussi autre autres aux auxquelles auxquels avaient avais avait avant avec avez aviez avions avoir avons ayant ayez ayons
bah ben beaucoup bien bon bref
c ça ca car ce ceci cela celle celles celui cependant ces cet cette ceux chacun chacune chaque chez ci comme comment
d dans de des donc dont du duquel
e eh elle elles en encore enfin entre es est et étaient étais était étant été êtes étiez étions être eu eue eues euh eurent eus eusse eut eût eux
fois furent fus fut fût
h ha hein hé hop
i ici il ils
j je jusqu jusque
l la là laquelle le lequel les lesquelles lesquels leur leurs lors lorsqu lorsque lui
m ma mais me même mêmes mes moi moins mon
n ne ni non nos notre nous
o ô oh ok okay on ont ou où oui
p par parce pas peu peut plus plutôt pour pourquoi puis puisqu puisque
q qu quand que quel quelle quelles quels qui quoi quoique
s sa sans se sera serai seraient serais serait seras serez seriez serions serons seront ses si sien sienne soi soient sois soit sommes son sont sous suis sur
t ta te tes toi ton toujours tous tout toute toutes très tu
un une unes uns
v va vais vas voici voilà vont vos votre vous vu
y
`.split(/\s+/).filter(Boolean));

// Lemmas that are too basic to card (the two auxiliaries and pronouns).
const STOP_LEMMAS = new Set(['être', 'avoir', 'il', 'elle', 'on', 'ce', 'cela']);

const ELISION = /^(l|d|j|m|t|s|n|c|qu|jusqu|lorsqu|puisqu|quoiqu)'(.+)$/;
const DETERMINERS = new Set(['le', 'la', 'les', "l'", 'un', 'une', 'des', 'du', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leur', 'leurs', 'ce', 'cet', 'cette', 'ces', 'au', 'aux', 'quel', 'quelle']);
const SUBJECTS = new Set(['je', "j'", 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'ça', 'ca', "c'", 'qui', 'ne', "n'", 'me', "m'", 'te', "t'", 'se', "s'"]);

export function normalizeText(s) {
  return s.normalize('NFC').replace(/[’‘`´]/g, "'").replace(/[«»“”"]/g, ' ');
}

// Returns [{ surface, token, prev }] for every word in a line.
export function tokenize(line) {
  const text = normalizeText(line).toLowerCase();
  const raw = text.match(/[a-zàâäçéèêëîïôöùûüÿœæ]+(?:['-][a-zàâäçéèêëîïôöùûüÿœæ]+)*'?/g) || [];
  const out = [];
  let prev = '';
  for (let w of raw) {
    w = w.replace(/'$/, '');
    const lex = loadLexicon();
    if (lex.forms[w] !== undefined) { out.push({ token: w, prev }); prev = w; continue; }
    const m = w.match(ELISION);
    if (m) {
      out.push({ token: m[1] + "'", prev }); prev = m[1] + "'";
      w = m[2];
    }
    if (lex.forms[w] !== undefined) { out.push({ token: w, prev }); prev = w; continue; }
    // split hyphenated compounds the dictionary doesn't know (est-ce, dis-moi)
    for (const part of w.split('-').filter(Boolean)) { out.push({ token: part, prev }); prev = part; }
  }
  return out;
}

function readings(token) {
  const lex = loadLexicon();
  const f = lex.forms[token];
  if (f === undefined) return [];
  return [].concat(f).map(i => {
    const [lemma, pos, gender, meaning] = lex.records[i];
    return { lemma, pos, gender, meaning };
  });
}

// Pick a reading using the previous word as a light context hint:
// "le fait" → noun, "il fait" → verb.
export function pickReading(token, prev) {
  const rs = readings(token);
  if (!rs.length) return null;
  if (DETERMINERS.has(prev)) return rs.find(r => r.pos === 'noun') || rs.find(r => r.pos === 'adj') || rs[0];
  if (SUBJECTS.has(prev)) return rs.find(r => r.pos === 'verb') || rs[0];
  return rs[0];
}

// lines: array of caption lines (strings). Returns unique cards in order of appearance.
export function extractVocab(lines, { known = [] } = {}) {
  const knownSet = new Set(known.map(k => k.toLowerCase()));
  const byLemma = new Map();
  for (const line of lines) {
    for (const { token, prev } of tokenize(line)) {
      if (token.length < 3 || STOPWORDS.has(token) || token.endsWith("'")) continue;
      const r = pickReading(token, prev);
      if (!r || STOP_LEMMAS.has(r.lemma) || STOPWORDS.has(r.lemma)) continue;
      if (knownSet.has(r.lemma.toLowerCase())) continue;
      if (byLemma.has(r.lemma)) continue;
      byLemma.set(r.lemma, {
        lemma: r.lemma,
        word: token,
        pos: r.pos,
        gender: r.gender,
        meaning: r.meaning,
        example: line.trim()
      });
    }
  }
  return [...byLemma.values()];
}
