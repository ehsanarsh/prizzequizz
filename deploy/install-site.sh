#!/usr/bin/env bash
# Install the PrizzeQuizz marketing site. Run on the server as a user with sudo.
#
# This script NEVER touches the game: it does not stop the API container, does
# not write to /var/www/prizequiz, and does not run any game migration. The only
# shared resource is Postgres, where the site creates its own three tables.
set -euo pipefail

DIR=${SITE_DIR:-/home/ubuntu/pz-site}
PORT=${SITE_PORT:-8090}

echo "==> unpacking into $DIR"
mkdir -p "$DIR"
tar -xzf pz-site.tgz -C "$DIR"

echo "==> checking node"
node --version >/dev/null || { echo "node is required"; exit 1; }

# DATABASE_URL and ADMIN_KEY are read from the game's own env file so there is
# one place to change them. Adjust the path if yours differs.
ENV_SRC=${ENV_SRC:-/home/ubuntu/.env}
if [ -f "$ENV_SRC" ]; then
  echo "==> reusing $ENV_SRC for DATABASE_URL / ADMIN_KEY"
else
  echo "!! $ENV_SRC not found — set DATABASE_URL and ADMIN_KEY in $DIR/site.env yourself"
fi

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
ExecStart=/usr/bin/node $DIR/dist/server.js
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
sleep 2

echo "==> health"
curl -fsS "http://127.0.0.1:$PORT/site-health" && echo
echo
echo "Done. Next:"
echo "  1) add deploy/site-nginx.conf's blocks to your server{} and: sudo nginx -t && sudo systemctl reload nginx"
echo "  2) open https://YOUR-DOMAIN/site-admin and set «نشانی سایت» to your real domain"
echo
echo "The game was not touched. To undo everything:"
echo "  sudo systemctl disable --now pz-site && sudo rm /etc/systemd/system/pz-site.service"
