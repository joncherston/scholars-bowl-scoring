import { createRoomSession } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { ingestEvents, matchEvents, ROOM_TYPES, rulesForMatch } from '$lib/server/ingest';
import { noteFailure, tooManyFailures } from '$lib/server/rate-limit';
import { computeRound } from '$lib/engine';
import { fail, redirect } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import crypto from 'node:crypto';

export function load({ locals }) {
	if (locals.auth.kind === 'room') redirect(303, '/scorer');
}

const DEVICE = /^[0-9a-f-]{36}$/i;

export const actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const f = await request.formData();
		const pin = String(f.get('pin') ?? '').replace(/\D/g, '');
		const deviceId = String(f.get('deviceId') ?? '');
		const takeover = f.get('takeover') === '1';
		const ip = getClientAddress();
		if (!DEVICE.test(deviceId)) return fail(400, { error: 'This browser could not create a device ID. Please reload the page.' });

		// Campus computers may share one public address, so only failed attempts count.
		if (tooManyFailures(`pin-ip:${ip}`, 30, 60 * 60_000))
			return fail(429, { error: 'Too many wrong PINs from this network. Ask the head scorekeeper for help.' });
		if (pin.length !== 6) return fail(400, { error: 'Enter the 6-digit room PIN.' });

		const db = getDb();
		const hit = db
			.select({ room: schema.rooms, event: schema.events })
			.from(schema.rooms)
			.innerJoin(schema.events, eq(schema.rooms.eventId, schema.events.id))
			.where(and(eq(schema.rooms.pin, pin), eq(schema.rooms.active, true), ne(schema.events.status, 'archived')))
			.get();
		if (!hit) {
			noteFailure(`pin-ip:${ip}`);
			audit('anon', 'room_pin_failed', { ip });
			return fail(400, { error: 'That PIN does not match a room. Check the PIN card for your room.' });
		}

		const { room, event } = hit;
		if (room.activeDeviceId && room.activeDeviceId !== deviceId && !takeover) {
			return fail(409, { needsTakeover: true, pin, roomName: room.name, lastHeardAt: room.lastHeardAt, eventName: event.name });
		}
		if (room.activeDeviceId && room.activeDeviceId !== deviceId) {
			const previous = room.activeDeviceId;
			db.update(schema.rooms).set({ activeDeviceId: deviceId, lastHeardAt: new Date().toISOString() }).where(eq(schema.rooms.id, room.id)).run();
			// Record the takeover in every round this room has in progress.
			const ms = db.select().from(schema.matches).where(eq(schema.matches.roomId, room.id)).all();
			const inProgress = ms.filter((m) => {
				const st = computeRound(matchEvents(m.id), rulesForMatch(m, event.id).settings).status;
				return st === 'in_progress' || st === 'ended';
			});
			ingestEvents(
				{ eventId: event.id, roomId: room.id, deviceId, actor: `room:${room.id}`, actorName: room.name, source: 'live', allowed: ROOM_TYPES, enforceLease: true, lockSubmitted: true },
				inProgress.map((m) => ({ id: crypto.randomUUID(), matchId: m.id, body: { type: 'device_takeover' as const, previousDevice: previous } }))
			);
			audit(`room:${room.id}`, 'room_device_takeover', { previousDevice: previous, deviceId, ip }, event.id);
		} else {
			db.update(schema.rooms).set({ activeDeviceId: deviceId, lastHeardAt: new Date().toISOString() }).where(eq(schema.rooms.id, room.id)).run();
			audit(`room:${room.id}`, 'room_login', { deviceId, ip }, event.id);
		}
		createRoomSession(cookies, { id: room.id, name: room.name, eventId: event.id }, deviceId);
		redirect(303, '/scorer');
	}
};
