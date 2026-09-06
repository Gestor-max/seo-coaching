/**
 * Recovers the seo-coaching.net website from the Wayback Machine snapshot
 * taken at 2025-02-17 04:42:45 UTC and rebuilds it as a fully static site.
 *
 * Usage:  node tools/recover.mjs
 * Output: site/  (deployable static mirror)
 */
import { createWriteStream, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'site');

const TS = '20250217044245'; // snapshot timestamp
const ORIGIN = 'https://seo-coaching.net';
const WB = 'https://web.archive.org/web';

// Pages we never mirror (feeds, APIs, actions)
const SKIP_PATHS = [/^\/feed\/?/, /^\/comments\/feed\/?/, /^\/wp-json/, /^\/xmlrpc\.php/];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- availability cache (archive.org API, different host than web.archive.org) ---
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
    return undefined; // unknown — let caller try anyway
  })().then((r) => {
    availCache[origUrl] = r;
    writeFileSync(AVAIL_CACHE_FILE, JSON.stringify(availCache));
    availPending.delete(origUrl);
    return r;
  });
  availPending.set(origUrl, p);
  return p;
}

// --- global request pacing + circuit breaker (archive.org blocks request bursts) ---
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
      console.warn(`  [${res.status}] ${url} (attempt ${attempt + 1})`);
      if (res.status === 429 || res.status >= 500) tripCircuit();
    } catch (err) {
      console.warn(`  [err] ${url}: ${err.message} (attempt ${attempt + 1})`);
      tripCircuit();
    }
    await sleep(8000 * (attempt + 1));
  }
  return null;
}

/** Wait until web.archive.org answers, before starting the crawl. */
async function waitForArchive(maxMinutes = 30) {
  const deadline = Date.now() + maxMinutes * 60000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await pacedFetch(`${WB}/${TS}id_/${ORIGIN}/`);
      if (res.ok) {
        console.log(`archive.org reachable (attempt ${attempt})`);
        return;
      }
      console.log(`archive.org returned ${res.status}, waiting... (attempt ${attempt})`);
    } catch (err) {
      console.log(`archive.org unreachable (${err.message}), waiting... (attempt ${attempt})`);
    }
    await sleep(30000);
  }
  throw new Error('web.archive.org did not become reachable in time');
}

const wbUrl = (original, mod = '') => (mod ? `${WB}/${TS}${mod}_/${original}` : `${WB}/${TS}/${original}`);

/** Extract the original URL from a Wayback URL, or return the URL unchanged. */
function unwayback(url) {
  const m = url.match(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z]{2})?_\/(https?:\/\/.+)$/);
  return m ? m[1] : url;
}

