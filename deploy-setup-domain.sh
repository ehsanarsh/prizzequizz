#!/usr/bin/env bash
# PrizzeQuizz — point prizequiz.ir at the game instead of the old PWA preview.
#
# Safe to run more than once. It refuses to reload nginx unless the new config
# passes `nginx -t`, and puts the old config back if it does not — so a mistake
# here cannot leave the site down.
#
# Run it as:   sudo bash setup-domain.sh

set -u

SA=/etc/nginx/sites-available
SE=/etc/nginx/sites-enabled
NEW_CONF=${NEW_CONF:-$PWD/prizequiz.nginx.conf}
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/root/nginx-backup-$STAMP

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
bad()  { printf '    \033[1;31m✗\033[0m %s\n' "$*"; }

if [ "$(id -u)" != "0" ]; then
  bad "run this with sudo:  sudo bash setup-domain.sh"; exit 1
fi

if [ ! -f "$NEW_CONF" ]; then
  bad "cannot find $NEW_CONF"
  bad "cd to the folder holding prizequiz.nginx.conf, then run it again"
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  bad "nginx is not installed on this machine"; exit 1
fi

say "nginx version"
nginx -v 2>&1 | sed 's/^/    /'

say "backing up the current nginx site config to $BACKUP"
mkdir -p "$BACKUP"
cp -a "$SE"/. "$BACKUP"/ 2>/dev/null || true
ok "backup written"

say "installing the new config"
cp "$NEW_CONF" "$SA/prizequiz"
ln -sf "$SA/prizequiz" "$SE/prizequiz"
ok "$SE/prizequiz -> $SA/prizequiz"

say "disabling the old vhost (it proxied the domain to the PWA on :4173)"
if [ -e "$SE/prizzequizz" ]; then
  mv "$SE/prizzequizz" "/root/prizzequizz.disabled.$STAMP"
  ok "moved to /root/prizzequizz.disabled.$STAMP"
else
  ok "already disabled"
fi

say "testing the config"
if nginx -t 2>&1 | sed 's/^/    /'; then
  ok "config is valid"
else
  bad "config test FAILED — putting everything back, nothing was changed"
  rm -f "$SE"/*
  cp -a "$BACKUP"/. "$SE"/ 2>/dev/null || true
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  bad "the site is back on the OLD config. Send the error above."
  exit 1
fi

say "reloading nginx"
if systemctl reload nginx; then
  ok "reloaded"
else
  bad "reload failed — see: journalctl -xeu nginx.service"
  exit 1
fi

say "stopping the old PWA container, so it cannot be served again"
PWA=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | awk '/4173/{print $1}')
if [ -n "${PWA:-}" ]; then
  docker stop "$PWA" >/dev/null 2>&1 && ok "stopped $PWA" || bad "could not stop $PWA"
else
  ok "nothing listening on 4173"
fi

say "checking it from the server itself"
printf '    local API   : '; curl -s -m 5 http://127.0.0.1:3000/v1/health | head -c 90; echo
printf '    via domain  : '; curl -s -m 10 https://www.prizequiz.ir/v1/health | head -c 90; echo
printf '    apex        : '; curl -s -m 10 https://prizequiz.ir/v1/health | head -c 90; echo
printf '    page title  : '; curl -s -m 10 https://www.prizequiz.ir/ | grep -o '<title>[^<]*</title>' | head -1; echo

say "done"
echo "    Both /v1/health lines above should read {\"ok\":true,...}"
echo "    The page title should be: <title>Prizze Quizz!</title>"
echo
echo "    If they still show the PWA, purge the Cloudflare cache"
echo "    (Caching -> Configuration -> Purge Everything) and set"
echo "    SSL/TLS -> Overview to: Full (strict)"
echo
echo "    To undo everything:"
echo "      sudo rm -f $SE/prizequiz"
echo "      sudo cp -a $BACKUP/. $SE/"
echo "      sudo nginx -t && sudo systemctl reload nginx"
