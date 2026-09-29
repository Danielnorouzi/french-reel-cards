// Anki-compatible CSV export (File → Import in Anki; the header lines set everything up).
export function article(card) {
  if (card.pos !== 'noun') return '';
  if (card.gender === 'm') return 'un';
  if (card.gender === 'f') return 'une';
  if (card.gender === 'm/f') return 'un/une';
  return '';
}

export function frontText(card) {
  const a = article(card);
  return a ? `${a} ${card.lemma}` : card.lemma;
}

const POS_LABEL = { noun: 'noun', verb: 'verb', adj: 'adjective', adv: 'adverb', intj: 'interjection', phrase: 'phrase', prep: 'preposition', conj: 'conjunction', pron: 'pronoun', num: 'number' };
export function posLabel(card) {
  const base = POS_LABEL[card.pos] || card.pos || '';
  if (card.pos === 'noun' && card.gender) return `${base} · ${card.gender === 'm' ? 'masculine' : card.gender === 'f' ? 'feminine' : 'masc./fem.'}`;
  return base;
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function csvField(s) {
  return '"' + String(s).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
}
function highlight(example, word) {
  const e = esc(example);
  if (!word) return e;
  const re = new RegExp(`(^|[^\\p{L}])(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}])`, 'iu');
  return e.replace(re, '$1<b>$2</b>');
}

export function toAnkiCsv(cards) {
  // cards in a set go into a sub-deck, e.g. "Reel Cards::Clothes"
  const lines = ['#separator:Comma', '#html:true', '#columns:Front,Back,Tags,Deck', '#tags column:3', '#deck column:4'];
  for (const c of cards) {
    const back = [esc(c.meaning), `<i>${esc(posLabel(c))}</i>`, c.example ? `<br>${highlight(c.example, c.word)}` : '']
      .filter(Boolean).join('<br>');
    const tags = ['french', 'reel-cards', c.pos].filter(Boolean).join(' ');
    const deck = c.deck ? `Reel Cards::${c.deck.replace(/::/g, ':')}` : 'Reel Cards';
    lines.push([csvField(frontText(c)), csvField(back), csvField(tags), csvField(deck)].join(','));
  }
  return lines.join('\n') + '\n';
}
