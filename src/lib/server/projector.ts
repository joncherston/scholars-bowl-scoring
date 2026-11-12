import { computeRound } from '$lib/engine';
import { error } from '@sveltejs/kit';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db';
import { getEvent } from './events';
import { matchEvents, rulesForMatch } from './ingest';
import { buildMatches } from './scorer';

export function roomByToken(token: string) {
	const room = getDb().select().from(schema.rooms).where(eq(schema.rooms.projectorToken, token)).get();
	if (!room || !room.active) error(404, 'This projector link is not valid. Ask an administrator for the current link.');
	return room;
}

export function roomMatchRows(room: { id: number; eventId: number; practice?: boolean }) {
	const db = getDb();
	const sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, room.eventId)).all();
	// A practice room shows its practice games whether or not the schedule is published.
	const published = sessions.filter((s) => room.practice || s.scheduleStatus === 'published').sort((a, b) => a.sortOrder - b.sortOrder).map((s) => s.id);
	if (!published.length) return [];
	return db
		.select()
		.from(schema.matches)
		.where(and(eq(schema.matches.roomId, room.id), inArray(schema.matches.sessionId, published)))
		.all()
		.sort((a, b) => published.indexOf(a.sessionId) - published.indexOf(b.sessionId) || a.roundNo - b.roundNo || a.id - b.id);
}

/** The game to show: one being scored now, else the most recent finished one, else the first scheduled. */
export function projectorState(token: string) {
	const room = roomByToken(token);
	const event = getEvent(room.eventId);
	const rows = roomMatchRows(room);
	let pickRow = rows[0];
	let latest = '';
	for (const m of rows) {
		const evs = matchEvents(m.id);
		if (!evs.length) continue;
		const st = computeRound(evs, rulesForMatch(m, room.eventId).settings).status;
		const last = evs[evs.length - 1].serverTs ?? '';
		if (st === 'in_progress' || st === 'ended') {
			pickRow = m;
			break;
		}
		if (last > latest) {
			latest = last;
			pickRow = m;
		}
	}
	const next = pickRow ? rows.find((m) => m.sessionId === pickRow.sessionId && m.roundNo === pickRow.roundNo + 1) : undefined;
	const [match] = pickRow ? buildMatches(room.eventId, [pickRow]) : [];
	const [nextMatch] = next ? buildMatches(room.eventId, [next]) : [];
	return {
		room: { id: room.id, name: room.name, practice: room.practice },
		event: { id: event.id, name: event.name, isTest: event.isTest },
		match: match ?? null,
		next: nextMatch ? { roundNo: nextMatch.roundNo, teams: { A: nextMatch.teams.A.name, B: nextMatch.teams.B.name } } : null,
		matchIds: rows.map((m) => m.id)
	};
}
