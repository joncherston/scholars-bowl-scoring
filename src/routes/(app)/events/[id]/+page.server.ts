import { CONFIRM_ITEMS } from '$lib/engine';
import { getDb, schema } from '$lib/server/db';
import { eventIdParam, getEvent, listRooms, listSessions } from '$lib/server/events';
import { listTeams } from '$lib/server/teams';
import { count, eq, inArray } from 'drizzle-orm';

export function load({ params }) {
	const id = eventIdParam(params);
	const event = getEvent(id);
	const db = getDb();
	const sessions = listSessions(id);
	const teams = listTeams(id).filter((t) => !t.withdrawn);
	const staff = db.select().from(schema.eventStaff).where(eq(schema.eventStaff.eventId, id)).all();
	const sessionIds = sessions.map((s) => s.id);
	const matchCounts = sessionIds.length
		? db
				.select({ sessionId: schema.matches.sessionId, n: count() })
				.from(schema.matches)
				.where(inArray(schema.matches.sessionId, sessionIds))
				.groupBy(schema.matches.sessionId)
				.all()
		: [];
	return {
		confirmed: CONFIRM_ITEMS.filter((c) => event.confirmations[c.key]).length,
		confirmTotal: CONFIRM_ITEMS.length,
		rooms: listRooms(id).length,
		staff: { head: staff.filter((s) => s.role === 'head_scorekeeper').length, checkin: staff.filter((s) => s.role === 'checkin').length, bracket: staff.filter((s) => s.role === 'bracket_builder').length },
		sessions: sessions.map((s) => {
			const st = teams.filter((t) => t.sessionId === s.id);
			return {
				id: s.id,
				name: s.name,
				startTime: s.startTime,
				classifications: s.classifications,
				teams: st.length,
				arrived: st.filter((t) => t.arrivedAt).length,
				scheduleStatus: s.scheduleStatus,
				matches: matchCounts.find((m) => m.sessionId === s.id)?.n ?? 0,
				finalized: !!s.finalizedAt
			};
		}),
		unassignedTeams: teams.filter((t) => !t.sessionId).length
	};
}
