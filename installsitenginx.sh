#!/usr/bin/env bash
# Wire the marketing site into the nginx server block that already serves the
# game.
#
#   bash install-site-nginx.sh            # show the plan, change nothing
#   APPLY=1 bash install-site-nginx.sh    # do it
#
# Editing nginx on a machine serving a live game is the risky step in this
# install, so: it shows you the plan first, backs the file up, and if `nginx -t`
# fails afterwards it restores the original BEFORE reloading. A bad edit can
# never take the game down — nginx keeps running the config it already had.
#
# Why this is not a simple paste. nginx allows exactly ONE `location /` PER
# SERVER BLOCK, and a real config has several server blocks: the port-80
# redirect has its own `location /`, and each TLS host has one too. Grepping the
# whole file cannot tell them apart, so this parses the file into server blocks
# by brace depth and works inside exactly one of them.
set -euo pipefail

CONF=${CONF:-}
PORT=${SITE_PORT:-8090}
GAME_ROOT=${GAME_ROOT:-/var/www/prizequiz}
TARGET=${TARGET:-}
APPLY=${APPLY:-0}
MARK_BEGIN='# >>> prizzequizz-site >>>'
MARK_END='# <<< prizzequizz-site <<<'

say() { echo "==> $*" >&2; }
die() { echo "!! $*" >&2; exit 1; }
command -v python3 >/dev/null || die "python3 is required to parse the nginx config safely"

# ---------------------------------------------------------------- find it ----
if [ -z "$CONF" ]; then
  for d in /etc/nginx/sites-enabled /etc/nginx/conf.d; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do
      if sudo grep -qE 'listen[[:space:]]+443|ssl_certificate' "$f" 2>/dev/null; then CONF="$f"; break 2; fi
    done < <(sudo find "$d" -maxdepth 1 \( -type f -o -type l \) | sort)
  done
fi
[ -n "$CONF" ] || die "could not find the nginx config. Re-run as: CONF=/etc/nginx/sites-enabled/yours bash $0"
say "config: $CONF"

RAW=$(mktemp); PLAN=$(mktemp); NEW=$(mktemp)
trap 'rm -f "$RAW" "$PLAN" "$NEW"' EXIT INT TERM
sudo cat "$CONF" > "$RAW"

# ------------------------------------------------------- parse + decide ------
python3 - "$RAW" "$PLAN" "${TARGET:-}" "$GAME_ROOT" "$PORT" "$MARK_BEGIN" "$MARK_END" <<'PY'
import re, sys, json

src, planfile, target, game_root, port, MB, ME = sys.argv[1:8]
lines = open(src, encoding='utf-8', errors='replace').read().split('\n')

def strip(l):
    # brace counting must ignore braces inside comments
    return l.split('#', 1)[0]

# Walk the file tracking depth, recording every top-level `server { ... }`.
blocks, depth, cur = [], 0, None
for i, l in enumerate(lines):
    s = strip(l)
    if depth == 0 and re.search(r'\bserver\s*\{', s):
        cur = {'start': i, 'locs': [], 'listen': [], 'name': '', 'ssl': False, 'redirect_only': True}
    if cur is not None:
        if re.search(r'^\s*location\s+/\s*\{', s):
            cur['locs'].append(i)
        m = re.search(r'^\s*listen\s+([^;]+);', s)
        if m: cur['listen'].append(m.group(1).strip())
        m = re.search(r'^\s*server_name\s+([^;]+);', s)
        if m: cur['name'] = m.group(1).strip()
        if 'ssl_certificate' in s: cur['ssl'] = True
        # a block that does more than bounce traffic is a real host
        if re.search(r'\b(root|proxy_pass|try_files|alias|index)\b', s): cur['redirect_only'] = False
    depth += s.count('{') - s.count('}')
    if cur is not None and depth == 0:
        cur['end'] = i          # the line holding this block's closing brace
        blocks.append(cur); cur = None

if not blocks:
    print('NOBLOCKS'); sys.exit(0)

def is_tls(b):
    return b['ssl'] or any('443' in x for x in b['listen'])

cands = [b for b in blocks if is_tls(b) and not b['redirect_only']] or \
        [b for b in blocks if is_tls(b)] or blocks

chosen = None
if target:
    n = int(target) - 1
    if 0 <= n < len(blocks): chosen = blocks[n]
elif len(cands) == 1:
    chosen = cands[0]

