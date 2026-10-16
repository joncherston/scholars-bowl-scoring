import { formatPoints } from '$lib/engine/points';
import { error } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from './db';
import { computeLive } from './live';
import { reportMode } from './reports';

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

/** Team standings and game results only. No student names ever leave this function. */
export function publicResults(eventId: number) {
	assertPublic(eventId);
	const live = computeLive(eventId);
	const teamName = (id: string | number) => live.teams.find((t) => t.id === String(id))?.name ?? '';
	return {
		event: { id: live.event.id, name: live.event.name, eventDate: live.event.eventDate },
		sessions: live.sessions.map((s) => {
			const mode = reportMode(live, s.id);
			const st = mode === 'final' ? live.final : live.provisional;
			const matches = live.matches.filter((m) => m.sessionId === s.id);
			return {
				id: s.id,
				name: s.name,
				final: mode === 'final',
				standings: st.classifications
					.filter((g) => g.sessionId === String(s.id))
					.sort((a, b) => live.event.classifications.indexOf(a.label) - live.event.classifications.indexOf(b.label))
					.map((g) => ({
						label: g.label,
						rows: g.rows.map((r) => ({ place: r.place, tied: r.tied, team: teamName(r.teamId), wins: r.record.wins, losses: r.record.losses, points: formatPoints(r.record.totalPoints) }))
					})),
				rounds: [...new Set(matches.map((m) => m.roundNo))]
					.sort((a, b) => a - b)
					.map((roundNo) => ({
						roundNo,
						games: matches
							.filter((m) => m.roundNo === roundNo)
							.map((m) => ({
								id: m.id,
								teamA: teamName(m.teamA),
								teamB: teamName(m.teamB),
								counts: m.counts,
								state: m.result.status === 'approved' || m.result.status === 'submitted' ? 'final' : m.result.status === 'not_started' ? 'upcoming' : 'live',
								scoreA: formatPoints(m.result.teams.A.roundScore),
								scoreB: formatPoints(m.result.teams.B.roundScore),
								winner: m.result.status === 'approved' || m.result.status === 'submitted' ? m.result.winner : null
							}))
					}))
			};
		})
	};
}
