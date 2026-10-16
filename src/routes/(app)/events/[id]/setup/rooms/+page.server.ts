import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { eventIdParam, generatePin, listRooms, listSessions, newProjectorToken } from '$lib/server/events';
import { requireAdmin } from '$lib/server/guard';
import { fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

export function load({ params, url }) {
	const id = eventIdParam(params);
	return { rooms: listRooms(id, true), origin: url.origin };
}

function roomOf(eventId: number, f: FormData) {
	const roomId = Number(f.get('roomId'));
	return getDb().select().from(schema.rooms).where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.eventId, eventId))).get();
}

export const actions = {
	rename: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const f = await request.formData();
		const room = roomOf(eventId, f);
		const name = String(f.get('name') ?? '').trim();
		if (!room || !name) return fail(400, { error: 'Enter a room name.' });
		getDb().update(schema.rooms).set({ name }).where(eq(schema.rooms.id, room.id)).run();
		audit(`user:${admin.id}`, 'room_renamed', { roomId: room.id, from: room.name, to: name }, eventId);
	},
	add: async ({ locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const all = listRooms(eventId, true);
		const db = getDb();
		const [r] = db
			.insert(schema.rooms)
			.values({ eventId, name: `Room ${all.length + 1}`, sortOrder: all.length, pin: generatePin(), projectorToken: newProjectorToken() })
			.returning()
			.all();
		for (const s of listSessions(eventId)) db.insert(schema.sessionRooms).values({ sessionId: s.id, roomId: r.id }).run();
		audit(`user:${admin.id}`, 'room_added', { roomId: r.id }, eventId);
	},
	toggle: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const room = roomOf(eventId, await request.formData());
		if (!room) return fail(404, { error: 'Room not found.' });
		getDb().update(schema.rooms).set({ active: !room.active }).where(eq(schema.rooms.id, room.id)).run();
		if (room.active) getDb().delete(schema.authSessions).where(eq(schema.authSessions.roomId, room.id)).run();
		audit(`user:${admin.id}`, room.active ? 'room_deactivated' : 'room_activated', { roomId: room.id }, eventId);
	},
	pin: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const room = roomOf(eventId, await request.formData());
		if (!room) return fail(404, { error: 'Room not found.' });
		const db = getDb();
		db.update(schema.rooms).set({ pin: generatePin() }).where(eq(schema.rooms.id, room.id)).run();
		// A new PIN signs out every device using the old one.
		db.delete(schema.authSessions).where(eq(schema.authSessions.roomId, room.id)).run();
		audit(`user:${admin.id}`, 'room_pin_regenerated', { roomId: room.id }, eventId);
		return { message: `${room.name} has a new PIN. Devices using the old PIN were signed out.` };
	},
	projector: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const room = roomOf(eventId, await request.formData());
		if (!room) return fail(404, { error: 'Room not found.' });
		getDb().update(schema.rooms).set({ projectorToken: newProjectorToken() }).where(eq(schema.rooms.id, room.id)).run();
		audit(`user:${admin.id}`, 'room_projector_link_regenerated', { roomId: room.id }, eventId);
		return { message: `${room.name} has a new projector link. The old link no longer works.` };
	},
	release: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const room = roomOf(eventId, await request.formData());
		if (!room) return fail(404, { error: 'Room not found.' });
		getDb().update(schema.rooms).set({ activeDeviceId: null }).where(eq(schema.rooms.id, room.id)).run();
		audit(`user:${admin.id}`, 'room_device_released', { roomId: room.id, deviceId: room.activeDeviceId }, eventId);
		return { message: `${room.name} is free; the next device to sign in becomes its scorer.` };
	}
};