out = {
    'blocks': [{'n': i + 1, 'start': b['start'] + 1, 'end': b['end'] + 1,
                'listen': b['listen'], 'name': b['name'], 'ssl': b['ssl'],
                'redirect_only': b['redirect_only'],
                'locs': [x + 1 for x in b['locs']]} for i, b in enumerate(blocks)],
    'chosen': None if chosen is None else blocks.index(chosen) + 1,
}
if chosen is not None:
    body = '\n'.join(lines[chosen['start']:chosen['end'] + 1])
    # If the catch-all is an SPA fallback — `try_files $uri /index.html` — it can
    # be converted rather than refused: the same rule, with the site as the
    # fallback instead of the game's page. Find its try_files line.
    out['spa_line'] = None
    for ln in chosen['locs']:
        d = 0
        for j in range(ln, min(ln + 40, len(lines))):
            t = strip(lines[j])
            d += t.count('{') - t.count('}')
            m = re.search(r'^(\s*)try_files\s+\$uri\s+/index\.html\s*;', t)
            if m:
                out['spa_line'] = j + 1
                out['spa_indent'] = m.group(1)
                out['spa_loc_line'] = ln + 1
            if d <= 0 and j > ln:
                break
        if out['spa_line']:
            break
    out['has_catchall'] = len(chosen['locs']) > 0
    out['catchall_lines'] = [x + 1 for x in chosen['locs']]
    out['has_exact_root'] = bool(re.search(r'^\s*location\s+=\s*/\s*\{', body, re.M))
    out['has_play'] = bool(re.search(r'^\s*location\s+=\s*/play\s*\{', body, re.M))
    out['has_admin'] = bool(re.search(r'^\s*location\s+=\s*/pzadmin\.html\s*\{', body, re.M))
    out['has_assets'] = bool(re.search(r'^\s*location\s+~\*?[^{\n]*\\\.\(png', body, re.M))
    out['already'] = MB in body
    out['insert_before'] = chosen['end'] + 1
open(planfile, 'w').write(json.dumps(out))
print('OK')
PY

[ -s "$PLAN" ] || die "could not parse $CONF into server blocks"
get() { python3 -c "import json,sys;print(json.load(open('$PLAN')).get('$1',''))"; }

echo
echo "server blocks found in $CONF:"
python3 - "$PLAN" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for b in d['blocks']:
    mark = '  <-- target' if d['chosen'] == b['n'] else ''
    kind = 'redirect-only' if b['redirect_only'] else ('TLS host' if b['ssl'] or any('443' in x for x in b['listen']) else 'host')
    print(f"  [{b['n']}] lines {b['start']}-{b['end']}  {kind}"
          f"  listen={','.join(b['listen']) or '?'}  server_name={b['name'] or '?'}"
          f"  location/ at {b['locs'] or 'none'}{mark}")
PY
echo

CHOSEN=$(get chosen)
if [ -z "$CHOSEN" ] || [ "$CHOSEN" = "None" ]; then
  echo "!! more than one block could be the site's host — pick one and re-run:"
  echo "     TARGET=2 APPLY=1 bash $0"
  exit 1
fi
say "target: server block #$CHOSEN"

SPA_LINE=$(get spa_line)
if [ "$(get has_catchall)" = "True" ] && [ "$(get already)" != "True" ]; then
  if [ -n "$SPA_LINE" ] && [ "$SPA_LINE" != "None" ]; then
    # The catch-all is an SPA fallback: `try_files $uri /index.html`, i.e. "a
    # real file if there is one, otherwise the game's page". Only the FALLBACK
    # changes — a file on disk still wins, so the eNamad file, the manifest and
    # every asset carry on being served exactly as now.
    say "the catch-all is an SPA fallback (line $SPA_LINE) — its fallback will point at the site"
    CONVERT=1
  else
    echo
    echo "!! that block has a catch-all 'location / { }' at line $(get catchall_lines)"
    echo "   and it is not the SPA fallback this script knows how to convert."
    echo "   Nothing was changed. Send me those lines and I will tailor it."
    exit 1
  fi
else
  CONVERT=0
fi

