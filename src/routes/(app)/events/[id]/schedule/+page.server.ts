import { validateSchedule, byesByRound, type SchedMatch } from '$lib/schedule';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { currentRuleVersion, eventIdParam, listSessions } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { generateDraft, getSession, loadSchedule, poolIdForTeams, savePoolRounds, savePools, startedMatchIds } from '$lib/server/schedule';
import { fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

export function load({ locals, params, url }) {
	const id = eventIdParam(params);
	requireEventRole(locals.auth, id, ['bracket_builder', 'head_scorekeeper'], url);
	const sessions = listSessions(id);
	const sessionId = Number(url.searchParams.get('session')) || sessions[0]?.id;
	if (!sessionId) return { sessionId: null };
	const sched = loadSchedule(id, sessionId);
	const issues = validateSchedule({ teams: sched.teams, rooms: sched.rooms, roundCount: sched.session.roundCount, matches: sched.matches });
	const byes = Object.fromEntries(byesByRound(sched.teams, sched.matches, sched.session.roundCount));
	return { sessionId, ...sched, issues, byes, maxRounds: currentRuleVersion(id).settings.maxRoundsPerSession };
}

function ctx(locals: App.Locals, params: { id: string }, write = true) {
	const eventId = eventIdParam(params);
	const user = requireEventRole(locals.auth, eventId, write ? ['bracket_builder'] : ['bracket_builder', 'head_scorekeeper']);
	return { eventId, user };
}

/** Hard errors that a single edit may not introduce. */
function editErrors(eventId: number, sessionId: number, next: SchedMatch[]) {
	const s = loadSchedule(eventId, sessionId);
	return validateSchedule({ teams: s.teams, rooms: s.rooms, roundCount: s.session.roundCount, matches: next })
		.filter((i) => i.level === 'error')
		.map((i) => i.message);
}

export const actions = {
	pools: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		const s = getSession(eventId, sessionId);
		if (startedMatchIds(sessionId).size) return fail(400, { error: 'Scoring has started; pools can no longer change.' });
		const assignment: Record<string, string> = {};
		for (const [k, v] of f.entries()) if (k.startsWith('pool_')) assignment[k.slice(5)] = String(v);
		savePools(s.id, assignment);
		audit(`user:${user.id}`, 'pools_saved', { sessionId, assignment }, eventId);
		return { message: 'Pools saved. Generate a new draft to use them.' };
	},

	generate: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		getSession(eventId, sessionId);
		const max = currentRuleVersion(eventId).settings.maxRoundsPerSession;
		const rounds = Number(f.get('rounds'));
		if (!Number.isInteger(rounds) || rounds < 1 || rounds > max) return fail(400, { error: `Rounds must be between 1 and ${max}.` });
		// Each pool may play fewer rounds than the session (for example 1A–3A 6 of the morning's 8).
		const poolRounds: Record<number, number | null> = {};
		for (const [k, v] of f.entries()) {
			if (!k.startsWith('poolRounds_')) continue;
			const n = String(v).trim() === '' ? null : Number(v);
			if (n !== null && (!Number.isInteger(n) || n < 1 || n > rounds)) return fail(400, { error: `A pool's rounds must be between 1 and ${rounds}.` });
			poolRounds[Number(k.slice('poolRounds_'.length))] = n;
		}
		if (startedMatchIds(sessionId).size === 0) savePoolRounds(sessionId, rounds, poolRounds);
		const res = generateDraft(eventId, sessionId, {
			rounds,
			onlyArrived: f.get('onlyArrived') === 'on',
			fillByesWithNonCounters: f.get('fillByes') === 'on'
		});
		if (!res.ok) return fail(400, { error: res.error });
		audit(`user:${user.id}`, 'schedule_generated', { sessionId, rounds, games: res.matches }, eventId);
		return { generated: true, warnings: res.warnings };
	},

	saveMatch: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		getSession(eventId, sessionId);
		const matchId = Number(f.get('matchId')) || null;
		const roundNo = Number(f.get('roundNo'));
		const roomId = Number(f.get('roomId'));
		const teamA = Number(f.get('teamA'));
		const teamB = Number(f.get('teamB'));
		const counts = f.get('counts') === 'on';
		if (!teamA || !teamB || teamA === teamB) return fail(400, { error: 'Choose two different teams.' });
		const s = loadSchedule(eventId, sessionId);
		if (matchId && s.matches.find((m) => m.id === matchId)?.locked) return fail(400, { error: 'This game has already been scored and cannot be changed here.' });
		const next: SchedMatch[] = [...s.matches.filter((m) => m.id !== matchId), { id: matchId ?? -1, roundNo, roomId, teamA, teamB, counts }];
		const errs = editErrors(eventId, sessionId, next);
		if (errs.length) return fail(400, { error: errs.join(' ') });
		const ta = s.teams.find((t) => t.id === teamA)!;
		const tb = s.teams.find((t) => t.id === teamB)!;
		const values = { sessionId, roundNo, roomId, teamAId: teamA, teamBId: teamB, counts, poolId: counts ? poolIdForTeams(sessionId, ta, tb) : null };
		const db = getDb();
		if (matchId) db.update(schema.matches).set(values).where(and(eq(schema.matches.id, matchId), eq(schema.matches.sessionId, sessionId))).run();
		else db.insert(schema.matches).values(values).run();
		db.update(schema.sessions).set({ scheduleStatus: 'draft' }).where(eq(schema.sessions.id, sessionId)).run();
		audit(`user:${user.id}`, matchId ? 'match_edited' : 'match_added', { matchId, ...values }, eventId);
		return { message: 'Game saved. The schedule is back in draft until you publish it again.' };
	},

	deleteMatch: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		const matchId = Number(f.get('matchId'));
		getSession(eventId, sessionId);
		if (startedMatchIds(sessionId).has(matchId)) return fail(400, { error: 'This game has already been scored and cannot be deleted.' });
		const db = getDb();
		const m = db.select().from(schema.matches).where(and(eq(schema.matches.id, matchId), eq(schema.matches.sessionId, sessionId))).get();
		if (!m) return fail(404, { error: 'Game not found.' });
		db.delete(schema.matches).where(eq(schema.matches.id, matchId)).run();
		db.update(schema.sessions).set({ scheduleStatus: 'draft' }).where(eq(schema.sessions.id, sessionId)).run();
		audit(`user:${user.id}`, 'match_deleted', { sessionId, match: m }, eventId);
		return { message: 'Game removed.' };
	},

	/** Move a game to another round/room; swaps with the game already there. */
	move: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		const matchId = Number(f.get('matchId'));
		const roundNo = Number(f.get('roundNo'));
		const roomId = Number(f.get('roomId'));
		const s = loadSchedule(eventId, sessionId);
		const m = s.matches.find((x) => x.id === matchId);
		if (!m) return fail(404, { error: 'Game not found.' });
		const other = s.matches.find((x) => x.roundNo === roundNo && x.roomId === roomId && x.id !== matchId);
		if (m.locked || other?.locked) return fail(400, { error: 'Games that have been scored cannot be moved.' });
		const next = s.matches.map((x) =>
			x.id === matchId ? { ...x, roundNo, roomId } : other && x.id === other.id ? { ...x, roundNo: m.roundNo, roomId: m.roomId } : x
		);
		const errs = editErrors(eventId, sessionId, next);
		if (errs.length) return fail(400, { error: `Can't move there: ${errs.join(' ')}` });
		const db = getDb();
		db.transaction((tx) => {
			tx.update(schema.matches).set({ roundNo, roomId }).where(eq(schema.matches.id, matchId)).run();
			if (other) tx.update(schema.matches).set({ roundNo: m.roundNo, roomId: m.roomId }).where(eq(schema.matches.id, other.id!)).run();
			tx.update(schema.sessions).set({ scheduleStatus: 'draft' }).where(eq(schema.sessions.id, sessionId)).run();
		});
		audit(`user:${user.id}`, 'match_moved', { sessionId, matchId, to: { roundNo, roomId }, swappedWith: other?.id ?? null }, eventId);
		return { message: other ? 'Games swapped.' : 'Game moved.' };
	},

	publish: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		const publish = f.get('publish') === '1';
		const s = loadSchedule(eventId, sessionId);
		if (publish) {
			const errs = validateSchedule({ teams: s.teams, rooms: s.rooms, roundCount: s.session.roundCount, matches: s.matches }).filter((i) => i.level === 'error');
			if (errs.length) return fail(400, { error: 'Fix the errors before publishing.' });
			if (!s.matches.length) return fail(400, { error: 'There are no games to publish.' });
		}
		getDb()
			.update(schema.sessions)
			.set({ scheduleStatus: publish ? 'published' : 'draft', schedulePublishedAt: publish ? new Date().toISOString() : null })
			.where(eq(schema.sessions.id, sessionId))
			.run();
		audit(`user:${user.id}`, publish ? 'schedule_published' : 'schedule_unlocked', { sessionId }, eventId);
		return { message: publish ? 'Schedule published and locked. Room scorers will see these games.' : 'Schedule unlocked for editing.' };
	}
};
