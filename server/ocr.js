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

// Caption text in reels is almost always either white (with a dark outline/shadow) or dark text
// on a light box. For each frame we build three panels stacked vertically and OCR them in one go:
//   1. near-white pixels → black-on-white   (white captions over busy video)
//   2. near-black pixels → black-on-white   (dark text on light boxes)
//   3. plain grayscale                       (anything else, e.g. coloured text)
const WHITE = "if(gt(min(min(r(X,Y),g(X,Y)),b(X,Y)),195),0,255)";
const BLACK = "if(lt(max(max(r(X,Y),g(X,Y)),b(X,Y)),70),0,255)";
function panelsFilter(pre) {
  return `[0]${pre}scale='if(gt(iw,900),900,if(lt(iw,600),iw*1.5,iw))':-2,format=gbrp,split=3[a][b][c];` +
    `[a]geq=r='${WHITE}':g='${WHITE}':b='${WHITE}'[wa];` +
    `[b]geq=r='${BLACK}':g='${BLACK}':b='${BLACK}'[wb];` +
    `[c]format=gray,format=gbrp[wc];` +
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

// Parse Tesseract TSV into lines with average confidence, dropping low-confidence words.
export function parseTsv(tsv, minWordConf = 65, minLineConf = 75) {
  const lines = new Map();
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue; // level 5 = word
    const conf = Number(c[10]);
    const text = c[11].trim();
    if (!text) continue;
    const key = `${c[1]}-${c[2]}-${c[3]}-${c[4]}`; // page-block-par-line
    if (!lines.has(key)) lines.set(key, { words: [], confs: [], total: 0 });
    const l = lines.get(key);
    l.total++;
    if (conf < minWordConf) continue;
    l.words.push(text);
    l.confs.push(conf);
  }
  return [...lines.values()]
    // a line where most words were unreadable is background noise, not a caption
    .filter(l => l.words.length && l.words.length / l.total >= 0.6)
    .map(l => ({ text: l.words.join(' '), conf: l.confs.reduce((a, b) => a + b, 0) / l.confs.length }))
    .filter(l => l.conf >= minLineConf);
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
  if (letters < 3) return false;
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
  // a line fully contained in a longer one (caption revealed word by word) is dropped;
  // the longer version takes the earlier position
  const out = [];
  for (const r of reps) {
    const i = out.findIndex(o => o.norm.includes(r.norm) || r.norm.includes(o.norm));
    if (i === -1) out.push(r);
    else if (r.norm.length > out[i].norm.length) out[i] = r;
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
