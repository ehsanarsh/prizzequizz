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
if [ -f "$ENV_SRC" ]; then
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

  sudo docker rm -f pz-site >/dev/null 2>&1 || true
  # Published on loopback only: nginx is what puts it on the internet.
  sudo docker run -d --name pz-site \
    --restart unless-stopped \
    --network "$NET" \
    -p "127.0.0.1:$PORT:$PORT" \
    -v "$DIR:/app:ro" \
    -w /app \
    -e SITE_PORT="$PORT" \
    -e NODE_ENV=production \
    ${ENV_SRC:+--env-file "$ENV_SRC"} \
    -m 256m \
    "$NODE_IMAGE" node /app/dist/server.js >/dev/null
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
  sudo docker logs --tail 30 pz-site 2>/dev/null || true
  exit 1
fi

echo
echo "Done. Next:"
echo "  1) add deploy/site-nginx.conf's blocks to your server{} and: sudo nginx -t && sudo systemctl reload nginx"
echo "  2) open https://YOUR-DOMAIN/site-admin and set «نشانی سایت» to your real domain"
echo
echo "The game was not touched. To undo everything:"
echo "  $UNDO"
