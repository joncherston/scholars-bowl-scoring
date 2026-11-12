import { isFinalStatus } from '$lib/engine';
import { formatPoints } from '$lib/engine/points';
import { error } from '@sveltejs/kit';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db';
import { computeLive } from './live';
import { gameScore, groupStandings, reportMode } from './reports';

/** Events whose results are public. Test events are never public. */
export function publicEvents() {
	return getDb()
		.select({ id: schema.events.id, name: schema.events.name, eventDate: schema.events.eventDate })
		.from(schema.events)
		.where(and(eq(schema.events.publicResults, true), eq(schema.events.isTest, false)))
		.orderBy(desc(schema.events.eventDate))
		.all();
}

export function assertPublic(eventId: number) {
	const e = getDb().select().from(schema.events).where(eq(schema.events.id, eventId)).get();
	if (!e || !e.publicResults || e.isTest) error(404, 'Results are not available for this event.');
	return e;
}

/** How many top scorers the public page lists per division. */
const PUBLIC_INDIVIDUAL_ROWS = 10;

/**
 * Live public results: games, brackets, team rankings by division and classification, and —
 * only when the event allows it — top individual scorers (first name + initial, or full name).
 * Nothing else about students ever leaves this function.
 */
export function publicResults(eventId: number) {
	const ev = assertPublic(eventId);
	const live = computeLive(eventId);
	const team = (id: string | number) => live.teams.find((t) => t.id === String(id));
	const teamName = (id: string | number) => team(id)?.name ?? '';
	const showIndividuals = ev.publicIndividuals !== 'off';
	const players = showIndividuals
		? Object.fromEntries(
				(() => {
					const ids = [...new Set(live.provisional.individuals.flatMap((g) => g.rows.map((r) => r.playerId)))];
					return ids.length ? getDb().select().from(schema.players).where(inArray(schema.players.id, ids)).all() : [];
				})().map((p) => [p.id, ev.publicIndividuals === 'full' ? `${p.preferredName?.trim() || p.firstName} ${p.lastName}` : `${p.preferredName?.trim() || p.firstName} ${p.lastName.charAt(0)}.`])
			)
		: {};
	const gameRow = (m: (typeof live.matches)[number]) => {
		const done = isFinalStatus(m.result.status) || m.result.status === 'submitted';
		return {
			id: m.id,
			room: m.roomName,
			label: m.slot ? (live.slots.find((s) => s.matchId === m.id)?.label ?? m.slot) : null,
			teamA: teamName(m.teamA),
			teamB: teamName(m.teamB),
			counts: m.counts,
			state: done ? 'final' : m.result.status === 'not_started' ? 'upcoming' : 'live',
			scoreA: formatPoints(gameScore(m.result, 'A').mine),
			scoreB: formatPoints(gameScore(m.result, 'B').mine),
			winner: done ? m.result.winner : null,
			note: m.result.forfeit ? 'forfeit' : m.result.decidedByTiebreaker ? 'tiebreaker' : ''
		};
	};
	return {
		event: { id: live.event.id, name: live.event.name, eventDate: live.event.eventDate },
		showIndividuals,
		sessions: live.sessions.map((s) => {
			const matches = live.matches.filter((m) => m.sessionId === s.id);
			const sid = String(s.id);
			const divisions = live.provisional.divisions
				.filter((g) => g.sessionIds.includes(sid))
				.map((pg) => {
					const { mode, st } = groupStandings(live, pg.sessionIds);
					const g = st.divisions.find((x) => x.key === pg.key) ?? pg;
					const ca = (mode === 'final' ? live.classAwards.final : live.classAwards.provisional).filter((c) => c.division === g.division);
					const ind = st.individuals.find((x) => x.division === g.division);
					const bracketGames = matches.filter((m) => m.stage === 'bracket' && m.counts && m.division === g.division);
					const divSlots = live.slots.filter((x) => x.sessionId === s.id && x.division === g.division);
					const pendingSlots = divSlots.filter((x) => x.counts && !x.matchId);
					return {
						label: g.label,
						format: g.format ?? 'round_robin',
						final: mode === 'final',
						rows: g.rows.map((r) => ({
							place: r.place,
							tied: r.tied,
							pending: !!r.pending,
							team: teamName(r.teamId),
							classification: team(r.teamId)?.classification ?? '',
							wins: r.record.wins,
							losses: r.record.losses,
							points: formatPoints(r.record.totalPoints),
							seed: r.seed ?? null,
							result: r.bracketResult ?? null
						})),
						seeds: (g.seeds ?? []).map((x) => ({ seed: x.seed, tied: x.tied, team: teamName(x.teamId), wins: x.record.wins, losses: x.record.losses, points: formatPoints(x.record.totalPoints) })),
						bracket: [
							...bracketGames.map(gameRow),
							...pendingSlots.map((x) => ({ id: -x.id, room: live.rooms.find((r) => r.id === x.roomId)?.name ?? '', label: x.label, teamA: describe(x.sourceA, divSlots), teamB: describe(x.sourceB, divSlots), counts: true, state: 'planned', scoreA: '', scoreB: '', winner: null, note: '' }))
						],
						classes: ca.map((c) => ({
							classification: c.classification,
							rows: c.rows.map((r) => {
								const rec = st.records[r.teamId];
								return { place: r.place, tied: r.tied, team: teamName(r.teamId), wins: rec?.wins ?? 0, losses: rec?.losses ?? 0, points: formatPoints(rec?.totalPoints ?? 0), pending: r.pending };
							})
						})),
						individuals: showIndividuals && ind ? ind.rows.slice(0, PUBLIC_INDIVIDUAL_ROWS).map((r) => ({ place: r.place, tied: r.tied, name: players[r.playerId] ?? '', team: teamName(r.teamId), points: formatPoints(r.total) })) : []
					};
				});
			return {
				id: s.id,
				name: s.name,
				final: reportMode(live, s.id) === 'final',
				divisions,
				rounds: [...new Set(matches.map((m) => m.roundNo))]
					.sort((a, b) => a - b)
					.map((roundNo) => ({ roundNo, games: matches.filter((m) => m.roundNo === roundNo).map(gameRow) }))
			};
		})
	};
}

function describe(src: string, slots: { slot: string; label: string }[]) {
	const [k, ref] = src.split(':');
	if (k === 'seed') return `Seed ${ref}`;
	return `${k === 'winner' ? 'Winner' : 'Loser'} of ${slots.find((x) => x.slot === ref)?.label ?? ref}`;
}
