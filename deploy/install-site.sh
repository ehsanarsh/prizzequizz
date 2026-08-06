#!/usr/bin/env bash
# Install the PrizzeQuizz marketing site. Run on the server as a user with sudo.
#
# This script NEVER touches the game: it does not stop the API container, does
# not write to /var/www/prizequiz, and does not run any game migration. The only
# shared resource is Postgres, where the site creates its own three tables.
#
# It runs the site under systemd when the host has node, and inside a small
# container when it does not — this server has docker but no host node, and
# installing a runtime system-wide just to serve a brochure site is a bigger
# change to the machine than the site itself.
set -euo pipefail

DIR=${SITE_DIR:-/home/ubuntu/pz-site}
PORT=${SITE_PORT:-8090}
API_CONTAINER=${API_CONTAINER:-prizzequizz-api-1}
NODE_IMAGE=${NODE_IMAGE:-node:22-alpine}

echo "==> unpacking into $DIR"
mkdir -p "$DIR"
tar -xzf pz-site.tgz -C "$DIR"

# DATABASE_URL and ADMIN_KEY are read from the game's own env file so there is
# one place to change them. Adjust the path if yours differs.
ENV_SRC=${ENV_SRC:-/home/ubuntu/.env}

# That file holds the database password, so it is root-owned and mode 600 —
# existing is not the same as readable. Read it through sudo when we have to,
# and never assume a plain cat will work.
read_env() {
  if [ -r "$1" ]; then cat "$1"
  else sudo cat "$1"
  fi
}

if sudo test -f "$ENV_SRC"; then
  echo "==> reusing $ENV_SRC for DATABASE_URL / ADMIN_KEY"
else
  echo "!! $ENV_SRC not found — set DATABASE_URL and ADMIN_KEY in $DIR/site.env yourself"
fi

install_with_systemd() {
  echo "==> host node found ($(node --version)) — installing as a systemd service"
  cat > /tmp/pz-site.service <<UNIT
[Unit]
Description=PrizzeQuizz marketing site
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=SITE_PORT=$PORT
Environment=NODE_ENV=production
EnvironmentFile=-$ENV_SRC
EnvironmentFile=-$DIR/site.env
ExecStart=$(command -v node) $DIR/dist/server.js
Restart=always
RestartSec=3
# The site must never be able to take the machine down with the game on it.
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT
  sudo mv /tmp/pz-site.service /etc/systemd/system/pz-site.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now pz-site
  UNDO="sudo systemctl disable --now pz-site && sudo rm /etc/systemd/system/pz-site.service"
}

