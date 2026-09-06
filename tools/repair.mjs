/**
 * Repair pass: scans every saved page/asset in site/ for local references that
 * have no file on disk, and fetches them from the Wayback Machine (with the
 * availability pre-check, so truly-unarchived URLs are skipped cheaply).
 *
 * Usage:  node tools/repair.mjs
 */
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'site');
const TS = '20250217044245';
const ORIGIN = 'https://seo-coaching.net';
const WB = 'https://web.archive.org/web';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pacing + circuit breaker (same policy as recover.mjs) ---
let lastReqStart = 0;
let circuitOpenUntil = 0;
async function pacedFetch(url) {
  await sleep(Math.max(0, circuitOpenUntil - Date.now()));
  const wait = Math.max(0, 900 + Math.random() * 600 - (Date.now() - lastReqStart));
  if (wait) await sleep(wait);
  lastReqStart = Date.now();
  return fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
  });
}
function tripCircuit() {
  circuitOpenUntil = Date.now() + 45000;
  console.warn('  [circuit] archive.org blocked us — pausing all requests 45s');
}
async function fetchBuf(url, { retries = 8 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await pacedFetch(url);
      if (res.ok) {
        circuitOpenUntil = 0;
        return Buffer.from(await res.arrayBuffer());
      }
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) tripCircuit();
    } catch {
      tripCircuit();
    }
    await sleep(8000 * (attempt + 1));
  }
  return null;
}

// --- availability cache (shared with recover.mjs) ---
const AVAIL_CACHE_FILE = join(__dirname, '.avail-cache.json');
const availCache = existsSync(AVAIL_CACHE_FILE) ? JSON.parse(readFileSync(AVAIL_CACHE_FILE, 'utf8')) : {};
const availPending = new Map();
async function checkAvailable(origUrl) {
  if (origUrl in availCache) return availCache[origUrl];
  if (availPending.has(origUrl)) return availPending.get(origUrl);
  const p = (async () => {
    try {
      const api = `http://archive.org/wayback/available?url=${encodeURIComponent(origUrl)}&timestamp=${TS}`;
      const res = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const data = await res.json();
        const snap = data.archived_snapshots?.closest;
        return snap && snap.available && snap.status === '200' ? snap.url : null;
      }
    } catch {}
    return undefined;
  })().then((r) => {
    availCache[origUrl] = r;
    writeFileSync(AVAIL_CACHE_FILE, JSON.stringify(availCache));
    availPending.delete(origUrl);
    return r;
  });
  availPending.set(origUrl, p);
  return p;
}

const unwayback = (url) => {
  const m = url.match(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z]{2})?_\/(https?:\/\/.+)$/);
  return m ? m[1] : url;
};

async function processCss(css, cssUrl) {
  const urls = [...css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((m) => m[2]);
  for (const u of urls) {
    const clean = unwayback(u);
    if (clean.startsWith('data:')) continue;
    let orig;
    try {
      orig = new URL(clean, cssUrl).href;
    } catch {
      continue;
    }
    if (!orig.startsWith(ORIGIN) && !orig.includes('fonts.gstatic.com')) continue;
    await ensureAsset(orig);
  }
}

const done = new Map();
async function ensureAsset(orig) {
  let rel;
  try {
    rel = new URL(orig).pathname;
  } catch {
    return;
  }
  if (done.has(rel)) return done.get(rel);
  const p = (async () => {
    const dest = join(OUT, rel);
    if (existsSync(dest) && statSync(dest).size > 0) return true;
    const snapUrl = await checkAvailable(orig);
    if (snapUrl === null) {
      console.warn(`  [NOT ARCHIVED] ${orig}`);
      return false;
    }
    const isBinary = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|pdf|zip)(\?|$)/i.test(orig);
    const tries = snapUrl
      ? [snapUrl]
      : isBinary
        ? [`${WB}/${TS}im_/${orig}`, `${WB}/${TS}/${orig}`]
        : [`${WB}/${TS}/${orig}`, `${WB}/${TS}id_/${orig}`];
    for (const url of tries) {
      const buf = await fetchBuf(url);
      if (buf && buf.length > 0) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        console.log(`  [fixed] ${rel}`);
        if (/\.css$/i.test(rel)) await processCss(buf.toString('utf8'), orig);
        return true;
      }
    }
    console.warn(`  [STILL MISSING] ${orig}`);
    return false;
  })();
  done.set(rel, p);
  return p;
}

const LOCAL_REF_RE = /(?:src|href|srcset|data-src|data-srcset|poster)=("([^"]*)"|'([^']*)')/g;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

async function main() {
  const files = walk(OUT);
  const htmls = files.filter((f) => f.endsWith('.html'));
  const csses = files.filter((f) => f.endsWith('.css'));
  console.log(`scanning ${htmls.length} html + ${csses.length} css files`);

  let fixed = 0,
    missing = 0;
  for (const f of htmls) {
    const html = readFileSync(f, 'utf8');
    const jobs = [];
    // inline <style> blocks (fonts, background images)
    for (const m of html.matchAll(/url\((['"]?)(\/[^'")]+)\1\)/g)) {
      const pathOnly = m[2].split(/[?#]/)[0];
      if (!/\.[a-z0-9]{2,5}$/i.test(pathOnly)) continue;
      const dest = join(OUT, pathOnly);
      if (existsSync(dest)) continue;
      jobs.push(ensureAsset(ORIGIN + pathOnly).then(() => {}));
    }
    for (const m of html.matchAll(LOCAL_REF_RE)) {
      const val = m[2] !== undefined ? m[2] : m[3];
      for (const seg of val.split(',')) {
        const url = seg.trim().split(/\s+/)[0];
        if (!url || !url.startsWith('/')) continue;
        const pathOnly = url.split(/[?#]/)[0];
        if (!pathOnly || pathOnly === '/') continue;
        if (!/\.[a-z0-9]{2,5}$/i.test(pathOnly)) continue; // page paths handled by recover.mjs
        const dest = join(OUT, pathOnly);
        if (existsSync(dest)) continue; // file or directory already present
        jobs.push(
          ensureAsset(ORIGIN + pathOnly).then((ok) => {
            if (ok) fixed++;
            else missing++;
          })
        );
      }
    }
    await Promise.all(jobs);
  }
  for (const f of csses) {
    const relPath = '/' + f.slice(OUT.length + 1).replace(/\\/g, '/');
    await processCss(readFileSync(f, 'utf8'), ORIGIN + relPath);
  }
  console.log(`\nrepair pass done. newly fixed: ${fixed}, still missing/unarchived: ${missing}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
