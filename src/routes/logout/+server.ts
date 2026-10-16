import { destroySession } from '$lib/server/auth';
import { getDb, schema } from '$lib/server/db';
import { redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

export function POST({ cookies, locals }) {
	const a = locals.auth;
	// A scorer signing out frees the room so the next computer doesn't need a takeover.
	if (a.kind === 'room' && a.deviceId)
		getDb()
			.update(schema.rooms)
			.set({ activeDeviceId: null })
			.where(and(eq(schema.rooms.id, a.room.id), eq(schema.rooms.activeDeviceId, a.deviceId)))
			.run();
	destroySession(cookies);
	redirect(303, a.kind === 'room' ? '/room' : '/');
}
