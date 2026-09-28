// Frame extraction (ffmpeg) + OCR (Tesseract, French) + duplicate-line removal.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeText } from './vocab.js';

export const FRAME_EVERY_SECONDS = 2;
export const MAX_FRAMES = Number(process.env.MAX_FRAMES || 45); // 90 s of video

function run(cmd, args, { timeoutMs = 10 * 60_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with ${code}: ${err.slice(-500)}`));
    });
  });
}

// Caption text in reels is usually white (often with a dark outline/shadow), dark text on a light
// box, or a bright colour (cyan, yellow, pink…). For each frame we build three black-on-white
// "masks" stacked vertically and OCR them in one go:
//   1. near-white pixels            (white captions over busy video)
//   2. near-black pixels            (dark text on light boxes)
//   3. bright, saturated pixels     (coloured captions — skies and skin are not saturated enough)
const MAX = 'max(max(r(X,Y),g(X,Y)),b(X,Y))';
const MIN = 'min(min(r(X,Y),g(X,Y)),b(X,Y))';
const WHITE = `if(gt(${MIN},195),0,255)`;
const BLACK = `if(lt(${MAX},70),0,255)`;
const VIVID = `if(gt(${MAX},185)*gt(${MAX}-${MIN},60),0,255)`;
function panelsFilter(pre) {
  return `[0]${pre}scale='if(gt(iw,900),900,if(lt(iw,600),iw*1.5,iw))':-2,format=gbrp,split=3[a][b][c];` +
    `[a]geq=r='${WHITE}':g='${WHITE}':b='${WHITE}'[wa];` +
    `[b]geq=r='${BLACK}':g='${BLACK}':b='${BLACK}'[wb];` +
    `[c]geq=r='${VIVID}':g='${VIVID}':b='${VIVID}'[wc];` +
    `[wa][wb][wc]vstack=inputs=3,format=gray`;
}

// Video: one frame every 2 s. Image: a single frame.
export async function extractFrames(inputPath, workDir, { isImage }) {
  const pattern = path.join(workDir, 'f_%03d.png');
  const pre = isImage ? '' : `fps=1/${FRAME_EVERY_SECONDS},`;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
    '-filter_complex', panelsFilter(pre), '-frames:v', isImage ? '1' : String(MAX_FRAMES), pattern];
  await run('ffmpeg', args, { timeoutMs: 5 * 60_000 });
  const files = (await fs.readdir(workDir)).filter(f => /^f_\d+\.png$/.test(f)).sort();
  return files.map(f => path.join(workDir, f));
}

// Parse Tesseract TSV into caption lines, dropping low-confidence words, then join lines that sit
// right on top of each other into one caption (reels often show one or two words per line).
export function parseTsv(tsv, minWordConf = 65, minLineConf = 75) {
  const lines = new Map();
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue; // level 5 = word
    const conf = Number(c[10]);
    const text = c[11].trim();
    if (!text) continue;
    const key = `${c[1]}-${c[2]}-${c[3]}-${c[4]}`; // page-block-par-line
    if (!lines.has(key)) lines.set(key, []);
    const [x, y, w, h] = [c[6], c[7], c[8], c[9]].map(Number);
    lines.get(key).push({ text, conf, box: { x0: x, y0: y, x1: x + w, y1: y + h } });
  }
  // join lines into captions first (short lines like "le" or "un" often have low confidence on
  // their own), then judge each caption as a whole
  const raw = [...lines.values()].map(words => ({
    words,
    box: words.reduce((b, w) => ({ x0: Math.min(b.x0, w.box.x0), y0: Math.min(b.y0, w.box.y0),
      x1: Math.max(b.x1, w.box.x1), y1: Math.max(b.y1, w.box.y1) }), words[0].box)
  }));
  const out = [];
  for (const para of mergeParagraphs(raw)) {
    const all = para.words;
    // a clearly read caption keeps its short low-confidence words ("le", "a"); otherwise drop weak words
    const strong = avg(all.map(w => w.conf)) >= minLineConf;
    const words = all.filter(w => w.conf >= minWordConf || (strong && w.conf >= 35 && w.text.length <= 3));
    // a caption where most words were unreadable is background noise
    if (!words.length || words.length / all.length < 0.6) continue;
    const conf = avg(words.map(w => w.conf));
    if (conf < minLineConf) continue;
    out.push({ text: words.map(w => w.text).join(' '), conf });
  }
  return out;
}
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

export function mergeParagraphs(lines) {
  const sorted = [...lines].sort((a, b) => a.box.y0 - b.box.y0);
  const paras = [];
  for (const l of sorted) {
    const h = l.box.y1 - l.box.y0;
    const p = paras.find(p => {
      const ph = p.maxH; // tallest line so far (lines like "un" have no ascenders, so they look short)
      const gap = l.box.y0 - p.last.y1;
      const overlap = Math.min(p.last.x1, l.box.x1) - Math.max(p.last.x0, l.box.x0);
      const sizeOk = Math.max(h, ph) / Math.max(1, Math.min(h, ph)) < 2.5; // similar font size
      return gap > -0.3 * h && gap < 1.0 * Math.max(h, ph) && overlap > 0 && sizeOk;
    });
    if (p) { p.words.push(...l.words); p.last = l.box; p.maxH = Math.max(p.maxH, h); }
    else paras.push({ words: [...l.words], last: l.box, maxH: h });
  }
  return paras;
}

export async function ocrFrame(file) {
  const tsv = await run('tesseract', [file, 'stdout', '-l', 'fra', '--psm', '11', 'tsv'], {
    timeoutMs: 2 * 60_000,
    env: { OMP_THREAD_LIMIT: '1' }
  });
  return parseTsv(tsv);
}

// Is this line plausibly a caption and not OCR noise from the video background?
export function looksLikeText(s) {
  const letters = (s.match(/[A-Za-zÀ-ÿœŒæÆ]/g) || []).length;
  // a lone short fragment ("LUS", "nl E") is almost always background noise
  if (letters < 4 && !/\s/.test(s.trim())) return false;
  if (letters < 4) return false;
  const nonSpace = s.replace(/\s/g, '').length;
  if (letters / nonSpace < 0.7) return false;
  // at least one real-looking word of 2+ letters
  return /[A-Za-zÀ-ÿœŒ]{2,}/.test(s);
}

export function normalizeLine(s) {
  return normalizeText(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
export function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 1;
}

// Remove duplicate lines across frames. The same caption is read in several frames (and panels),
// with small OCR differences. Similar lines are grouped; each group keeps the version that was
// read most often (ties: higher confidence, then longer). Order of first appearance is kept.
export function dedupeLines(lines, threshold = 0.75) {
  const groups = [];
  for (const l of lines) {
    const norm = normalizeLine(l.text);
    if (!norm) continue;
    const g = groups.find(g => g.items.some(k => k.norm === norm || similarity(k.norm, norm) >= threshold));
    if (g) g.items.push({ ...l, norm });
    else groups.push({ items: [{ ...l, norm }] });
  }
  const reps = groups.map(g => {
    const byNorm = new Map();
    for (const it of g.items) {
      const v = byNorm.get(it.norm) || { count: 0, conf: 0, text: it.text, norm: it.norm };
      v.count++;
      if (it.conf > v.conf) { v.conf = it.conf; v.text = it.text; }
      byNorm.set(it.norm, v);
    }
    return [...byNorm.values()].sort((a, b) => b.count - a.count || b.conf - a.conf || b.norm.length - a.norm.length)[0];
  });
  // Fragments whose words all appear in a longer caption ("Hier on", or a caption revealed word
  // by word) are dropped, and the longer caption takes the fragment's earlier position.
  const bag = r => new Set(r.norm.split(/[ ']/).filter(Boolean));
  const coverOf = r => {
    const words = [...bag(r)];
    const covers = reps.filter(o => o !== r && o.norm.length > r.norm.length && words.every(w => bag(o).has(w)));
    return covers.sort((a, b) => b.norm.length - a.norm.length)[0] || r;
  };
  const out = [];
  for (const r of reps) {
    let best = r;
    for (let c = coverOf(r); c !== best; c = coverOf(c)) best = c; // follow to the longest caption
    if (!out.includes(best)) out.push(best);
  }
  return out.map(r => r.text);
}

export async function readText(inputPath, workDir, { isImage, onProgress = () => {} }) {
  const frames = await extractFrames(inputPath, workDir, { isImage });
  if (!frames.length) throw new Error('Could not read any frames from that file.');
  onProgress(0, frames.length);
  const all = [];
  for (let i = 0; i < frames.length; i++) {
    const lines = await ocrFrame(frames[i]);
    for (const l of lines) if (looksLikeText(l.text)) all.push(l);
    await fs.rm(frames[i], { force: true });
    onProgress(i + 1, frames.length);
  }
  return { frames: frames.length, lines: dedupeLines(all) };
}
