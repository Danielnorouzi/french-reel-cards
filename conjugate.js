// Free conjugation API built on open data (Dicollecte/Grammalecte lexicon, MPL 2.0).
// No third-party service: every simple tense comes from the lexicon, compound tenses are
// built from the auxiliary (avoir/être) + past participle.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLexicon, normalizeText } from './vocab.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let DATA = null;
function data() {
  if (!DATA) DATA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, '..', 'data', 'conjugations.json.gz'))).toString('utf8')).verbs;
  return DATA;
}

const PRONOUNS = ['je', 'tu', 'il/elle', 'nous', 'vous', 'ils/elles'];
const REFLEXIVE = ['me', 'te', 'se', 'nous', 'vous', 'se'];
// verbs that take "être" when used without a direct object, "avoir" with one
const BOTH_AUX = new Set(['passer', 'monter', 'descendre', 'sortir', 'rentrer', 'retourner', 'remonter', 'redescendre', 'ressortir', 'repasser']);
const vowel = s => /^[aeiouyâàäéèêëîïôöûùüœæh]/i.test(s);

function withPronoun(i, form, reflexive, impersonal = false) {
  if (!form) return '';
  let p = impersonal && i === 2 ? 'il' : PRONOUNS[i];
  if (reflexive) {
    const r = REFLEXIVE[i];
    const rr = (i === 0 || i === 1 || i === 2 || i === 5) && vowel(form) ? r[0] + "'" : r + ' ';
    return `${p} ${rr}${form}`;
  }
  if (i === 0 && vowel(form)) return `j'${form}`;
  return `${p} ${form}`;
}

