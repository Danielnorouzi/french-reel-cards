// French Reel Cards — tiny stateless server. No npm dependencies.
// Nothing is stored permanently: uploads live in a temp folder only while they are read,
// and results stay in memory just long enough for the phone to pick them up.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readText } from './ocr.js';
import { extractVocab, loadLexicon, lookupWords } from './vocab.js';
import { conjugate, suggest } from './conjugate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const PORT = Number(process.env.PORT || 10000);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 150) * 1024 * 1024;
const JOB_TTL = 30 * 60_000; // results are kept 30 min (or until the free server sleeps)
const MAX_QUEUE = 20;
const VERSION = '1.0.0';

const jobs = new Map(); // id -> job
const queue = [];
let working = false;

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...headers
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function publicJob(j) {
  return { id: j.id, status: j.status, stage: j.stage, progress: j.progress, error: j.error,
    result: j.result, createdAt: j.createdAt, source: j.source };
}

function sniffIsImage(buf, contentType = '') {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
  if (buf.toString('ascii', 0, 3) === 'GIF') return true;
  const brand = buf.toString('ascii', 8, 12);
  if (['heic', 'heix', 'mif1', 'msf1', 'avif'].includes(brand)) return true;
  return contentType.startsWith('image/');
}

class SizeLimit extends Transform {
  constructor(max) { super(); this.n = 0; this.max = max; }
  _transform(chunk, _e, cb) {
    this.n += chunk.length;
    if (this.n > this.max) cb(Object.assign(new Error('File is too large.'), { status: 413 }));
    else cb(null, chunk);
  }
}

// Accepts either a raw file body (what the app and the iOS Shortcut send)
// or a multipart form with a "file" field.
async function saveUpload(req, dest) {
  const type = req.headers['content-type'] || '';
  if (type.startsWith('multipart/form-data')) {
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_UPLOAD) throw Object.assign(new Error('File is too large.'), { status: 413 });
    const request = new Request('http://local/', { method: 'POST', headers: { 'content-type': type },
      body: Readable.toWeb(req.pipe(new SizeLimit(MAX_UPLOAD))), duplex: 'half' });
    const form = await request.formData();
    const file = form.get('file') || [...form.values()].find(v => typeof v === 'object');
    if (!file || typeof file === 'string') throw Object.assign(new Error('No file in the upload.'), { status: 400 });
    await fsp.writeFile(dest, Buffer.from(await file.arrayBuffer()));
    return file.type || '';
  }
  await pipeline(req, new SizeLimit(MAX_UPLOAD), fs.createWriteStream(dest));
  return type;
}

async function createJob(req, { inbox = null, source = 'app' } = {}) {
  if (queue.length >= MAX_QUEUE) throw Object.assign(new Error('Server is busy, try again in a minute.'), { status: 503 });
  const id = crypto.randomBytes(9).toString('base64url');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reel-'));
  const input = path.join(dir, 'input');
  try {
    const ctype = await saveUpload(req, input);
    const stat = await fsp.stat(input);
    if (!stat.size) throw Object.assign(new Error('The upload was empty.'), { status: 400 });
    const fh = await fsp.open(input);
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    await fh.close();
    const job = { id, dir, input, isImage: sniffIsImage(head, ctype), inbox, source, status: 'queued',
      stage: 'Waiting in line…', progress: { done: 0, total: 0 }, createdAt: Date.now() };
    jobs.set(id, job);
    queue.push(job);
    setImmediate(work);
    return job;
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

async function work() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    job.status = 'processing';
    job.stage = job.isImage ? 'Reading the screenshot…' : 'Grabbing frames…';
    const started = Date.now();
    try {
      const { frames, lines } = await readText(job.input, job.dir, {
        isImage: job.isImage,
        onProgress: (done, total) => {
          job.progress = { done, total };
          job.stage = job.isImage ? 'Reading the screenshot…' : `Reading frame ${Math.min(done + 1, total)} of ${total}…`;
        }
      });
      job.stage = 'Finding vocabulary…';
      const cards = extractVocab(lines);
      job.result = { lines, cards, frames, seconds: Math.round((Date.now() - started) / 1000) };
      job.status = 'done';
      job.stage = 'Done';
    } catch (e) {
      console.error('job failed', job.id, e.message);
      job.status = 'error';
      job.error = /Invalid data|could not find codec|moov atom/i.test(e.message)
        ? "That file doesn't look like a video or image I can read."
        : 'Something went wrong while reading that file.';
    } finally {
      job.finishedAt = Date.now();
      await fsp.rm(job.dir, { recursive: true, force: true });
    }
  }
  working = false;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > JOB_TTL) jobs.delete(id);
}, 60_000).unref();

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const gzCache = new Map(); // files are fixed per deploy, so compress each once
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  try {
    const data = await fsp.readFile(file);
    const ext = path.extname(file);
    const noCache = ['.html', '.js', '.css', '.webmanifest', '.json'].includes(ext); // code/data always revalidate; images may cache
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Accept-Encoding'
    };
    let body = data;
    // text files shrink ~5–10× with gzip (grammar.json: 290 KB → 31 KB), which matters on mobile data
    if (noCache && data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      if (!gzCache.has(file) || gzCache.get(file).raw !== data.length) gzCache.set(file, { raw: data.length, gz: zlib.gzipSync(data, { level: 6 }) });
      body = gzCache.get(file).gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'Not found');
  }
}

