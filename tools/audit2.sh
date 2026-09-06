#!/bin/bash
cd "$(dirname "$0")/../site" || exit 1
echo "=== where is //seo-coaching.net ==="
grep -rln "=\"//seo-coaching.net" --include="*.html" . | head -3
grep -rhoE ".{60}//seo-coaching\.net[^\"']{0,60}" --include="*.html" . | head -4
echo "=== biggest files ==="
find . -type f -size +1M -exec du -h {} \; | sort -rh | head -12
echo "=== biggest dirs ==="
du -sh */ 2>/dev/null | sort -rh | head -6
echo "=== file type counts ==="
find . -type f | grep -oE "\.[a-z0-9]+$" | sort | uniq -c | sort -rn | head -10
