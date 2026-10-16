import { computeRound } from '$lib/engine';
import { formatPoints } from '$lib/engine/points';
import { eq } from 'drizzle-orm';
import { getDb, schema } from './db';
import { listSessions } from './events';
import { rulesForMatch, matchEvents } from './ingest';
import { computeLive, type Live } from './live';
import { buildMatches } from './scorer';
import { sessionRooms } from './schedule';

export type Mode = 'final' | 'provisional';

/** Which standings a report uses: final when the session is finalized, otherwise provisional (labeled). */
export function reportMode(live: Live, sessionId: number): Mode {
	return live.sessions.find((s) => s.id === sessionId)?.finalizedAt ? 'final' : 'provisional';
}

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'th'}`;

export function awardsData(eventId: number, sessionIds?: number[]) {
	const live = computeLive(eventId, { sessionIds });
	const teamName = (id: string) => live.teams.find((t) => t.id === id)?.name ?? '?';
	const sessions = live.sessions.map((s) => {
		const mode = reportMode(live, s.id);
		const st = mode === 'final' ? live.final : live.provisional;
		const classes = st.classifications
			.filter((g) => g.sessionId === String(s.id))
			.sort((a, b) => live.event.classifications.indexOf(a.label) - live.event.classifications.indexOf(b.label))
			.map((g) => ({
				label: g.label,
				soleTeam: g.soleTeam,
				places: g.rows
					.filter((r) => r.place <= live.rules.awards.teamPlaces)
					.map((r) => ({
						place: r.place,
						placeLabel: ordinal(r.place),
						team: teamName(r.teamId),
						record: `${r.record.wins}–${r.record.losses}`,
						points: formatPoints(r.record.totalPoints),
						tied: r.tied,
						resolved: (r as { resolved?: string }).resolved ?? null
					}))
			}));
		const individuals = st.individuals
			.filter((g) => g.sessionId === String(s.id) || g.sessionId === null)
			.map((g) => ({
				label: g.label,
				places: g.rows
					.filter((r) => r.place <= live.rules.awards.individualPlaces)
					.map((r) => ({
						place: r.place,
						placeLabel: ordinal(r.place),
						name: live.playerNames[r.playerId] ?? 'Unknown',
						team: teamName(r.teamId),
						points: formatPoints(r.total),
						tied: r.tied,
						resolved: (r as { resolved?: string }).resolved ?? null
					}))
			}));
		const openTies = live.flags.filter((f) => f.tie).length;
		const unapproved = live.matches.filter((m) => m.sessionId === s.id && m.counts && m.result.status !== 'approved').length;
		return { id: s.id, name: s.name, date: s.date, mode, finalizedBy: s.finalizedBy, classes, individuals, openTies, unapproved };
	});
	return { event: live.event, rules: live.rules, sessions };
}

export function resultsData(eventId: number, sessionId: number) {
	const live = computeLive(eventId, { sessionIds: [sessionId] });
	const mode = reportMode(live, sessionId);
	const st = mode === 'final' ? live.final : live.provisional;
	const teamName = (id: string | number) => live.teams.find((t) => t.id === String(id))?.name ?? '?';
	const session = live.sessions[0];
	const fmtRow = (r: (typeof st.classifications)[number]['rows'][number]) => ({
		place: r.place,
		team: teamName(r.teamId),
		wins: r.record.wins,
		losses: r.record.losses,
		ties: r.record.ties,
		played: r.record.played,
		points: formatPoints(r.record.totalPoints),
		against: formatPoints(r.record.pointsAgainst),
		tied: r.tied,
		resolved: (r as { resolved?: string }).resolved ?? null
	});
	return {
		event: live.event,
		session,
		mode,
		classifications: st.classifications.map((g) => ({ label: g.label, soleTeam: g.soleTeam, rows: g.rows.map(fmtRow) })),
		pools: st.pools.map((g) => ({ label: g.label, rows: g.rows.map(fmtRow) })),
		matches: live.matches
			.sort((a, b) => a.roundNo - b.roundNo || a.roomName.localeCompare(b.roomName, undefined, { numeric: true }))
			.map((m) => ({
				id: m.id,
				roundNo: m.roundNo,
				room: m.roomName,
				teamA: teamName(m.teamA),
				teamB: teamName(m.teamB),
				counts: m.counts,
				status: m.result.status,
				scoreA: formatPoints(m.result.teams.A.roundScore),
				scoreB: formatPoints(m.result.teams.B.roundScore),
				winner: m.result.winner ? teamName(m.result.winner === 'A' ? m.teamA : m.teamB) : null,
				tiebreaker: m.result.decidedByTiebreaker
			})),
		individuals: st.individuals.map((g) => ({
			label: g.label,
			rows: g.rows.map((r) => ({
				place: r.place,
				name: live.playerNames[r.playerId] ?? 'Unknown',
				team: teamName(r.teamId),
				games: r.games,
				corrects: r.corrects,
				negs: r.negs,
				points: formatPoints(r.total),
				tied: r.tied
			}))
		}))
	};
}

/** Data for one round's scoresheet (blank when nothing has been scored). */
export function roundSheet(eventId: number, matchId: number) {
	const m = getDb().select().from(schema.matches).where(eq(schema.matches.id, matchId)).get();
	if (!m) return null;
	const [info] = buildMatches(eventId, [m]);
	const session = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, m.sessionId)).get()!;
	if (session.eventId !== eventId) return null;
	const moderator = sessionRooms(m.sessionId).find((r) => r.id === m.roomId)?.moderator ?? null;
	const rv = rulesForMatch(m, eventId);
	const result = computeRound(matchEvents(m.id), rv.settings);
	return { match: info, session: { id: session.id, name: session.name, date: session.date }, moderator, ruleVersion: m.ruleVersionId ? rv.version : null, result };
}

export function sessionMatchIds(eventId: number, sessionId: number, roundNo?: number) {
	return getDb()
		.select({ id: schema.matches.id, roundNo: schema.matches.roundNo, roomId: schema.matches.roomId })
		.from(schema.matches)
		.where(eq(schema.matches.sessionId, sessionId))
		.all()
		.filter((m) => roundNo === undefined || m.roundNo === roundNo)
		.sort((a, b) => a.roundNo - b.roundNo || a.roomId - b.roomId)
		.map((m) => m.id);
}

export { listSessions };
