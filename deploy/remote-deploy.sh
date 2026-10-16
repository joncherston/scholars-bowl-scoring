#!/usr/bin/env bash
# Runs on the server after `git push` updated this working tree.
# Builds the image, backs up the database, starts the new version, and rolls back if it is unhealthy.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=$(git rev-parse --short=10 HEAD)
PREV=$(tail -n1 .deploy-history 2>/dev/null | awk '{print $2}' || true)
mkdir -p data/backups

wait_healthy() {
	for _ in $(seq 1 60); do
		s=$(docker inspect -f '{{.State.Health.Status}}' scholars-bowl-scoring 2>/dev/null || echo none)
		[ "$s" = healthy ] && return 0
		sleep 2
	done
	return 1
}

echo "==> Building $TAG"
APP_TAG=$TAG docker compose build --quiet

if [ -f data/scoring.db ]; then
	echo "==> Backing up the database"
	APP_TAG=$TAG docker compose run --rm --no-deps -T app node scripts/backup.mjs pre-deploy
fi

echo "==> Starting $TAG (migrations run on startup)"
APP_TAG=$TAG docker compose up -d

if wait_healthy; then
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG" >> .deploy-history
	echo "==> Deployed $TAG"
	# Keep the five most recent images for rollback.
	docker images scholars-bowl-scoring --format '{{.Tag}}' | grep -v -e latest -e "$TAG" | tail -n +5 | xargs -r -I{} docker rmi scholars-bowl-scoring:{} >/dev/null 2>&1 || true
else
	echo "!!! $TAG did not become healthy"
	docker compose logs --tail 60 app || true
	if [ -n "$PREV" ]; then
		echo "==> Rolling back to $PREV"
		APP_TAG=$PREV docker compose up -d --no-build
		wait_healthy && echo "==> Rolled back to $PREV"
	fi
	exit 1
fi
