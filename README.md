# seo-coaching

Static recovery of **seo-coaching.net** (SEO Coaching, Mentoring & Training by Marketing Intelligence Ltd / Meelis Malk) from the Wayback Machine snapshot of **2025-02-17 04:42:45 UTC**.

**Live site:** https://seo-coaching.net (apex) · https://seo-coaching.pages.dev (Pages subdomain)

Custom domain `seo-coaching.net` is attached to the Pages project (CNAME apex/www → `seo-coaching.pages.dev`, flattened). `www` is 301-redirected to the apex by [`workers/www-redirect`](./workers/www-redirect) (a route Worker — it runs before Pages and preserves path + query string).

## Structure

- [`site/`](./site) — deployable static mirror (this is what Cloudflare Pages serves)
- [`tools/recover.mjs`](./tools/recover.mjs) — crawls the Wayback snapshot: downloads every page + asset (HTML, CSS, JS, images, fonts) and rewrites all URLs to local root-relative paths
- [`tools/repair.mjs`](./tools/repair.mjs) — re-scans saved files for missing asset references and fetches them (with an archive.org availability pre-check)
- [`tools/polish.mjs`](./tools/polish.mjs) — fixes inline font URLs, remaps dead images onto surviving size-variants, strips never-archived script/link tags
- [`tools/slim.mjs`](./tools/slim.mjs) — keeps only woff2 fonts and referenced assets (`--apply` to execute)
- [`large-files/`](./large-files) — files recovered but excluded from deployment (see below)

## Recovery pipeline

```bash
node tools/recover.mjs   # crawl snapshot into site/ (resumable, throttled)
node tools/repair.mjs    # fetch assets referenced but missing
node tools/polish.mjs    # fonts, image remap, dead-tag cleanup
bash tools/audit.sh      # report leftover/broken references
```

Requires Node 18+ (uses global `fetch`). The scripts wait out archive.org rate-limit
blocks (circuit breaker) and cache availability checks in `tools/.avail-cache.json`.

## Deployment

Cloudflare Pages project: `seo-coaching` (account: gestor824@gmail.com).

```bash
npx wrangler pages deploy site --project-name=seo-coaching --branch=main
```

## Known limitations (inherited from the snapshot)

- Divi's per-page builder CSS (`/wp-content/et-cache/*`) was **never archived** (robots.txt
  exclusion) and SiteGround's per-page JS bundles likewise — those `<link>/<script>` tags
  were stripped. Pages render with the global stylesheet (recovered) plus inline styles.
- ~44 content images have no surviving variant in the archive; their refs were remapped to
  the closest available size variant where one exists (615 refs remapped), otherwise they
  remain broken (browser shows alt text).
- `The-AI-in-Business-Trend-Report-2023.pdf` (78 MiB) exceeds Pages' 25 MiB per-file limit
  and is kept in [`large-files/`](./large-files) only.
- The contact form is static (action pointed at the old WordPress backend).

## Original site details (from the snapshot)

Marketing Intelligence Ltd, Reg. nr 16947960 · Tel PL +48 535 451 490 · Tel EE +372 50 19 349
