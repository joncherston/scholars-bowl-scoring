#!/usr/bin/env bash
# Which snapshot copies this computer should not keep (used by pull-backups.sh).
# Reads snapshot file names on stdin and prints the ones to leave out: everything older than
# $BACKUP_KEEP_DAYS (default 30), except event-day snapshots and the pre-deploy snapshots within
# $EVENT_WINDOW_DAYS (default 7) of an event day, which are kept for good.
# Ages come from the UTC stamp in each name. Written for macOS's bash 3.2.
set -euo pipefail
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
WINDOW_DAYS="${EVENT_WINDOW_DAYS:-7}"

# Seconds since 1970 for a UTC stamp YYYYMMDDHHMMSS (BSD date, then GNU date).
epoch() { date -j -u -f %Y%m%d%H%M%S "$1" +%s 2>/dev/null || date -u -d "${1:0:8} ${1:8:2}:${1:10:2}:${1:12:2}" +%s; }
# The first 14 digits of a name, e.g. scoring-nightly-20261021-070001.db or pre-migration-2026-10-16T01-38-51-660Z.db.
stamp() { local d="${1//[!0-9]/}"; printf '%s' "${d:0:14}"; }

cutoff=$(date -u -v-"${KEEP_DAYS}"d +%Y%m%d%H%M%S 2>/dev/null || date -u -d "-$KEEP_DAYS days" +%Y%m%d%H%M%S)
names=$(grep -E '^[A-Za-z0-9._-]+\.db$' | sort -u || true)

# Event days (UTC dates of event-day snapshots), as day numbers.
event_days=""
for d in $(printf '%s\n' "$names" | grep '^scoring-event-day-' | while read -r f; do s=$(stamp "$f"); echo "${s:0:8}"; done | sort -u); do
	event_days="$event_days $(($(epoch "${d}000000") / 86400))"
done

near_event() {
	local day=$(($(epoch "$1") / 86400)) e
	for e in $event_days; do
		[ $((day - e)) -le "$WINDOW_DAYS" ] && [ $((e - day)) -le "$WINDOW_DAYS" ] && return 0
	done
	return 1
}

printf '%s\n' "$names" | while read -r f; do
	[ -n "$f" ] || continue
	case "$f" in scoring-event-day-*) continue ;; esac
	s=$(stamp "$f")
	[ ${#s} -eq 14 ] || continue # no stamp: leave it alone
	[[ "$s" < "$cutoff" ]] || continue
	case "$f" in scoring-pre-deploy-*) near_event "$s" && continue ;; esac
	echo "$f"
done
