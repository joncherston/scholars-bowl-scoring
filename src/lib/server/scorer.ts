import { computeRound } from '$lib/engine';
import type { PracticeOptions, RoomState, RosterPlayer, ScorerMatch, ScorerTeam } from '$lib/scorer-types';
import { and, asc, eq, inArray, lt, or } from 'drizzle-orm';
import { getDb, schema } from './db';
import { getEvent } from './events';
import { matchEvents, rulesForMatch } from './ingest';
import { listTeams, playerDisplayName, teamRoster } from './teams';
import { practiceRoomIds } from './schedule';

export type { PracticeOptions, RoomState, RosterPlayer, ScorerMatch, ScorerTeam };

const rosterOf = (teamId: number): RosterPlayer[] =>
	teamRoster(teamId).map((p) => ({ id: p.id, name: playerDisplayName(p), firstName: p.preferredName || p.firstName, lastName: p.lastName }));

/** Lineup the team used in its most recent earlier round in this session (falls back to the first players on the roster). */
function defaultLineup(teamId: number, sessionId: number, beforeRound: number, roster: RosterPlayer[], activePlayers: number, eventId: number): string[] {
	const prior = getDb()
		.select()
		.from(schema.matches)
		.where(and(eq(schema.matches.sessionId, sessionId), lt(schema.matches.roundNo, beforeRound), or(eq(schema.matches.teamAId, teamId), eq(schema.matches.teamBId, teamId))))
		.orderBy(asc(schema.matches.roundNo))
		.all()
		.reverse();
	const onRoster = new Set(roster.map((p) => p.id));
	const practice = practiceRoomIds(eventId);
	for (const m of prior) {
		if (practice.has(m.roomId)) continue; // a practice game's lineup isn't the team's real one
		const events = matchEvents(m.id);
		if (!events.length) continue;
		const r = computeRound(events, rulesForMatch(m, eventId).settings);
		const lineup = r.lineups[m.teamAId === teamId ? 'A' : 'B'].filter((id) => onRoster.has(id));
		if (lineup.length) return lineup;
	}
	return roster.slice(0, activePlayers).map((p) => p.id);
}

/** Everything a room's scorer needs, for published schedules only. */
export function buildMatches(eventId: number, matchRows: (typeof schema.matches.$inferSelect)[]): ScorerMatch[] {
	const db = getDb();
	if (!matchRows.length) return [];
	const sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, eventId)).all();
	const teamIds = [...new Set(matchRows.flatMap((m) => [m.teamAId, m.teamBId]))];
	const teams = db.select().from(schema.teams).where(inArray(schema.teams.id, teamIds)).all();
	const rooms = db.select().from(schema.rooms).where(eq(schema.rooms.eventId, eventId)).all();
	const rosters = new Map(teamIds.map((id) => [id, rosterOf(id)]));
	return matchRows.map((m) => {
		const s = sessions.find((x) => x.id === m.sessionId)!;
		const rules = rulesForMatch(m, eventId);
		const team = (id: number): ScorerTeam => {
			const t = teams.find((x) => x.id === id)!;
			const roster = rosters.get(id) ?? [];
			return {
				id,
				name: t.name,
				classification: t.classification,
				roster,
				defaultLineup: defaultLineup(id, m.sessionId, m.roundNo, roster, rules.settings.roster.activePlayers, eventId)
			};
		};
		return {
			id: m.id,
			sessionId: m.sessionId,
			sessionName: s.name,
			roundNo: m.roundNo,
			time: s.roundTimes[m.roundNo - 1] ?? null,
			counts: m.counts,
			roomId: m.roomId,
			roomName: rooms.find((r) => r.id === m.roomId)?.name ?? '',
			teams: { A: team(m.teamAId), B: team(m.teamBId) },
			rules: rules.settings,
			ruleVersion: rules.version,
			events: matchEvents(m.id)
		};
	});
}

export function buildRoomState(eventId: number, roomId: number): RoomState {
	const db = getDb();
	const event = getEvent(eventId);
	const room = db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId)).get()!;
	const sessions = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, eventId)).orderBy(asc(schema.sessions.sortOrder)).all();
	// A practice room sees its own practice games in any session; other rooms only published schedules.
	const visible = room.practice ? sessions.map((s) => s.id) : sessions.filter((s) => s.scheduleStatus === 'published').map((s) => s.id);
	const rows = visible.length
		? db
				.select()
				.from(schema.matches)
				.where(and(eq(schema.matches.roomId, roomId), inArray(schema.matches.sessionId, visible)))
				.all()
				.sort((a, b) => visible.indexOf(a.sessionId) - visible.indexOf(b.sessionId) || a.roundNo - b.roundNo || a.id - b.id)
		: [];
	return {
		room: { id: room.id, name: room.name, projectorToken: room.projectorToken, practice: room.practice },
		practice: room.practice ? practiceOptions(eventId) : undefined,
		event: { id: event.id, name: event.name, isTest: event.isTest },
		matches: buildMatches(eventId, rows),
		serverTime: new Date().toISOString()
	};
}

function practiceOptions(eventId: number): PracticeOptions {
	const db = getDb();
	const sessions = db.select({ id: schema.sessions.id, name: schema.sessions.name }).from(schema.sessions).where(eq(schema.sessions.eventId, eventId)).orderBy(asc(schema.sessions.sortOrder)).all();
	const teams = listTeams(eventId)
		.filter((t) => t.sessionId && !t.withdrawn)
		.map((t) => ({ id: t.id, name: t.name, sessionId: t.sessionId! }))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { sessions, teams };
}

/** Most practice games one practice room can hold in an event (a guard against runaway clicks). */
export const PRACTICE_GAME_LIMIT = 40;

/** Start a practice game in a practice room. Never counts: it lives in a practice room and is marked non-counting. */
export function startPracticeGame(eventId: number, roomId: number, input: { sessionId: number; teamA: number; teamB: number }): { ok: true; matchId: number } | { ok: false; error: string } {
	const db = getDb();
	const room = db.select().from(schema.rooms).where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.eventId, eventId))).get();
	if (!room || !room.active) return { ok: false, error: 'Room not found.' };
	if (!room.practice) return { ok: false, error: 'Only practice rooms can start their own games.' };
	const session = db.select().from(schema.sessions).where(and(eq(schema.sessions.id, input.sessionId), eq(schema.sessions.eventId, eventId))).get();
	if (!session) return { ok: false, error: 'Choose a session.' };
	if (!input.teamA || !input.teamB || input.teamA === input.teamB) return { ok: false, error: 'Choose two different teams.' };
	const teams = listTeams(eventId).filter((t) => t.sessionId === session.id && !t.withdrawn);
	if (!teams.some((t) => t.id === input.teamA) || !teams.some((t) => t.id === input.teamB)) return { ok: false, error: 'Both teams must be in that session.' };
	const already = db.select({ id: schema.matches.id }).from(schema.matches).where(eq(schema.matches.roomId, room.id)).all().length;
	if (already >= PRACTICE_GAME_LIMIT) return { ok: false, error: 'This practice room has reached its limit of practice games. Ask the head scorekeeper to clear old ones.' };
	const inSession = db.select({ id: schema.matches.id }).from(schema.matches).where(and(eq(schema.matches.roomId, room.id), eq(schema.matches.sessionId, session.id))).all().length;
	const [m] = db
		.insert(schema.matches)
		.values({ sessionId: session.id, roundNo: inSession + 1, roomId: room.id, teamAId: input.teamA, teamBId: input.teamB, counts: false, poolId: null, stage: 'pool' })
		.returning()
		.all();
	return { ok: true, matchId: m.id };
}
