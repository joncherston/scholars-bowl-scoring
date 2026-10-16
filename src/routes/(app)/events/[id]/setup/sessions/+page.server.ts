import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { currentRuleVersion, eventIdParam, getEvent, listRooms, listSessions } from '$lib/server/events';
import { requireAdmin } from '$lib/server/guard';
import { fail } from '@sveltejs/kit';
import { and, count, eq } from 'drizzle-orm';

export function load({ params }) {
	const id = eventIdParam(params);
	const db = getDb();
	const sessions = listSessions(id).map((s) => ({
		...s,
		rooms: db.select().from(schema.sessionRooms).where(eq(schema.sessionRooms.sessionId, s.id)).all(),
		teamCount: db.select({ n: count() }).from(schema.teams).where(eq(schema.teams.sessionId, s.id)).get()!.n,
		matchCount: db.select({ n: count() }).from(schema.matches).where(eq(schema.matches.sessionId, s.id)).get()!.n
	}));
	return { sessions, rooms: listRooms(id), maxRounds: currentRuleVersion(id).settings.maxRoundsPerSession };
}

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

export const actions = {
	save: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const event = getEvent(eventId);
		const max = currentRuleVersion(eventId).settings.maxRoundsPerSession;
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		const s = getDb().select().from(schema.sessions).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.eventId, eventId))).get();
		if (!s) return fail(404, { error: 'Session not found.' });
		const name = String(f.get('name') ?? '').trim();
		const date = String(f.get('date') ?? '');
		const startTime = String(f.get('startTime') ?? '');
		const roundCount = Number(f.get('roundCount'));
		const classifications = event.classifications.filter((c) => f.getAll('classifications').includes(c));
		const roundTimes = String(f.get('roundTimes') ?? '')
			.split(/[,\s]+/)
			.filter(Boolean);
		if (!name) return fail(400, { error: 'Session name is required.', sessionId });
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, { error: 'Session date is required.', sessionId });
		if (!TIME.test(startTime)) return fail(400, { error: 'Start time must look like 08:30.', sessionId });
		if (!Number.isInteger(roundCount) || roundCount < 1 || roundCount > max)
			return fail(400, { error: `Rounds must be between 1 and ${max}.`, sessionId });
		if (roundTimes.some((t) => !TIME.test(t))) return fail(400, { error: 'Round times must look like 08:45, 09:20, …', sessionId });

		const db = getDb();
		db.transaction((tx) => {
			tx.update(schema.sessions).set({ name, date, startTime, roundCount, classifications, roundTimes }).where(eq(schema.sessions.id, sessionId)).run();
			const roomIds = f.getAll('roomIds').map(Number);
			const existing = tx.select().from(schema.sessionRooms).where(eq(schema.sessionRooms.sessionId, sessionId)).all();
			for (const r of existing) if (!roomIds.includes(r.roomId)) tx.delete(schema.sessionRooms).where(eq(schema.sessionRooms.id, r.id)).run();
			for (const roomId of roomIds) {
				const moderator = String(f.get(`moderator_${roomId}`) ?? '').trim() || null;
				const row = existing.find((r) => r.roomId === roomId);
				if (row) tx.update(schema.sessionRooms).set({ moderator }).where(eq(schema.sessionRooms.id, row.id)).run();
				else tx.insert(schema.sessionRooms).values({ sessionId, roomId, moderator }).run();
			}
		});
		audit(`user:${admin.id}`, 'session_saved', { sessionId, name, roundCount, classifications }, eventId);
		return { savedSession: sessionId };
	},

	add: async ({ locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const event = getEvent(eventId);
		const n = listSessions(eventId).length;
		const db = getDb();
		const [s] = db
			.insert(schema.sessions)
			.values({ eventId, name: `Session ${n + 1}`, date: event.eventDate, startTime: '08:30', classifications: [], sortOrder: n, roundCount: 6 })
			.returning()
			.all();
		for (const r of listRooms(eventId)) db.insert(schema.sessionRooms).values({ sessionId: s.id, roomId: r.id }).run();
		audit(`user:${admin.id}`, 'session_added', { sessionId: s.id }, eventId);
	},

	remove: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const sessionId = Number((await request.formData()).get('sessionId'));
		const db = getDb();
		const teams = db.select({ n: count() }).from(schema.teams).where(eq(schema.teams.sessionId, sessionId)).get()!.n;
		const games = db.select({ n: count() }).from(schema.matches).where(eq(schema.matches.sessionId, sessionId)).get()!.n;
		if (teams || games) return fail(400, { error: 'Move its teams and delete its schedule before removing a session.' });
		db.transaction((tx) => {
			tx.delete(schema.sessionRooms).where(eq(schema.sessionRooms.sessionId, sessionId)).run();
			tx.delete(schema.pools).where(eq(schema.pools.sessionId, sessionId)).run();
			tx.delete(schema.sessions).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.eventId, eventId))).run();
		});
		audit(`user:${admin.id}`, 'session_removed', { sessionId }, eventId);
	}
};
