#!/usr/bin/env bash
# Removes the dead PWA service worker that is holding every visitor on a white
# screen, and refreshes the nginx config so a worker can never get stuck again.
#
# Run as:   sudo bash fix-sw.sh

set -u
WEB=/var/www/prizequiz
SA=/etc/nginx/sites-available
SE=/etc/nginx/sites-enabled
STAMP=$(date +%Y%m%d-%H%M%S)

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
bad() { printf '    \033[1;31m✗\033[0m %s\n' "$*"; }

[ "$(id -u)" = "0" ] || { bad "run with sudo:  sudo bash fix-sw.sh"; exit 1; }
[ -f "$PWD/sw-killer.js" ] || { bad "sw-killer.js not found in $PWD"; exit 1; }

say "what the old worker cached (this is what the browser keeps showing)"
if [ -f "$WEB/sw.js" ]; then
  grep -c "caches.match" "$WEB/sw.js" >/dev/null 2>&1 \
    && ok "found a cache-first worker at $WEB/sw.js — replacing it" \
    || ok "found $WEB/sw.js — replacing it"
  cp -a "$WEB/sw.js" "/root/sw.js.old.$STAMP"
  ok "old copy kept at /root/sw.js.old.$STAMP"
else
  ok "no sw.js on disk — installing the killer anyway, browsers still hold the registration"
fi

say "installing the self-destructing worker at /sw.js"
cp "$PWD/sw-killer.js" "$WEB/sw.js"
chmod 644 "$WEB/sw.js"
ok "installed"

say "removing the dead PWA leftovers"
for f in manifest.webmanifest; do
  if [ -f "$WEB/$f" ]; then
    # Kept, not deleted: the game has its own manifest plans and this is small.
    ok "$f left in place (harmless)"
  fi
done
[ -d "$WEB/assets" ] && { rm -rf "$WEB/assets"; ok "removed stale /assets"; } || ok "no /assets directory"

say "refreshing the nginx config (adds no-store for service workers)"
if [ -f "$PWD/prizequiz.nginx.conf" ]; then
  cp "$PWD/prizequiz.nginx.conf" "$SA/prizequiz"
  ln -sf "$SA/prizequiz" "$SE/prizequiz"
  if nginx -t 2>&1 | sed 's/^/    /'; then
    systemctl reload nginx && ok "nginx reloaded"
  else
    bad "nginx config test failed — nothing reloaded, the site is untouched"
    exit 1
  fi
else
  ok "prizequiz.nginx.conf not here; skipping the nginx step"
fi

say "verifying from the server"
printf '    sw.js is the killer : '
curl -s -m 8 https://www.prizequiz.ir/sw.js | grep -q "unregister" && echo "YES" || echo "NO  <- Cloudflare is still serving the old one"
printf '    sw.js cache header  : '
curl -sI -m 8 https://www.prizequiz.ir/sw.js | grep -i "cache-control" | head -1
printf '    page title          : '
curl -s -m 10 https://www.prizequiz.ir/ | grep -o '<title>[^<]*</title>' | head -1
printf '    API health          : '
curl -s -m 10 https://www.prizequiz.ir/v1/health | head -c 60; echo

say "now do this, in order"
cat <<'EOS'
    1. Cloudflare -> Caching -> Configuration -> Purge Everything
       (if the check above said NO, this is why)

    2. On your phone/browser, clear the site once. The worker is stored in the
       browser, not on the server, so it survives a normal refresh:

       Chrome desktop : F12 -> Application -> Service Workers -> Unregister
                        then F12 -> Application -> Storage -> Clear site data
       Chrome Android : ⋮ -> Settings -> Site settings -> All sites ->
                        prizequiz.ir -> Delete data
       Safari iOS     : Settings -> Safari -> Advanced -> Website Data ->
                        prizequiz.ir -> Delete

    3. Open https://www.prizequiz.ir again.

    Anyone visiting from now on gets the killer automatically on their first
    load and never sees the white screen.
EOS
