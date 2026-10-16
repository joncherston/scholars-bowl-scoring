import { computeRound } from '$lib/engine';
import type { RoomState, RosterPlayer, ScorerMatch, ScorerTeam } from '$lib/scorer-types';
import { and, asc, eq, inArray, lt, or } from 'drizzle-orm';
import { getDb, schema } from './db';
import { getEvent } from './events';
import { matchEvents, rulesForMatch } from './ingest';
import { playerDisplayName, teamRoster } from './teams';

export type { RoomState, RosterPlayer, ScorerMatch, ScorerTeam };

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
	for (const m of prior) {
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
	const published = sessions.filter((s) => s.scheduleStatus === 'published').map((s) => s.id);
	const rows = published.length
		? db
				.select()
				.from(schema.matches)
				.where(and(eq(schema.matches.roomId, roomId), inArray(schema.matches.sessionId, published)))
				.all()
				.sort((a, b) => published.indexOf(a.sessionId) - published.indexOf(b.sessionId) || a.roundNo - b.roundNo)
		: [];
	return {
		room: { id: room.id, name: room.name, projectorToken: room.projectorToken },
		event: { id: event.id, name: event.name, isTest: event.isTest },
		matches: buildMatches(eventId, rows),
		serverTime: new Date().toISOString()
	};
}