install_with_docker() {
  echo "==> no host node — running the site in a container instead"
  # Join the API's network so the site reaches Postgres by exactly the hostname
  # the game's own DATABASE_URL already uses.
  NET=$(sudo docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$API_CONTAINER" 2>/dev/null | head -1 || true)
  if [ -z "$NET" ]; then
    echo "!! could not find the network of $API_CONTAINER — set API_CONTAINER and re-run"
    exit 1
  fi
  echo "==> using docker network: $NET"

  # docker's --env-file is stricter than the shell: it rejects `export FOO=`,
  # and it keeps quotes as part of the value. Normalise into a file it accepts
  # rather than handing it one it will refuse — a refused run creates NO
  # container, which is why `docker logs` had nothing to show.
  # This file carries the database password, so it is created private and
  # removed on every exit path — not left in /tmp for the next person to read.
  ENVF=$(mktemp)
  chmod 600 "$ENVF"
  RAW=$(mktemp)
  chmod 600 "$RAW"
  trap 'rm -f "$ENVF" "$RAW"' EXIT INT TERM

  # Sources, weakest first — the last definition of a key wins.
  #
  # The API CONTAINER is the authoritative one: whatever DATABASE_URL the game
  # is actually running with is reachable from the network we are joining, and
  # it is right even when compose defines it inline and no .env on disk has it.
  # Guessing at env files is what failed here twice.
  sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$API_CONTAINER" 2>/dev/null >> "$RAW" || true
  if sudo test -f "$ENV_SRC"; then read_env "$ENV_SRC" >> "$RAW" || true; fi
  if [ -f "$DIR/site.env" ]; then read_env "$DIR/site.env" >> "$RAW" || true; fi

  # Only what the site actually uses. The game's env also holds JWT secrets, the
  # VAPID private key and the SMS key — a brochure site has no business holding
  # any of them, and handing them over would widen their blast radius for free.
  WANT='^(DATABASE_URL|ADMIN_KEY|PGSSLMODE)='
  sed -e 's/^[[:space:]]*export[[:space:]]\+//' \
      -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' \
      -e 's/^\([A-Za-z_][A-Za-z0-9_]*\)="\(.*\)"$/\1=\2/' \
      -e "s/^\([A-Za-z_][A-Za-z0-9_]*\)='\(.*\)'$/\1=\2/" \
      "$RAW" \
    | grep -E "$WANT" \
    | awk -F= '{ k=$1; sub(/^[^=]*=/,""); v=$0; last[k]=v; order[k]=NR }
               END { for (k in last) print k "=" last[k] }' > "$ENVF" || true
  rm -f "$RAW"

  # The site's ONLY admin auth is this key, and it fails closed: unset in
  # production means /site-api refuses everything, which leaves the panel alive
  # but unable to save a single change. The game has no master key of its own —
  # it authenticates admins from the database — so there is nothing to inherit
  # and the site needs one minted for it.
  if ! grep -q '^ADMIN_KEY=' "$ENVF"; then
    NEWKEY=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "ADMIN_KEY=$NEWKEY" >> "$ENVF"
    touch "$DIR/site.env"; chmod 600 "$DIR/site.env"
    echo "ADMIN_KEY=$NEWKEY" >> "$DIR/site.env"
    GENERATED_KEY=$NEWKEY
  fi

  echo "SITE_PORT=$PORT" >> "$ENVF"
  echo "NODE_ENV=production" >> "$ENVF"
  echo "==> passing to the site: $(cut -d= -f1 "$ENVF" | sort | tr '\n' ' ')"

  if ! grep -q '^DATABASE_URL=' "$ENVF"; then
    echo "!! no DATABASE_URL — the site cannot reach Postgres."
    echo "   Looked in the $API_CONTAINER container's own environment, $ENV_SRC$([ -f "$DIR/site.env" ] && echo ", $DIR/site.env")."
    echo "   Show what the game is using:"
    echo "     sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $API_CONTAINER | grep -i data"
    echo "   Then put that line in $DIR/site.env and re-run."
    exit 1
  fi

  sudo docker rm -f pz-site >/dev/null 2>&1 || true
  # Published on loopback only: nginx is what puts it on the internet.
  # Errors are NOT suppressed — a failed run is the thing we need to see.
  sudo docker run -d --name pz-site \
    --restart unless-stopped \
    --network "$NET" \
    -p "127.0.0.1:$PORT:$PORT" \
    -v "$DIR:/app:ro" \
    -w /app \
    --env-file "$ENVF" \
    -m 256m \
    "$NODE_IMAGE" node /app/dist/server.js
  rm -f "$ENVF"
  UNDO="sudo docker rm -f pz-site"
}

echo "==> checking node"
if command -v node >/dev/null 2>&1; then
  install_with_systemd
elif command -v docker >/dev/null 2>&1 || sudo -n docker version >/dev/null 2>&1; then
  install_with_docker
else
  echo "neither node nor docker is available — cannot run the site"
  exit 1
fi

echo "==> waiting for the site to answer"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/site-health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" = 1 ]; then
  echo "site-health OK"
else
  echo "!! the site did not answer on port $PORT. Logs:"
  sudo systemctl status pz-site --no-pager 2>/dev/null | tail -20 || true
  # No 2>/dev/null here: "no such container" is itself the diagnosis.
  sudo docker ps -a --filter name=pz-site --format 'container: {{.Status}}' || true
  sudo docker logs --tail 40 pz-site || true
  exit 1
fi

echo
if [ -n "${GENERATED_KEY:-}" ]; then
  echo "================================================================"
  echo " ADMIN KEY (write this down — it is shown once):"
  echo
  echo "   $GENERATED_KEY"
  echo
  echo " It is the password for /site-admin. Saved to $DIR/site.env (mode 600)"
  echo " and reused on the next install, so re-running does not change it."
  echo "================================================================"
  echo
fi
echo "Done. Next:"
echo "  1) add deploy/site-nginx.conf's blocks to your server{} and: sudo nginx -t && sudo systemctl reload nginx"
echo "  2) open https://YOUR-DOMAIN/site-admin, enter the admin key above,"
echo "     and set «نشانی سایت» to your real domain"
echo
echo "The game was not touched. To undo everything:"
echo "  $UNDO"
