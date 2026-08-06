#!/usr/bin/env bash
# Wire the marketing site into the nginx server block that already serves the
# game. Run on the server, in the directory holding this file.
#
# Editing nginx by hand on a machine serving a live game is the risky step in
# this whole install, so this does it the careful way: back the file up, refuse
# a config it does not understand, and if `nginx -t` fails afterwards put the
# original back BEFORE reloading. A bad edit can therefore never take the game
# down — nginx keeps running the config it already had.
#
# The trap this avoids: nginx allows exactly ONE `location /` per server block.
# A config that already serves the game defines one, so pasting a second is not
# a merge — it is `[emerg] duplicate location "/"`, and the reload fails for the
# whole domain. Every location below is added only if it is not already there.
set -euo pipefail

CONF=${CONF:-}
PORT=${SITE_PORT:-8090}
GAME_ROOT=${GAME_ROOT:-/var/www/prizequiz}
MARK_BEGIN='# >>> prizzequizz-site >>>'
MARK_END='# <<< prizzequizz-site <<<'

# Progress goes to stderr, not stdout. The config block below is built by
# redirecting a command group to a file, and a status line printed inside that
# group lands in the middle of the nginx config — which nginx then rejects with
# `unknown directive "==>"`.
say() { echo "==> $*" >&2; }
die() { echo "!! $*" >&2; exit 1; }

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
say "using config: $CONF"

sudo grep -q "$MARK_BEGIN" "$CONF" && ALREADY=1 || ALREADY=0
[ "$ALREADY" = 1 ] && say "our block is already here — replacing it"

has_loc() { sudo grep -qE "^[[:space:]]*location[[:space:]]+$1[[:space:]]*\{" "$CONF"; }

# A PREFIX `location /` is the one thing we cannot work around automatically:
# it is the site's own catch-all, and only one may exist. Say what to change
# rather than guess which of the two the operator meant to keep.
if [ "$ALREADY" = 0 ] && has_loc '/'; then
  echo
  echo "!! this config already has a catch-all 'location / { }':"
  sudo grep -nE "^[[:space:]]*location[[:space:]]+/[[:space:]]*\{" "$CONF" | sed 's/^/     /'
  echo
  echo "   nginx allows only one per server block. If that block serves the game,"
  echo "   narrow it to an EXACT match by adding one '=' :"
  echo
  echo "       location = / { try_files /index.html =404; }"
  echo
  echo "   That keeps the game on the root and frees the catch-all for the site."
  echo "   Then re-run this script."
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/tmp/nginx-$(basename "$CONF").$STAMP.bak"
sudo cp "$CONF" "$BACKUP"
say "backed up to $BACKUP"

# --------------------------------------------------------------- build it ----
BLOCK=$(mktemp); NEW=$(mktemp)
trap 'rm -f "$BLOCK" "$NEW"' EXIT INT TERM

{
  echo "$MARK_BEGIN"
  if has_loc '=[[:space:]]*/'; then
    say "keeping the existing 'location = /' (the game's root)"
  else
    cat <<NGINX
    # The game keeps the root. '=' is an exact match and outranks every prefix
    # location, so nothing below can take it.
    location = / {
        root $GAME_ROOT;
        try_files /index.html =404;
    }
NGINX
  fi
  has_loc '=[[:space:]]*/play' || cat <<NGINX
    location = /play {
        root $GAME_ROOT;
        try_files /index.html =404;
    }
NGINX
  has_loc '=[[:space:]]*/pzadmin\.html' || cat <<NGINX
    location = /pzadmin.html {
        root $GAME_ROOT;
    }
NGINX
  cat <<NGINX

    # Game assets first; anything that is not a file on disk falls to the site.
    location ~* \\.(png|jpe?g|webp|avif|ico|gif|woff2?|mp3)\$ {
        root $GAME_ROOT;
        try_files \$uri @pzsite;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Everything else is the marketing site.
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
    location @pzsite {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
$MARK_END
NGINX
} > "$BLOCK"

# --------------------------------------------------------------- apply it ----
# Insert before the closing brace of the last server block, dropping any earlier
# copy of our own block so re-running is idempotent.
sudo awk -v blockfile="$BLOCK" -v b="$MARK_BEGIN" -v e="$MARK_END" '
  BEGIN { while ((getline line < blockfile) > 0) blk = blk line "\n" }
  index($0, b) { skip = 1 }
  skip && index($0, e) { skip = 0; next }
  skip { next }
  { kept[n++] = $0 }
  END {
    last = -1
    for (i = 0; i < n; i++) if (kept[i] ~ /^[[:space:]]*\}[[:space:]]*$/) last = i
    for (i = 0; i < n; i++) { if (i == last) printf "%s", blk; print kept[i] }
  }' "$CONF" > "$NEW"

grep -q "$MARK_BEGIN" "$NEW" || die "could not place the block — is $CONF a normal server{} file?"
sudo cp "$NEW" "$CONF"
say "block inserted"

# ---------------------------------------------------------------- test it ----
if ! sudo nginx -t 2>&1 | sed 's/^/    /'; then
  echo
  say "nginx REJECTED the config — restoring the original, NOT reloading"
  sudo cp "$BACKUP" "$CONF"
  if sudo nginx -t >/dev/null 2>&1; then
    say "original restored and valid. Nothing was reloaded; the game never changed."
  else
    say "WARNING: the restored config also fails nginx -t. It was already failing before this script ran."
  fi
  exit 1
fi

sudo systemctl reload nginx
say "nginx reloaded"

# -------------------------------------------------------------- verify it ----
echo
say "checking through nginx (game paths must still answer):"
for p in / /play /v1/health /about /blog /sitemap.xml /site-admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1$p" 2>/dev/null) || code=""
  [ -n "$code" ] || code="—"   # curl could not connect at all
  printf '    %-14s %s\n' "$p" "$code"
done
echo
echo "/ and /play are the game. /about, /blog, /site-admin are the site."
echo "To undo:  sudo cp $BACKUP $CONF && sudo nginx -t && sudo systemctl reload nginx"
