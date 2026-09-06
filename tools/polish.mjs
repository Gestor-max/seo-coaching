/**
 * Final polish pass:
 *  1. Rewrite font URLs (fonts.gstatic.com, wayback-prefixed, protocol-relative)
 *     in inline <style> blocks / CSS to local paths and download the font files.
 *  2. Remap <img>/srcset references to unarchived uploads onto existing sibling
 *     size-variants when available.
 *  3. Strip dead <script>/<link> tags (never-archived SiteGround JS bundles,
 *     Divi et-cache CSS, xmlrpc) to avoid 404 noise.
 *
 * Usage:  node tools/polish.mjs
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

// --- pacing + circuit breaker ---
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

const AVAIL_CACHE_FILE = join(__dirname, '.avail-cache.json');
const availCache = existsSync(AVAIL_CACHE_FILE) ? JSON.parse(readFileSync(AVAIL_CACHE_FILE, 'utf8')) : {};
async function checkAvailable(origUrl) {
  if (origUrl in availCache) return availCache[origUrl];
  try {
    const api = `http://archive.org/wayback/available?url=${encodeURIComponent(origUrl)}&timestamp=${TS}`;
    const res = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const data = await res.json();
      const snap = data.archived_snapshots?.closest;
      availCache[origUrl] = snap && snap.available && snap.status === '200' ? snap.url : null;
      writeFileSync(AVAIL_CACHE_FILE, JSON.stringify(availCache));
      return availCache[origUrl];
    }
  } catch {}
  return undefined;
}

const unwayback = (url) => {
  const m = url.match(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z]{2})?_\/(https?:\/\/.+)$/);
  return m ? m[1] : url;
};

const done = new Map();
async function ensureAsset(orig) {
  let rel;
  try {
    rel = new URL(orig).pathname;
  } catch {
    return false;
  }
  if (done.has(rel)) return done.get(rel);
  const p = (async () => {
    const dest = join(OUT, rel);
    if (existsSync(dest) && statSync(dest).size > 0) return true;
    const snapUrl = await checkAvailable(orig);
    if (snapUrl === null) return false;
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
        console.log(`  [downloaded] ${rel}`);
        return true;
      }
    }
    console.warn(`  [unavailable] ${orig}`);
    return false;
  })();
  done.set(rel, p);
  return p;
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** rewrite any absolute wayback/origin/gstatic/protocol-relative url() to a local path */
function normalizeUrlRef(raw) {
  let u = raw.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  u = unwayback(u);
  if (u.startsWith('https://fonts.gstatic.com')) return u; // caller handles: local path = pathname
  if (u.startsWith(ORIGIN)) return u;
  return null;
}

