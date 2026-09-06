#!/bin/bash
cd "$(dirname "$0")/../site" || exit 1
pwd
echo "=== leftover web.archive.org refs (html/css) ==="
grep -rl "web.archive.org" --include="*.html" --include="*.css" . 2>/dev/null | wc -l
echo "=== leftover absolute origin refs ==="
grep -rhoE '(href|src)="https://seo-coaching\.net[^"]*"' --include="*.html" . 2>/dev/null | sort -u | head -8
echo "=== broken local refs ==="
grep -rhoE '(src|href)="/[^"#]*"' --include="*.html" . 2>/dev/null | sed 's/.*="//;s/"//' | sort -u | while read -r p; do [ -e ".$p" ] || echo "$p"; done > /tmp/broken-final.txt
wc -l < /tmp/broken-final.txt
head -20 /tmp/broken-final.txt
echo "=== size/files ==="
du -sh .
find . -type f | wc -l
