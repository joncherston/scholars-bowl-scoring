import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { startPracticeGame } from '$lib/server/scorer';
import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';

/** A practice room's scorer starts a practice game (two teams from one session). Nothing scored in it counts. */
export async function POST({ locals, request }) {
	const a = locals.auth;
	if (a.kind !== 'room') error(401, 'Sign in with the room PIN');
	const room = getDb().select().from(schema.rooms).where(eq(schema.rooms.id, a.room.id)).get();
	if (room?.activeDeviceId !== a.deviceId) error(409, 'Another computer is scoring this room. Sign in again to take over.');
	let body: { sessionId?: unknown; teamA?: unknown; teamB?: unknown };
	try {
		body = await request.json();
	} catch {
		error(400, 'Bad request');
	}
	const res = startPracticeGame(a.room.eventId, a.room.id, { sessionId: Number(body.sessionId), teamA: Number(body.teamA), teamB: Number(body.teamB) });
	if (!res.ok) return json({ error: res.error }, { status: 400 });
	audit(`room:${a.room.id}`, 'practice_game_started', { matchId: res.matchId, sessionId: Number(body.sessionId), teamA: Number(body.teamA), teamB: Number(body.teamB) }, a.room.eventId);
	return json({ matchId: res.matchId });
}
