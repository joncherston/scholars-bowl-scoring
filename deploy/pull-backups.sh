#!/usr/bin/env bash
# Copy the server's database snapshots to this computer (over Tailscale/SSH).
#   ./deploy/pull-backups.sh           take a fresh snapshot on the server, then copy all snapshots
#   ./deploy/pull-backups.sh --watch   repeat every 10 minutes (leave running on event day)
# Server details come from .deploy.env. Copies go to $BACKUP_DEST (default ~/ScholarsBowlBackups).
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source .deploy.env
DEST="${BACKUP_DEST:-$HOME/ScholarsBowlBackups}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
[ -n "${DEPLOY_HOST_KEY_ALIAS:-}" ] && SSH_OPTS+=(-o "HostKeyAlias=$DEPLOY_HOST_KEY_ALIAS")
mkdir -p "$DEST"

pull_once() {
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] Snapshot and copy"
	ssh "${SSH_OPTS[@]}" "$DEPLOY_SSH" "cd '$DEPLOY_PATH' && docker compose exec -T app node scripts/backup.mjs offsite >/dev/null" \
		|| echo "  (could not take a fresh snapshot; copying existing ones)"
	if rsync -a --ignore-existing -e "ssh ${SSH_OPTS[*]}" "$DEPLOY_SSH:$DEPLOY_PATH/data/backups/" "$DEST/"; then
		echo "  OK: $(ls "$DEST" | wc -l | tr -d ' ') snapshot(s) in $DEST, newest: $(ls -t "$DEST" | head -1)"
	else
		echo "  FAILED to copy backups"
		return 1
	fi
}

if [ "${1:-}" = "--watch" ]; then
	while true; do
		pull_once
		sleep 600
	done
else
	pull_once
fi
