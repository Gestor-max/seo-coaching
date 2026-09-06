# seo-coaching

Static recovery of **seo-coaching.net** (SEO Coaching, Mentoring & Training by Marketing Intelligence Ltd / Meelis Malk) from the Wayback Machine snapshot of **2025-02-17 04:42:45 UTC**.

- [`site/`](./site) — deployable static mirror (this is what Cloudflare Pages serves)
- [`tools/recover.mjs`](./tools/recover.mjs) — Node script that crawled the Wayback snapshot, downloaded every page + asset (HTML, CSS, JS, images, fonts) and rewrote all URLs to local root-relative paths

## Re-run the recovery

```bash
node tools/recover.mjs   # re-crawls the snapshot into site/
```

Requires Node 18+ (uses global `fetch`). The script waits for web.archive.org if it is rate-limiting and skips feeds/wp-json endpoints.

## Local preview

```bash
npx serve site
# or
npx wrangler pages dev site
```

## Deploy

Pushes to `main` deploy automatically via Cloudflare Pages (Git integration).
Manual deploy:

```bash
npx wrangler pages deploy site --project-name=seo-coaching
```

## Notes

- Original CMS was WordPress + Divi (SiteGround-optimised). All dynamic endpoints
  (wp-json, xmlrpc, feeds) were stripped; the site is now fully static.
- Contact section (phone numbers, company details) is preserved as in the snapshot.

## Large files (not deployed)

Cloudflare Pages limits files to 25 MiB. The following recovered file is kept in
[`large-files/`](./large-files) but excluded from deployments:

- `The-AI-in-Business-Trend-Report-2023.pdf` (78 MiB, linked from the blog post about the AI in Business trend report)
