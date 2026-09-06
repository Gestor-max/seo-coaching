/** Removes leftover empty `src: ;` font declarations left by slim.mjs */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');

function walk(d) {
  const out = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    e.isDirectory() ? out.push(...walk(f)) : out.push(f);
  }
  return out;
}

let fixed = 0,
  removed = 0;
for (const f of walk(OUT)) {
  if (!f.endsWith('.html') && !f.endsWith('.css')) continue;
  const t = readFileSync(f, 'utf8');
  const n = (t.match(/src:\s*;/g) || []).length;
  if (!n) continue;
  writeFileSync(f, t.replace(/src:\s*;/g, ''));
  fixed++;
  removed += n;
}
console.log(`files fixed: ${fixed}, empty src removed: ${removed}`);
