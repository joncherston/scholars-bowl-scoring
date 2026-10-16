import { getDb, schema } from '$lib/server/db';
import { buildRoomState } from '$lib/server/scorer';
import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';

export function GET({ locals }) {
	const a = locals.auth;
	if (a.kind !== 'room') error(401, 'Sign in with the room PIN');
	const room = getDb().select().from(schema.rooms).where(eq(schema.rooms.id, a.room.id)).get();
	return json({ ...buildRoomState(a.room.eventId, a.room.id), deviceId: a.deviceId, leaseOk: room?.activeDeviceId === a.deviceId });
}