// ---------- routes ----------
const INBOX_RE = /^[A-Za-z0-9_-]{8,40}$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    }
    if (p === '/api/health') return send(res, 200, { ok: true, version: VERSION, queue: queue.length });

    // Free conjugation API (built on open data — no third-party service)
    if (p === '/api/conjugate' && req.method === 'GET') {
      const q = (url.searchParams.get('v') || '').slice(0, 60);
      const result = q ? conjugate(q) : null;
      if (!result) return send(res, 404, { error: `No French verb found for “${q}”.`, suggestions: suggest(q, 5) });
      return send(res, 200, result, { 'Cache-Control': 'public, max-age=86400' });
    }
    if (p === '/api/verbs' && req.method === 'GET') {
      return send(res, 200, { verbs: suggest(url.searchParams.get('q') || '', 8) });
    }
    // Import a word list: look up base form, meaning and gender for each word.
    if (p === '/api/lookup' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) throw Object.assign(new Error('List is too long.'), { status: 413 }); }
      let items;
      try { items = JSON.parse(body).items; } catch { items = null; }
      if (!Array.isArray(items)) return send(res, 400, { error: 'Expected { items: [...] }.' });
      return send(res, 200, { cards: lookupWords(items) });
    }
    if (p === '/api/jobs' && req.method === 'POST') {
      const job = await createJob(req);
      return send(res, 202, publicJob(job));
    }
    let m = p.match(/^\/api\/jobs\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'This result has expired (the free server restarted). Please upload again.' });
      return send(res, 200, publicJob(job));
    }

    // iOS Shortcut "inbox": the Shortcut posts a video here, the app collects results later.
    m = p.match(/^\/api\/inbox\/([^/]+)(?:\/([\w-]+))?$/);
    if (m) {
      const [, code, id] = m;
      if (!INBOX_RE.test(code)) return send(res, 400, { error: 'Bad inbox code.' });
      if (req.method === 'POST' && !id) {
        await createJob(req, { inbox: code, source: 'shortcut' });
        return send(res, 202, 'Sent to French Reel Cards. Open the app in a minute to see your new words.');
      }
      if (req.method === 'GET' && !id) {
        const list = [...jobs.values()].filter(j => j.inbox === code).map(publicJob);
        return send(res, 200, { jobs: list });
      }
      if (req.method === 'DELETE' && id) {
        const j = jobs.get(id);
        if (j && j.inbox === code) jobs.delete(id);
        return send(res, 200, { ok: true });
      }
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    send(res, 405, 'Method not allowed');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error.' : e.message });
    req.resume();
  }
});
server.requestTimeout = 15 * 60_000;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadLexicon();
  server.listen(PORT, () => console.log(`French Reel Cards listening on :${PORT}`));
}
export { server };