/** Turn an original absolute URL into a local root-relative path, or null if external. */
function localPathFor(url) {
  let u = unwayback(url.trim());
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.startsWith('/')) return u.split(/[?#]/)[0] || null;
  if (u.startsWith(ORIGIN)) return u.slice(ORIGIN.length).split(/[?#]/)[0] || null;
  return null;
}

/** Fetch an asset from Wayback (best effort across modifiers) and save locally. */
const assetQueue = [];
const assetDone = new Map();
async function downloadAsset(url, refererPath = '/') {
  const orig = unwayback(url.trim());
  let key = orig;
  try {
    key = new URL(orig).pathname;
  } catch {}
  if (assetDone.has(key)) return assetDone.get(key);
  const p = (async () => {
    const rel = new URL(orig).pathname;
    const dest = join(OUT, rel);
    if (existsSync(dest) && statSync(dest).size > 0) return rel; // resume support
    // ask the availability API first (cheap, different host) to avoid 404-storms
    const snapUrl = await checkAvailable(orig);
    if (snapUrl === null) {
      console.warn(`  [NOT ARCHIVED] ${orig}`);
      return null;
    }
    const isBinary = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm)(\?|$)/i.test(orig);
    const tries = snapUrl
      ? [snapUrl] // exact closest capture
      : isBinary
        ? [wbUrl(orig, 'im_'), wbUrl(orig, '')]
        : [wbUrl(orig, ''), wbUrl(orig, 'id_')];
    for (const url of tries) {
      const buf = await fetchBuf(url);
      if (buf && buf.length > 0) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        if (/\.css$/i.test(rel)) await processCss(buf.toString('utf8'), orig);
        return rel;
      }
    }
    console.warn(`  [MISSING ASSET] ${orig}`);
    return null;
  })();
  assetDone.set(key, p);
  return p;
}

/** Download + rewrite url(...) references inside CSS. */
async function processCss(css, cssUrl) {
  const cssDir = posix.dirname(new URL(cssUrl).pathname);
  const urls = [...css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((m) => m[2]);
  const replacements = [];
  for (const u of urls) {
    const clean = unwayback(u);
    if (clean.startsWith('data:')) continue;
    let orig;
    try {
      orig = new URL(clean, cssUrl).href;
    } catch {
      continue;
    }
    if (!orig.startsWith(ORIGIN) && !orig.includes('fonts.gstatic.com')) continue; // leave other externals
    const local = await downloadAsset(orig, cssUrl);
    if (local) replacements.push([u, local]);
  }
  // Apply in one pass on the file we already saved
  if (replacements.length) {
    const rel = new URL(cssUrl).pathname;
    const dest = join(OUT, rel);
    let text = css;
    for (const [from, to] of replacements) text = text.split(from).join(to);
    writeFileSync(dest, text);
  }
}

/** Fetch a page as originally crawled (id_ = no Wayback toolbar injection). */
async function fetchPage(path) {
  const buf = await fetchBuf(wbUrl(ORIGIN + path, 'id_'));
  if (!buf) {
    // Some pages have no id_ capture; fall back to regular snapshot
    return await fetchBuf(wbUrl(ORIGIN + path, ''));
  }
  return buf;
}

const ATTR_RE = /\b(src|href|srcset|data-src|data-srcset|data-bg|data-large-file|data-medium-file|poster)=("([^"]*)"|'([^']*)')/g;
const ASSET_EXT_RE = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|txt|xml|pdf|zip)(\?|#|$)/i;
const STYLE_URL_RE = /url\((['"]?)(https?:\/\/(?:web\.archive\.org\/web\/\d+(?:[a-z]{2})?_\/https?:\/\/)?[^'")]+)\1\)/g;

async function processPage(path, html) {
  // ---- 1. collect asset refs from attributes (handles "double" and 'single' quotes)
  const jobs = [];
  html = html.replace(ATTR_RE, (m, attr, _q, dbl, sgl) => {
    const quote = dbl !== undefined ? '"' : "'";
    const val = dbl !== undefined ? dbl : sgl;
    if (/(srcset|data-srcset)$/i.test(attr)) {
      const parts = val.split(',').map((s) => {
        const seg = s.trim().split(/\s+/);
        const local = localPathFor(seg[0]);
        if (local) {
          jobs.push(downloadAsset(seg[0]));
          seg[0] = local;
        }
        return seg.join(' ');
      });
      return `${attr}=${quote}${parts.join(', ')}${quote}`;
    }
    const local = localPathFor(val);
    if (local && ASSET_EXT_RE.test(local)) {
      jobs.push(downloadAsset(val));
      return `${attr}=${quote}${local}${quote}`;
    }
    return m; // page links are handled in step 3
  });

  // ---- 2. inline <style> blocks: rewrite absolute font/asset URLs to local
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (m, css) => {
    const rewritten = css.replace(STYLE_URL_RE, (mm, q, url) => {
      const orig = unwayback(url);
      if (!orig.startsWith(ORIGIN) && !orig.includes('fonts.gstatic.com')) return mm;
      const local = localPathFor(orig);
      if (local) {
        jobs.push(downloadAsset(orig));
        return `url("${local}")`;
      }
      return mm;
    });
    return m.replace(css, rewritten);
  });

  // ---- 3. rewrite internal page links (origin or wayback-prefixed) to root-relative
  html = html.replace(
    /(href|data-url)="(https?:\/\/(?:web\.archive\.org\/web\/\d+(?:[a-z]{2})?_\/https?:\/\/)?seo-coaching\.net)(\/[^"#?]*|\/[^"]*)?"/g,
    (m, attr, _host, p) => `${attr}="${p || '/'}"`
  );

  // ---- 4. strip non-static junk: feeds, wp-json, emoji config, xmlrpc
  html = html.replace(/<link[^>]+type="application\/(?:rss\+xml|atom\+xml)"[^>]*>\s*/g, '');
  html = html.replace(/<link[^>]+rel=["'](?:alternate|EditURI|wlwmanifest)["'][^>]*>\s*/g, '');
  html = html.replace(/<link[^>]+href="[^"]*wp-json[^"]*"[^>]*>\s*/g, '');
  html = html.replace(/<script[^>]*wp-emoji-release[^>]*><\/script>\s*/g, '');

  await Promise.all(jobs);

  const dest = path === '/' ? join(OUT, 'index.html') : join(OUT, path.replace(/\/$/, ''), 'index.html');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
  console.log(`page saved: ${path} (${(html.length / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------- crawl ----
async function main() {
  await waitForArchive();
  const seen = new Set();
  const queue = ['/'];
  const discovered = [];

  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    if (SKIP_PATHS.some((re) => re.test(path))) continue;
    if (ASSET_EXT_RE.test(path)) continue; // asset URLs are fetched by processPage, not crawled

    const dest = path === '/' ? join(OUT, 'index.html') : join(OUT, path.replace(/\/$/, ''), 'index.html');
    let html;
    if (existsSync(dest)) {
      // page already recovered — use local copy for link discovery only
      html = readFileSync(dest, 'utf8');
    } else {
      console.log(`fetching ${path} ...`);
      const buf = await fetchPage(path);
      if (!buf) {
        console.warn(`  [MISSING PAGE] ${path}`);
        continue;
      }
      html = buf.toString('utf8');
      await processPage(path, html);
    }
    discovered.push(path);

    // discover internal links: absolute origin URLs, wayback-prefixed URLs, or root-relative (local files)
    const linkRe = /href="((?:https?:\/\/(?:web\.archive\.org\/web\/\d+(?:[a-z]{2})?_\/https?:\/\/)?seo-coaching\.net)?(\/[^"#?]*))"/g;
    for (const m of html.matchAll(linkRe)) {
      const orig = unwayback(m[1]);
      let p;
      try {
        p = orig.startsWith('/') ? orig.split(/[?#]/)[0] : new URL(orig).pathname;
      } catch {
        continue;
      }
      if (p.endsWith('.php') || p.startsWith('/wp-admin') || p === '/wp-json/' || p === '/xmlrpc.php') continue;
      if (!seen.has(p) && !queue.includes(p)) queue.push(p);
    }
    await sleep(200);
  }

  // summary
  let files = 0,
    bytes = 0;
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        files++;
        bytes += statSync(full).size;
      }
    }
  })(OUT);
  console.log(`\nDone. ${discovered.length} pages, ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB total`);
}

import { readdirSync } from 'node:fs';
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
