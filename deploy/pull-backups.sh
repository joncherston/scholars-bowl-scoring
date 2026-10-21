#!/usr/bin/env bash
# Copy the server's database snapshots to this computer (over Tailscale/SSH).
#   ./deploy/pull-backups.sh           take a fresh snapshot on the server, then copy all snapshots
#   ./deploy/pull-backups.sh --watch   repeat every 10 minutes (leave running on event day)
# Server details come from .deploy.env. Copies go to $BACKUP_DEST (default ~/ScholarsBowlBackups).
# Copies older than 30 days are removed, except event-day snapshots and the pre-deploy snapshots
# around an event (see deploy/backup-retention.sh). Nothing is removed unless a fresh snapshot arrived.
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
	local fresh=1 skip pruned=0 f
	ssh "${SSH_OPTS[@]}" "$DEPLOY_SSH" "cd '$DEPLOY_PATH' && docker compose exec -T app node scripts/backup.mjs offsite >/dev/null" \
		|| { echo "  (could not take a fresh snapshot; copying existing ones)"; fresh=0; }
	# Snapshots this computer doesn't keep: skipped when copying, removed here afterwards.
	skip=$(mktemp)
	{ ssh "${SSH_OPTS[@]}" "$DEPLOY_SSH" "ls -1 '$DEPLOY_PATH/data/backups'" 2>/dev/null; ls -1 "$DEST"; } | deploy/backup-retention.sh >"$skip"
	if rsync -a --ignore-existing --exclude-from="$skip" -e "ssh ${SSH_OPTS[*]}" "$DEPLOY_SSH:$DEPLOY_PATH/data/backups/" "$DEST/"; then
		if [ "$fresh" = 1 ]; then
			while read -r f; do
				[ -f "$DEST/$f" ] && rm -f "$DEST/$f" && pruned=$((pruned + 1))
			done <"$skip"
		fi
		echo "  OK: $(ls "$DEST" | grep -c '\.db$') snapshot(s) in $DEST, newest: $(ls -t "$DEST" | grep '\.db$' | head -1)"
		[ "$pruned" = 0 ] || echo "  Removed $pruned copies older than ${BACKUP_KEEP_DAYS:-30} days"
	else
		echo "  FAILED to copy backups"
		rm -f "$skip"
		return 1
	fi
	rm -f "$skip"
}

if [ "${1:-}" = "--watch" ]; then
	while true; do
		pull_once
		sleep 600
	done
else
	pull_once
fi
