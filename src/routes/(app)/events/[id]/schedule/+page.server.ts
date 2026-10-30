import { validateSchedule, byesByRound, type SchedMatch } from '$lib/schedule';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { currentRuleVersion, eventIdParam, listSessions } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { advanceBrackets, pinSlotTeams, planBrackets } from '$lib/server/bracket';
import { generateDraft, getSession, loadSchedule, poolIdForTeams, practiceRoomIds, savePoolRounds, savePools, saveTeamPools, startedMatchIds } from '$lib/server/schedule';
import { startPracticeGame } from '$lib/server/scorer';
import { fail } from '@sveltejs/kit';
import { and, eq, inArray } from 'drizzle-orm';

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

const PRACTICE_ROOM_ERROR = 'That is a practice room: games there never count. Pick a regular room, or add a practice game in the Practice rooms section.';

/** True when a game or a target room sits on the practice side, which ordinary edits may not cross. */
function crossesPractice(eventId: number, roomIds: (number | null | undefined)[], matchIds: (number | null | undefined)[] = []) {
	const practice = practiceRoomIds(eventId);
	if (roomIds.some((r) => r && practice.has(r))) return true;
	const ids = matchIds.filter((x): x is number => !!x);
	if (!ids.length) return false;
	const rows = getDb().select({ roomId: schema.matches.roomId }).from(schema.matches).where(inArray(schema.matches.id, ids)).all();
	return rows.some((r) => practice.has(r.roomId));
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
		const bracketWarnings = planBrackets(eventId, sessionId, `user:${user.id}`);
		audit(`user:${user.id}`, 'schedule_generated', { sessionId, rounds, games: res.matches }, eventId);
		return { generated: true, warnings: [...res.warnings, ...bracketWarnings] };
	},

	/** Split a classification into pools by team (e.g. Private Pools A, B, C). */
	teamPools: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		getSession(eventId, sessionId);
		if (startedMatchIds(sessionId).size) return fail(400, { error: 'Scoring has started; pools can no longer change.' });
		const assignment: Record<number, string> = {};
		for (const [k, v] of f.entries()) if (k.startsWith('teamPool_')) assignment[Number(k.slice(9))] = String(v).slice(0, 40);
		saveTeamPools(sessionId, assignment);
		audit(`user:${user.id}`, 'team_pools_saved', { sessionId, assignment }, eventId);
		return { message: 'Team pools saved. Generate a new draft to use them.' };
	},

	/** Re-plan the bracket games (rooms and rounds) without touching pool play. */
	planBracket: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const sessionId = Number((await request.formData()).get('sessionId'));
		getSession(eventId, sessionId);
		const warnings = planBrackets(eventId, sessionId, `user:${user.id}`);
		const adv = advanceBrackets(eventId, `user:${user.id}`, { sessionId });
		return { message: `Bracket planned.${adv.created.length ? ` Created: ${adv.created.join('; ')}.` : ''}`, warnings: [...warnings, ...adv.problems] };
	},

	/** Change a planned bracket game's round or room. */
	saveSlot: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		getSession(eventId, sessionId);
		const slotId = Number(f.get('slotId'));
		const roomId = Number(f.get('roomId')) || null;
		const roundNo = Number(f.get('roundNo'));
		const db = getDb();
		const slot = db.select().from(schema.bracketSlots).where(and(eq(schema.bracketSlots.id, slotId), eq(schema.bracketSlots.sessionId, sessionId))).get();
		if (!slot) return fail(404, { error: 'Bracket game not found.' });
		if (!Number.isInteger(roundNo) || roundNo < 1) return fail(400, { error: 'Choose a round.' });
		if (crossesPractice(eventId, [roomId])) return fail(400, { error: PRACTICE_ROOM_ERROR });
		if (slot.matchId) {
			if (startedMatchIds(sessionId).has(slot.matchId)) return fail(400, { error: 'That game has started; it can no longer move.' });
			const s = loadSchedule(eventId, sessionId);
			const next = s.matches.map((m) => (m.id === slot.matchId ? { ...m, roundNo, roomId: roomId ?? m.roomId } : m));
			const errs = editErrors(eventId, sessionId, next);
			if (errs.length) return fail(400, { error: errs.join(' ') });
			db.update(schema.matches).set({ roundNo, ...(roomId ? { roomId } : {}) }).where(eq(schema.matches.id, slot.matchId)).run();
		}
		db.update(schema.bracketSlots).set({ roundNo, roomId }).where(eq(schema.bracketSlots.id, slotId)).run();
		audit(`user:${user.id}`, 'bracket_slot_moved', { slotId, roundNo, roomId }, eventId);
		return { message: 'Bracket game moved.' };
	},

	/** Create bracket games now from the current standings, even if some pool games are unfinished. */
	seedNow: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params, false);
		const sessionId = Number((await request.formData()).get('sessionId'));
		getSession(eventId, sessionId);
		const adv = advanceBrackets(eventId, `user:${user.id}`, { sessionId, force: true });
		audit(`user:${user.id}`, 'bracket_seeded_manually', { sessionId, ...adv }, eventId);
		return { message: adv.created.length ? `Created: ${adv.created.join('; ')}.` : 'No bracket games could be created yet.', warnings: [...adv.waiting, ...adv.problems] };
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
		if (crossesPractice(eventId, [roomId], [matchId])) return fail(400, { error: PRACTICE_ROOM_ERROR });
		const s = loadSchedule(eventId, sessionId);
		if (matchId && s.matches.find((m) => m.id === matchId)?.locked) return fail(400, { error: 'This game has already been scored and cannot be changed here.' });
		const next: SchedMatch[] = [...s.matches.filter((m) => m.id !== matchId), { id: matchId ?? -1, roundNo, roomId, teamA, teamB, counts }];
		const errs = editErrors(eventId, sessionId, next);
		if (errs.length) return fail(400, { error: errs.join(' ') });
		const ta = s.teams.find((t) => t.id === teamA)!;
		const tb = s.teams.find((t) => t.id === teamB)!;
		const db = getDb();
		const before = matchId ? db.select().from(schema.matches).where(and(eq(schema.matches.id, matchId), eq(schema.matches.sessionId, sessionId))).get() : undefined;
		// A bracket game keeps its stage; a pool game's pool follows its teams.
		const values = { sessionId, roundNo, roomId, teamAId: teamA, teamBId: teamB, counts, poolId: counts && before?.stage !== 'bracket' ? poolIdForTeams(sessionId, ta, tb) : null };
		if (before?.stage === 'bracket' && (before.teamAId !== teamA || before.teamBId !== teamB)) pinSlotTeams(before.id, teamA, teamB);
		if (matchId) db.update(schema.matches).set(values).where(and(eq(schema.matches.id, matchId), eq(schema.matches.sessionId, sessionId))).run();
		else db.insert(schema.matches).values(values).run();
		db.update(schema.sessions).set({ scheduleStatus: 'draft' }).where(eq(schema.sessions.id, sessionId)).run();
		audit(`user:${user.id}`, matchId ? 'match_edited' : 'match_added', { matchId, ...values }, eventId);
		return { message: 'Game saved. The schedule is back in draft until you publish it again.' };
	},

	deleteMatch: async ({ request, locals, params }) => {
		// Head scorekeepers may clear practice games; other games need schedule-edit rights (checked below).
		const { eventId, user } = ctx(locals, params, false);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		const matchId = Number(f.get('matchId'));
		getSession(eventId, sessionId);
		const db = getDb();
		const m = db.select().from(schema.matches).where(and(eq(schema.matches.id, matchId), eq(schema.matches.sessionId, sessionId))).get();
		if (!m) return fail(404, { error: 'Game not found.' });
		// A practice game can go even after it was scored: none of it counts.
		if (practiceRoomIds(eventId).has(m.roomId)) {
			const scored = startedMatchIds(sessionId, { includePractice: true }).has(matchId);
			db.transaction((tx) => {
				tx.delete(schema.scoreEvents).where(eq(schema.scoreEvents.matchId, matchId)).run();
				tx.delete(schema.rejectedEvents).where(eq(schema.rejectedEvents.matchId, matchId)).run();
				tx.delete(schema.matches).where(eq(schema.matches.id, matchId)).run();
			});
			audit(`user:${user.id}`, 'practice_game_deleted', { sessionId, match: m, scored }, eventId);
			return { message: 'Practice game removed.' };
		}
		ctx(locals, params);
		if (startedMatchIds(sessionId).has(matchId)) return fail(400, { error: 'This game has already been scored and cannot be deleted.' });
		// A bracket game removed by hand is not re-created by the bracket (its slot goes too).
		const slot = db.select().from(schema.bracketSlots).where(eq(schema.bracketSlots.matchId, matchId)).get();
		db.transaction((tx) => {
			if (slot) tx.delete(schema.bracketSlots).where(eq(schema.bracketSlots.id, slot.id)).run();
			tx.delete(schema.matches).where(eq(schema.matches.id, matchId)).run();
			tx.update(schema.sessions).set({ scheduleStatus: 'draft' }).where(eq(schema.sessions.id, sessionId)).run();
		});
		audit(`user:${user.id}`, 'match_deleted', { sessionId, match: m, bracketSlot: slot ?? null }, eventId);
		return { message: 'Game removed.' };
	},

	/** Add a practice game to a practice room (never counts; the room's scorer can also start one). */
	addPractice: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params, false);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		getSession(eventId, sessionId);
		const roomId = Number(f.get('roomId'));
		const res = startPracticeGame(eventId, roomId, { sessionId, teamA: Number(f.get('teamA')), teamB: Number(f.get('teamB')) });
		if (!res.ok) return fail(400, { error: res.error });
		audit(`user:${user.id}`, 'practice_game_added', { sessionId, roomId, matchId: res.matchId }, eventId);
		return { message: 'Practice game added. The practice room sees it right away; it never counts.' };
	},

	/** Move a game to another round/room; swaps with the game already there. */
	move: async ({ request, locals, params }) => {
		const { eventId, user } = ctx(locals, params);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		const matchId = Number(f.get('matchId'));
		const roundNo = Number(f.get('roundNo'));
		const roomId = Number(f.get('roomId'));
		if (crossesPractice(eventId, [roomId], [matchId])) return fail(400, { error: PRACTICE_ROOM_ERROR });
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
