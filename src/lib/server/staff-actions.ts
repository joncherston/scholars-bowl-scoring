import type { EventBody } from '$lib/engine';
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { SessionUser } from './auth';
import { getDb, schema } from './db';
import { ingestEvents, STAFF_TYPES, type IngestResult } from './ingest';
import { scheduleBracketAdvance } from './bracket';

/** Record a head-scorekeeper action (approve, correction, …) in a round's log. */
export function staffEvent(user: SessionUser, eventId: number, matchId: number, body: EventBody): IngestResult {
	const m = getDb()
		.select({ sessionId: schema.matches.sessionId })
		.from(schema.matches)
		.innerJoin(schema.sessions, eq(schema.matches.sessionId, schema.sessions.id))
		.where(and(eq(schema.matches.id, matchId), eq(schema.sessions.eventId, eventId)))
		.get();
	if (!m) error(404, 'Round not found');
	const session = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, m.sessionId)).get()!;
	if (session.finalizedAt && !user.isAdmin) error(400, 'This session is finalized. An administrator must reopen it before changes can be made.');
	const [res] = ingestEvents(
		{
			eventId,
			roomId: null,
			deviceId: null,
			actor: `user:${user.id}`,
			actorName: user.name,
			source: 'staff',
			allowed: STAFF_TYPES,
			enforceLease: false,
			lockSubmitted: false
		},
		[{ id: crypto.randomUUID(), matchId, body }]
	);
	scheduleBracketAdvance(eventId);
	return res;
}
