import { publish } from '$lib/server/bus';
import { getDb, getSqlite, schema } from '$lib/server/db';
import { reportPending } from '$lib/server/presence';
import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';

/** Keeps the room's "last heard" fresh and tells the device whether it still holds the room. */
export async function POST({ locals, request }) {
	const a = locals.auth;
	if (a.kind !== 'room') error(401, 'Sign in with the room PIN');
	const info = await request.json().catch(() => ({}));
	const db = getDb();
	const room = db.select().from(schema.rooms).where(eq(schema.rooms.id, a.room.id)).get();
	const leaseOk = room?.activeDeviceId === a.deviceId;
	if (leaseOk) {
		reportPending(a.room.id, Number(info?.pending) || 0);
		db.update(schema.rooms).set({ lastHeardAt: new Date().toISOString() }).where(eq(schema.rooms.id, a.room.id)).run();
		publish({ type: 'room', eventId: a.room.eventId, roomId: a.room.id });
	}
	// Changes whenever anything in this room's rounds changes (including staff corrections and approvals).
	const v = getSqlite()
		.prepare('SELECT COUNT(*) AS n, MAX(e.server_ts) AS t FROM score_events e JOIN matches m ON m.id = e.match_id WHERE m.room_id = ?')
		.get(a.room.id) as { n: number; t: string | null };
	const pub = db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.scheduleStatus, 'published')).all().length;
	// Games added, moved, or re-paired in this room (e.g. a bracket game created after pool play).
	const g = getSqlite()
		.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(id * 7 + round_no * 13 + team_a_id * 31 + team_b_id * 37 + counts), 0) AS h FROM matches WHERE room_id = ?')
		.get(a.room.id) as { n: number; h: number };
	return json({ leaseOk, serverTime: new Date().toISOString(), version: `${v.n}:${v.t ?? ''}:${pub}:${g.n}:${g.h}` });
}
