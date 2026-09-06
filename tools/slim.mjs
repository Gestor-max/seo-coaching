/**
 * Slims the static site to the minimum needed to serve it:
 *  1. Deletes non-woff2 font files (browsers only need woff2) and strips
 *     their url() entries from HTML/CSS.
 *  2. Deletes asset files that no page or stylesheet references.
 *
 * Usage:  node tools/slim.mjs        (dry run)
 *         node tools/slim.mjs --apply
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'site');
const APPLY = process.argv.includes('--apply');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(OUT);
const htmls = files.filter((f) => f.endsWith('.html'));
const csses = files.filter((f) => f.endsWith('.css') && statSync(f).isFile());
const rel = (f) => '/' + f.slice(OUT.length + 1).replace(/\\/g, '/');

// ---- collect referenced asset paths from HTML + CSS ----
const referenced = new Set();
const ATTR_RE = /(?:src|href|srcset|data-src|data-srcset|poster)=("([^"]*)"|'([^']*)')/gi;
const URL_RE = /url\((['"]?)([^'")]+)\1\)/g;

for (const f of htmls) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(ATTR_RE)) {
    const val = m[2] !== undefined ? m[2] : m[3];
    for (const seg of val.split(',')) {
      const url = seg.trim().split(/\s+/)[0];
      if (!url.startsWith('/')) continue;
      const p = url.split(/[?#]/)[0];
      if (/\.[a-z0-9]{2,5}$/i.test(p)) referenced.add(p);
    }
  }
  for (const m of html.matchAll(URL_RE)) {
    const url = m[2].trim();
    if (!url.startsWith('/')) continue;
    const p = url.split(/[?#]/)[0];
    if (/\.[a-z0-9]{2,5}$/i.test(p)) referenced.add(p);
  }
}
for (const f of csses) {
  const css = readFileSync(f, 'utf8');
  for (const m of css.matchAll(URL_RE)) {
    const url = m[2].trim();
    if (!url.startsWith('/')) continue;
    const p = url.split(/[?#]/)[0];
    if (/\.[a-z0-9]{2,5}$/i.test(p)) referenced.add(p);
  }
}

// ---- decide deletions ----
const isNonWoff2Font = (p) => /\.(ttf|woff)$/i.test(p) && p.startsWith('/s/');
const toDelete = [];
for (const f of files) {
  const p = rel(f);
  if (f.endsWith('.html')) continue; // pages always stay
  if (isNonWoff2Font(p)) {
    toDelete.push({ f, reason: 'non-woff2 font' });
    continue;
  }
  if (!referenced.has(p)) toDelete.push({ f, reason: 'unreferenced' });
}

let freed = 0;
for (const { f } of toDelete) freed += statSync(f).size;
console.log(`referenced assets: ${referenced.size}`);
console.log(`files to delete: ${toDelete.length} (${(freed / 1024 / 1024).toFixed(1)} MB)`);
const byReason = {};
for (const t of toDelete) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
console.log(byReason);

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to delete.');
  process.exit(0);
}

for (const { f } of toDelete) unlinkSync(f);

// ---- strip dead font url() entries from HTML/CSS (non-woff2 under /s/) ----
const DEAD_FONT_RE = /url\((['"]?)\/s\/[^'")]*\.(?:ttf|woff)\1\)\s*(?:format\((['"])[^)]*\2\))?/gi;
let stripped = 0;
for (const f of [...htmls, ...csses]) {
  if (!existsSync(f)) continue;
  const text = readFileSync(f, 'utf8');
  const out = text
    .replace(/,\s*,/g, ',') // collapse leftover empty list entries
    .replace(DEAD_FONT_RE, '');
  if (out !== text) {
    writeFileSync(f, out);
    stripped++;
  }
}
console.log(`stripped dead font refs from ${stripped} files`);

// prune empty dirs
let pruned = 0;
for (const f of files) {
  let dir = dirname(f);
  while (dir.length > OUT.length) {
    try {
      if (readdirSync(dir).length === 0) {
        rmdirSync(dir);
        pruned++;
        dir = dirname(dir);
      } else break;
    } catch {
      break;
    }
  }
}
console.log(`pruned ${pruned} empty dirs`);