// "aller" → { infinitive, reflexive } from anything the user types: "allait", "s'en aller", "se lever", "Je mange"
export function resolveVerb(query) {
  let q = normalizeText(String(query || '')).toLowerCase().trim().replace(/\s+/g, ' ');
  q = q.replace(/^(je |j'|tu |il |elle |on |nous |vous |ils |elles )/, '');
  let reflexive = false;
  const m = q.match(/^(se |s'|me |m'|te |t')(.+)$/);
  if (m) { reflexive = true; q = m[2]; }
  const verbs = data();
  if (verbs[q]) return { infinitive: q, reflexive };
  const lex = loadLexicon();
  const f = lex.forms[q];
  if (f !== undefined) {
    for (const i of [].concat(f)) {
      const [lemma, pos] = lex.records[i];
      if (pos === 'verb' && verbs[lemma]) return { infinitive: lemma, reflexive };
    }
  }
  // search every form (covers forms the dictionary only lists under the verb, e.g. "fûmes")
  for (const [inf, v] of Object.entries(verbs)) {
    for (const slots of Object.values(v.t)) if (slots.some(s => s.split('/').includes(q))) return { infinitive: inf, reflexive };
    if (v.pp.some(s => s.split('/').includes(q)) || v.pr === q) return { infinitive: inf, reflexive };
  }
  return null;
}

const plain = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/œ/g, 'oe');
export function suggest(prefix, limit = 8) {
  const p = plain(normalizeText(prefix).toLowerCase().trim().replace(/^(se |s')/, ''));
  if (p.length < 2) return [];
  const out = [];
  const verbs = data();
  for (const inf of Object.keys(verbs)) if (plain(inf).startsWith(p)) out.push(inf);
  return out.sort((a, b) => (verbs[b].o || 0) - (verbs[a].o || 0)).slice(0, limit); // most common first
}

export function conjugate(query) {
  const r = resolveVerb(query);
  if (!r) return null;
  const verbs = data();
  const v = verbs[r.infinitive];
  const pronominalOnly = v.f[6] === 'p';
  const impersonal = v.f[7] === 'm';
  const reflexive = r.reflexive || pronominalOnly;
  const etre = v.f[8] === 'e' && v.f[9] !== 'a';
  const auxName = reflexive || etre ? 'être' : 'avoir';
  const both = !reflexive && BOTH_AUX.has(r.infinitive);
  const aux = verbs[auxName];
  const [ms, fs, mp, fp] = v.pp;
  const agree = auxName === 'être';
  // past participle as it appears after the auxiliary, per person (agreement with être)
  const ppFor = i => !agree ? ms
    : i < 3 ? (ms === fs ? ms : `${ms}(e)`)
    : mp === fp ? mp : mp === `${ms}s` ? `${ms}(e)s` : `${mp}/${fp}`;
  const simple = (tense, i) => withPronoun(i, (v.t[tense]?.[i] || '').split('/')[0], reflexive);
  const compound = (auxTense, i) => {
    if (!(v.t.ipre?.[i] || v.t.iimp?.[i])) return ''; // impersonal verbs: only "il"
    const a = aux.t[auxTense][i].split('/')[0];
    return withPronoun(i, `${a} ${ppFor(i)}`, reflexive);
  };
  const variants = (tense, i) => (v.t[tense]?.[i] || '').split('/').filter(Boolean);
  const table = (tense) => PRONOUNS.map((_, i) => ({
    text: simple(tense, i),
    alt: variants(tense, i).slice(1).map(x => withPronoun(i, x, reflexive))
  }));
  const comp = (auxTense) => PRONOUNS.map((_, i) => ({ text: compound(auxTense, i), alt: [] }));
  const impe = PRONOUNS.map((_, i) => {
    const f = (v.t.impe?.[i] || '').split('/')[0];
    if (!f) return null;
    return { person: ['', 'tu', '', 'nous', 'vous', ''][i], text: reflexive ? `${f}-${['', 'toi', '', 'nous', 'vous', ''][i]}` : f, alt: [] };
  }).filter(Boolean);

  const lex = loadLexicon();
  const rec = [].concat(lex.forms[r.infinitive] ?? []).map(i => lex.records[i]).find(x => x[1] === 'verb');
  const group = v.f[1] === '0' ? 'auxiliary' : `${v.f[1]}${v.f[1] === '1' ? 'st' : v.f[1] === '2' ? 'nd' : 'rd'} group`;

  return {
    query: String(query),
    infinitive: reflexive ? `${vowel(r.infinitive) ? "s'" : 'se '}${r.infinitive}` : r.infinitive,
    base: r.infinitive,
    meaning: rec?.[3] || '',
    group,
    auxiliary: both ? 'avoir or être' : auxName,
    auxNote: both ? 'Uses être without a direct object (je suis passé), avoir with one (j\'ai passé un examen).' : '',
    reflexive,
    canBeReflexive: !pronominalOnly && v.f[6] === 'q',
    participles: { present: (v.pr || '').split('/')[0], past: agree ? `${ms}${fs !== ms ? ', ' + fs : ''}${mp !== ms ? ', ' + mp : ''}${fp !== fs ? ', ' + fp : ''}` : ms },
    moods: [
      { name: 'Indicatif', tenses: [
        { name: 'Présent', en: 'present', rows: table('ipre') },
        { name: 'Passé composé', en: 'perfect', rows: comp('ipre') },
        { name: 'Imparfait', en: 'imperfect', rows: table('iimp') },
        { name: 'Futur simple', en: 'future', rows: table('ifut') },
        { name: 'Plus-que-parfait', en: 'pluperfect', rows: comp('iimp') },
        { name: 'Passé simple', en: 'simple past (written)', rows: table('ipsi') },
        { name: 'Futur antérieur', en: 'future perfect', rows: comp('ifut') }
      ] },
      { name: 'Conditionnel', tenses: [
        { name: 'Présent', en: 'would …', rows: table('cond') },
        { name: 'Passé', en: 'would have …', rows: comp('cond') }
      ] },
      { name: 'Subjonctif', tenses: [
        { name: 'Présent', en: 'que …', rows: table('spre').map(x => ({ ...x, text: x.text && `que ${x.text}`.replace(/^que il/, "qu'il").replace(/^que ils/, "qu'ils") })) },
        { name: 'Passé', en: 'que … (past)', rows: PRONOUNS.map((_, i) => {
          const t = v.t.ipre?.[i] ? withPronoun(i, `${aux.t.spre[i].split('/')[0]} ${ppFor(i)}`, reflexive) : '';
          return { text: t && `que ${t}`.replace(/^que il/, "qu'il").replace(/^que ils/, "qu'ils"), alt: [] };
        }) },
        { name: 'Imparfait', en: 'literary', rows: table('simp').map(x => ({ ...x, text: x.text && `que ${x.text}`.replace(/^que il/, "qu'il").replace(/^que ils/, "qu'ils") })) }
      ] },
      { name: 'Impératif', tenses: [{ name: 'Présent', en: 'commands', rows: impe }] }
    ].map(m => ({ ...m, tenses: m.tenses.map(t => ({ ...t, rows: t.rows.filter(r => r && r.text)
      .map(r => impersonal ? { ...r, text: r.text.replace(/il\/elle/, 'il') } : r) })).filter(t => t.rows.length) }))
  };
}
