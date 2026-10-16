import { ingestEvents, ROOM_TYPES, type IncomingEvent } from '$lib/server/ingest';
import { error, json } from '@sveltejs/kit';

/** Scorer devices send their queued events here. Safe to retry: duplicates are ignored. */
export async function POST({ locals, request }) {
	const a = locals.auth;
	if (a.kind !== 'room') error(401, 'Sign in with the room PIN');
	let body: { events?: IncomingEvent[] };
	try {
		body = await request.json();
	} catch {
		error(400, 'Bad request');
	}
	const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
	const results = ingestEvents(
		{
			eventId: a.room.eventId,
			roomId: a.room.id,
			deviceId: a.deviceId,
			actor: `room:${a.room.id}`,
			actorName: a.room.name,
			source: 'live',
			allowed: ROOM_TYPES,
			enforceLease: true,
			lockSubmitted: true
		},
		events
	);
	return json({ results });
}