const FONT_URL_RE = /url\((['"]?)([^'")]+)\1\)/g;

async function processCssText(css) {
  const jobs = [];
  const out = css.replace(FONT_URL_RE, (m, q, raw) => {
    const norm = normalizeUrlRef(raw);
    if (!norm) return m;
    let local;
    try {
      local = new URL(norm).pathname;
    } catch {
      return m;
    }
    jobs.push(ensureAsset(norm));
    return `url("${local}")`;
  });
  await Promise.all(jobs);
  return out;
}

async function main() {
  const files = walk(OUT);
  const htmls = files.filter((f) => f.endsWith('.html'));
  const csses = files.filter((f) => f.endsWith('.css') && statSync(f).isFile());

  // index sibling variants for missing uploads
  const uploadsDir = join(OUT, 'wp-content', 'uploads');
  const byStem = new Map(); // dir -> Map(stem -> [files])
  for (const year of readdirSync(uploadsDir)) {
    const ydir = join(uploadsDir, year);
    if (!statSync(ydir).isDirectory()) continue;
    for (const month of readdirSync(ydir)) {
      const mdir = join(ydir, month);
      if (!statSync(mdir).isDirectory()) continue;
      for (const f of readdirSync(mdir)) {
        const stem = f.replace(/-[0-9]+x[0-9]+/, '').replace(/\.[a-z]+$/i, '').toLowerCase();
        const key = `${year}/${month}`;
        if (!byStem.has(key)) byStem.set(key, new Map());
        const mm = byStem.get(key);
        if (!mm.has(stem)) mm.set(stem, []);
        mm.get(stem).push(f);
      }
    }
  }

  const IMG_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;
  let remapped = 0,
    stripped = 0,
    keptBroken = 0;

  for (const f of htmls) {
    let html = readFileSync(f, 'utf8');
    let changed = false;

    // --- 1. inline <style> blocks: fonts + protocol-relative assets
    html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
      if (!/url\(/.test(css)) return m;
      let touched = false;
      const rewritten = css.replace(FONT_URL_RE, (mm, q, raw) => {
        const norm = normalizeUrlRef(raw);
        if (!norm) return mm;
        let local;
        try {
          local = new URL(norm).pathname;
        } catch {
          return mm;
        }
        touched = true;
        ensureAsset(norm); // fire & forget; awaited in bulk below via done-map drain
        return `url("${local}")`;
      });
      if (touched) changed = true;
      return m.replace(css, rewritten);
    });

    // --- 2. remap / strip dead img refs (src + srcset)
    html = html.replace(/(src|srcset)=(\"([^\"]*)\"|'([^']*)')/gi, (m, attr, _q, dbl, sgl) => {
      const quote = dbl !== undefined ? '"' : "'";
      const val = dbl !== undefined ? dbl : sgl;
      if (/^https?:/i.test(val) || val.startsWith('data:')) return m;
      const parts = val.split(',').map((s) => {
        const seg = s.trim().split(/\s+/);
        const pathOnly = seg[0].split(/[?#]/)[0];
        if (!IMG_EXT.test(pathOnly) || existsSync(join(OUT, pathOnly))) return s.trim();
        const dirKey = pathOnly.split('/').slice(3, 5).join('/'); // YYYY/MM
        const base = pathOnly.split('/').pop();
        const stem = base.replace(/-[0-9]+x[0-9]+/, '').replace(/\.[a-z]+$/i, '').toLowerCase();
        const sibs = byStem.get(dirKey)?.get(stem) || [];
        const pick =
          sibs.find((x) => x.toLowerCase() === base.toLowerCase()) ||
          sibs.sort((a, b) => b.length - a.length)[0];
        if (pick) {
          remapped++;
          const newPath = pathOnly.slice(0, pathOnly.lastIndexOf('/') + 1) + pick;
          seg[0] = newPath;
          return seg.join(' ');
        }
        keptBroken++;
        return s.trim();
      });
      return `${attr}=${quote}${parts.join(', ')}${quote}`;
    });

    // --- 3. strip dead script/link tags (confirmed unarchived assets)
    html = html.replace(/<script[^>]*src=(\"|')([^\"']*siteground-optimizer-combined-js-[^\"']*)\1[^>]*>\s*<\/script>\s*/gi, () => {
      stripped++;
      return '';
    });
    html = html.replace(/<link[^>]*href=(\"|')([^\"']*wp-content\/et-cache\/[^\"']*)\1[^>]*>\s*/gi, (m, q, href) => {
      const pathOnly = href.split(/[?#]/)[0];
      if (existsSync(join(OUT, pathOnly))) return m;
      stripped++;
      return '';
    });
    html = html.replace(/<link[^>]*href=(\"|')\/xmlrpc\.php[^\"']*\1[^>]*>\s*/gi, () => {
      stripped++;
      return '';
    });

    if (changed || true) writeFileSync(f, html);
  }

  for (const f of csses) {
    const text = readFileSync(f, 'utf8');
    const out = await processCssText(text);
    if (out !== text) writeFileSync(f, out);
  }

  // drain pending downloads
  await Promise.all([...done.values()]);
  console.log(`\npolish done. remapped images: ${remapped}, stripped dead tags: ${stripped}, kept broken: ${keptBroken}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
