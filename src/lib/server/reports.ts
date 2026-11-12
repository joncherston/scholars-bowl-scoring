import { computeRound, isFinalStatus, type RoundResult, type Side } from '$lib/engine';
import { formatPoints } from '$lib/engine/points';
import { eq } from 'drizzle-orm';
import { getDb, schema } from './db';
import { listSessions } from './events';
import { rulesForMatch, matchEvents } from './ingest';
import { computeLive, type Live } from './live';
import { buildMatches } from './scorer';
import { practiceRoomIds, sessionRooms } from './schedule';

export type Mode = 'final' | 'provisional';

/** Which standings a report uses: final when the session is finalized, otherwise provisional (labeled). */
export function reportMode(live: Live, sessionId: number): Mode {
	return live.sessions.find((s) => s.id === sessionId)?.finalizedAt ? 'final' : 'provisional';
}

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'th'}`;

/**
 * Standings for an award group: final only when every session it covers is finalized
 * (a division can span sessions). Also names the sessions when it spans more than one.
 */
export function groupStandings(live: Live, sessionIds: string[]) {
	const all = listSessions(live.event.id);
	const mode: Mode = sessionIds.every((id) => all.find((s) => String(s.id) === id)?.finalizedAt) ? 'final' : 'provisional';
	const spans = sessionIds.length > 1 ? sessionIds.map((id) => all.find((s) => String(s.id) === id)?.name ?? '?').join(' and ') : null;
	return { mode, st: mode === 'final' ? live.final : live.provisional, spans };
}

/**
 * The score a team is credited with for a game: its counted points (regulation; tiebreaker
 * points never count), so a team's total points equal the sum of the scores shown.
 */
export function gameScore(result: RoundResult, side: Side) {
	const them: Side = side === 'A' ? 'B' : 'A';
	if (result.forfeit) return { text: result.winner === side ? 'W forfeit' : 'L forfeit', mine: 0, theirs: 0, note: result.forfeit.side === side ? 'forfeited' : 'won by forfeit' };
	const note = result.decidedByTiebreaker ? (result.winner === side ? 'won in tiebreaker' : 'lost in tiebreaker') : '';
	return { text: null, mine: result.teams[side].totalPoints, theirs: result.teams[them].totalPoints, note };
}

export function awardsData(eventId: number, sessionIds?: number[]) {
	const live = computeLive(eventId, { sessionIds });
	const team = (id: string) => live.teams.find((t) => t.id === id);
	const teamName = (id: string) => team(id)?.name ?? '?';
	const sessions = live.sessions.map((s) => {
		const mode = reportMode(live, s.id);
		const inSession = (g: { sessionIds: string[] }) => g.sessionIds.includes(String(s.id));
		const divisions = live.provisional.divisions.filter(inSession).map((pg) => {
			const { mode: gmode, st, spans } = groupStandings(live, pg.sessionIds);
			const g = st.divisions.find((x) => x.key === pg.key) ?? pg;
			return {
				label: g.label,
				soleTeam: g.soleTeam,
				spans,
				provisional: gmode !== 'final',
				places: g.rows
					.filter((r) => r.place <= live.rules.awards.teamPlaces)
					.map((r) => ({
						place: r.place,
						placeLabel: ordinal(r.place),
						team: teamName(r.teamId),
						classification: team(r.teamId)?.classification ?? '',
						record: `${r.record.wins}–${r.record.losses}`,
						points: formatPoints(r.record.totalPoints),
						tied: r.tied,
						resolved: (r as { resolved?: string }).resolved ?? null,
						bracketResult: r.bracketResult ?? null
					})),
				// 1st, 2nd… within each classification, in the division's final order.
				classes: (gmode === 'final' ? live.classAwards.final : live.classAwards.provisional)
					.filter((c) => c.division === g.division)
					.map((c) => ({
						classification: c.classification,
						places: c.rows
							.filter((r) => r.place <= live.rules.awards.classPlaces)
							.map((r) => {
								const rec = st.records[r.teamId];
								return { place: r.place, placeLabel: ordinal(r.place), team: teamName(r.teamId), record: `${rec?.wins ?? 0}–${rec?.losses ?? 0}`, points: formatPoints(rec?.totalPoints ?? 0), tied: r.tied, pending: r.pending };
							})
					}))
			};
		});
		const individuals = live.provisional.individuals
			.filter(inSession)
			.map((pg) => groupStandings(live, pg.sessionIds).st.individuals.find((x) => x.key === pg.key) ?? pg)
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
		const unapproved = live.matches.filter((m) => m.sessionId === s.id && m.counts && !isFinalStatus(m.result.status)).length;
		return { id: s.id, name: s.name, date: s.date, mode, finalizedBy: s.finalizedBy, divisions, individuals, openTies, unapproved };
	});
	return { event: live.event, rules: live.rules, sessions };
}

export function resultsData(eventId: number, sessionId: number) {
	const live = computeLive(eventId, { sessionIds: [sessionId] });
	const mode = reportMode(live, sessionId);
	const st = mode === 'final' ? live.final : live.provisional;
	const teamName = (id: string | number) => live.teams.find((t) => t.id === String(id))?.name ?? '?';
	const session = live.sessions[0];
	const fmtRow = (r: (typeof st.divisions)[number]['rows'][number]) => ({
		place: r.place,
		team: teamName(r.teamId),
		classification: live.teams.find((t) => t.id === r.teamId)?.classification ?? '',
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
		divisions: live.provisional.divisions.map((pg) => {
			const { mode: gmode, st: gst, spans } = groupStandings(live, pg.sessionIds);
			const g = gst.divisions.find((x) => x.key === pg.key) ?? pg;
			return { label: g.label, soleTeam: g.soleTeam, spans, provisional: gmode !== 'final', rows: g.rows.map(fmtRow) };
		}),
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
				scoreA: formatPoints(gameScore(m.result, 'A').mine),
				scoreB: formatPoints(gameScore(m.result, 'B').mine),
				winner: m.result.winner ? teamName(m.result.winner === 'A' ? m.teamA : m.teamB) : null,
				note: m.result.forfeit
					? `${teamName(m.result.forfeit.side === 'A' ? m.teamA : m.teamB)} forfeited`
					: m.result.decidedByTiebreaker
						? `${teamName(m.result.winner === 'A' ? m.teamA : m.teamB)} won in tiebreaker`
						: ''
			})),
		individuals: live.provisional.individuals.map((pg) => groupStandings(live, pg.sessionIds).st.individuals.find((x) => x.key === pg.key) ?? pg).map((g) => ({
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
	const practice = practiceRoomIds(eventId);
	return getDb()
		.select({ id: schema.matches.id, roundNo: schema.matches.roundNo, roomId: schema.matches.roomId })
		.from(schema.matches)
		.where(eq(schema.matches.sessionId, sessionId))
		.all()
		.filter((m) => (roundNo === undefined || m.roundNo === roundNo) && !practice.has(m.roomId))
		.sort((a, b) => a.roundNo - b.roundNo || a.roomId - b.roomId)
		.map((m) => m.id);
}

export { listSessions };
