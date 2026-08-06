#!/usr/bin/env bash
# Install the recovered backend on the server.
#
# Run it next to pz-dist-contents.tgz:
#   bash install-backend.sh
#
# It keeps the previous build, so a rollback is one command (printed at the end).
set -euo pipefail

DIST=/home/ubuntu/pz-dist
TGZ=${1:-pz-dist-contents.tgz}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$TGZ" ] || { echo "missing $TGZ"; exit 1; }

if [ -d "$DIST" ]; then
  echo "keeping the current build as $DIST.bak-$STAMP"
  sudo cp -a "$DIST" "$DIST.bak-$STAMP"
fi

sudo mkdir -p "$DIST"
sudo rm -rf "${DIST:?}"/*
sudo tar -xzf "$TGZ" -C "$DIST"
sudo docker restart prizzequizz-api-1

echo "waiting for the API to answer…"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/v1/health || true)
  [ "$code" = "200" ] && { echo "health OK"; break; }
  sleep 2
done

echo
echo "checking the recovered endpoints:"
for p in /v1/missions /v1/hearts /v1/record/categories /v1/rewards/status; do
  printf '  %-24s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$p")"
done

echo
echo "rollback, if anything looks wrong:"
echo "  sudo rm -rf $DIST && sudo mv $DIST.bak-$STAMP $DIST && sudo docker restart prizzequizz-api-1"
