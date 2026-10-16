import { publish } from '$lib/server/bus';
import { getDb, schema } from '$lib/server/db';
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
	return json({ leaseOk, serverTime: new Date().toISOString(), pending: Number(info?.pending) || 0 });
}
