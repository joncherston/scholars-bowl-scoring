#!/usr/bin/env bash
# Switch back to the previously deployed image. Does not change the database.
set -euo pipefail
cd "$(dirname "$0")/.."
CUR=$(tail -n1 .deploy-history | awk '{print $2}')
PREV=$(awk '{print $2}' .deploy-history | grep -v "^$CUR$" | tail -n1)
[ -n "$PREV" ] || { echo "No earlier version to roll back to."; exit 1; }
echo "==> Rolling back from $CUR to $PREV"
APP_TAG=$PREV docker compose up -d --no-build
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $PREV rollback-from-$CUR" >> .deploy-history
echo "==> Running $PREV"