# --------------------------------------------------------------- build it ----
BLOCK=$(mktemp); trap 'rm -f "$RAW" "$PLAN" "$NEW" "$BLOCK"' EXIT INT TERM
{
  echo "    $MARK_BEGIN"
  if [ "$(get has_exact_root)" = "True" ]; then
    say "keeping the block's existing 'location = /' (the game's root)"
  else
    printf '    location = / {\n        root %s;\n        try_files /index.html =404;\n    }\n' "$GAME_ROOT"
  fi
  [ "$(get has_play)" = "True" ] || printf '    location = /play {\n        root %s;\n        try_files /index.html =404;\n    }\n' "$GAME_ROOT"
  [ "$(get has_admin)" = "True" ] || printf '    location = /pzadmin.html {\n        root %s;\n    }\n' "$GAME_ROOT"
  if [ "$(get has_assets)" != "True" ]; then
    cat <<NGINX
    location ~* \\.(png|jpe?g|webp|avif|ico|gif|woff2?|mp3)\$ {
        root $GAME_ROOT;
        try_files \$uri @pzsite;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
NGINX
  fi
  cat <<NGINX
    # The game is one page, but push notifications deep-link into it. Before
    # this, the catch-all's /index.html fallback answered these; now that the
    # fallback is the site, they need saying out loud or every notification tap
    # lands on a marketing 404.
    location ~ ^/(wallet|shop|wheel|notifications|result|support)/?\$ {
        add_header Cache-Control "no-store, must-revalidate" always;
        try_files /index.html =404;
    }
NGINX
  if [ "$CONVERT" != "1" ]; then
    cat <<NGINX
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 3s;
        proxy_read_timeout 15s;
    }
NGINX
  fi
  cat <<NGINX
    location @pzsite {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    $MARK_END
NGINX
} > "$BLOCK"

echo "this will be inserted into block #$CHOSEN, before its closing brace on line $(get insert_before):"
sed 's/^/    | /' "$BLOCK"
echo

if [ "$APPLY" != "1" ]; then
  echo "Nothing was changed. To apply:"
  echo "    APPLY=1 TARGET=$CHOSEN bash $0"
  exit 0
fi

# --------------------------------------------------------------- apply it ----
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/tmp/nginx-$(basename "$CONF").$STAMP.bak"
sudo cp "$CONF" "$BACKUP"
say "backed up to $BACKUP"

INSERT_AT=$(get insert_before)
python3 - "$RAW" "$BLOCK" "$INSERT_AT" "$MARK_BEGIN" "$MARK_END" "${SPA_LINE:-}" "$CONVERT" > "$NEW" <<'PY'
import sys
src, blockfile, at, MB, ME = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
spa_line, convert = sys.argv[6], sys.argv[7]
lines = open(src, encoding='utf-8', errors='replace').read().split('\n')

# Repoint the SPA fallback: a real file still wins, the fallback becomes the
# site instead of the game's page. One line, in place, nothing else touched.
if convert == '1' and spa_line and spa_line != 'None':
    i = int(spa_line) - 1
    indent = lines[i][:len(lines[i]) - len(lines[i].lstrip())]
    lines[i] = indent + 'try_files $uri @pzsite;   # was: /index.html'

blk = open(blockfile, encoding='utf-8').read().rstrip('\n')
# drop any previous copy of our own block, so re-running replaces it
out, skip = [], False
for l in lines:
    if MB in l: skip = True; continue
    if skip:
        if ME in l: skip = False
        continue
    out.append(l)
# the closing brace moved up by however many lines we removed
removed = len(lines) - len(out)
idx = max(0, at - 1 - removed)
out.insert(idx, blk)
sys.stdout.write('\n'.join(out))
PY

grep -q "$MARK_BEGIN" "$NEW" || die "could not place the block"
sudo cp "$NEW" "$CONF"
say "block inserted"

if ! sudo nginx -t 2>&1 | sed 's/^/    /'; then
  echo
  say "nginx REJECTED the config — restoring the original, NOT reloading"
  sudo cp "$BACKUP" "$CONF"
  if sudo nginx -t >/dev/null 2>&1; then
    say "original restored and valid. Nothing was reloaded; the game never changed."
  else
    say "WARNING: the restored config also fails nginx -t — it was already failing before this ran."
  fi
  exit 1
fi

sudo systemctl reload nginx
say "nginx reloaded"

echo
say "checking through nginx:"
for p in / /play /v1/health /about /blog /sitemap.xml /site-admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1$p" 2>/dev/null) || code=""
  [ -n "$code" ] || code="—"
  printf '    %-14s %s\n' "$p" "$code"
done
echo
echo "/ and /play are the game. /about, /blog, /site-admin are the site."
echo "To undo:  sudo cp $BACKUP $CONF && sudo nginx -t && sudo systemctl reload nginx"
