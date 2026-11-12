/**
 * Practice (bye) rooms: the schedule and brackets leave them out, and nothing scored there
 * reaches standings, individual totals, awards or results.
 */
import { HIGH_SCHOOL_DEFAULTS, type EventBody, type Side } from '$lib/engine';
import { getDb, schema, useMemoryDb } from '$lib/server/db';
import { createEvent, listRooms, listSessions } from '$lib/server/events';
import { ingestEvents, ROOM_TYPES } from '$lib/server/ingest';
import { computeLive } from '$lib/server/live';
import { generateDraft, loadSchedule, startedMatchIds } from '$lib/server/schedule';
import { buildRoomState, startPracticeGame } from '$lib/server/scorer';
import { addPlayerToTeam, createTeam } from '$lib/server/teams';
import { sessionMatchIds } from '$lib/server/reports';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

let eventId: number;
let sessionId: number;
let practiceRoom: number;
let realRoom: number;
const team: Record<string, number> = {};
const players: Record<string, string[]> = {};

beforeEach(() => {
	process.env.DISABLE_BACKUPS = '1';
	useMemoryDb();
	eventId = createEvent(
		{
			name: 'Practice QA',
			eventDate: '2026-10-28',
			isTest: true,
			classifications: ['1A'],
			sessions: [{ name: 'Morning', date: '2026-10-28', startTime: '08:30', classifications: ['1A'], roundCount: 3, roundTimes: [] }],
			roomNames: ['Room 214', 'Room 215', 'Bye room'],
			practiceRoomNames: ['Bye room'],
			settings: structuredClone(HIGH_SCHOOL_DEFAULTS),
			settingsSource: 'QA'
		},
		'QA'
	);
	sessionId = listSessions(eventId)[0].id;
	const rooms = listRooms(eventId);
	practiceRoom = rooms.find((r) => r.practice)!.id;
	realRoom = rooms.find((r) => !r.practice)!.id;
	for (const r of rooms) getDb().update(schema.rooms).set({ activeDeviceId: `dev-${r.id}` }).where(eq(schema.rooms.id, r.id)).run();
	getDb().transaction((tx) => {
		for (const n of ['Ox', 'Va', 'Sy', 'Au']) {
			team[n] = createTeam(tx, eventId, { name: n, classification: '1A', sessionId, source: 'manual' });
			players[n] = [1, 2, 3, 4].map((i) => addPlayerToTeam(tx, team[n], { firstName: `${n}${i}`, lastName: 'QA' }));
		}
	});
});

let seqNo = 0;
function send(m: { id: number; roomId: number }, body: EventBody) {
	return ingestEvents({ eventId, roomId: m.roomId, deviceId: `dev-${m.roomId}`, actor: `room:${m.roomId}`, actorName: 'room', source: 'live', allowed: ROOM_TYPES, enforceLease: true, lockSubmitted: true }, [
		{ id: crypto.randomUUID(), matchId: m.id, deviceSeq: ++seqNo, body }
	])[0];
}
/** Score a game: side A answers `tossups` tossups (10 each) with its first player, then submit. */
function play(m: { id: number; roomId: number; teamAId: number; teamBId: number }, a: string, b: string, tossups: number) {
	const lineups: Record<Side, string[]> = { A: players[a], B: players[b] };
	send(m, { type: 'round_started', lineups });
	for (let t = 1; t <= tossups; t++) send(m, { type: 'tossup_answer', tossup: t, side: 'A', playerId: lineups.A[0], correct: true });
	send(m, { type: 'round_ended', reason: 'Time called' });
	return send(m, { type: 'submitted', scoreA: tossups * 1000, scoreB: 0 });
}

describe('practice rooms', () => {
	it('are left out of the generated schedule', () => {
		const res = generateDraft(eventId, sessionId, { rounds: 3, fillByesWithNonCounters: false, onlyArrived: false });
		expect(res.ok).toBe(true);
		const s = loadSchedule(eventId, sessionId);
		expect(s.rooms.map((r) => r.id)).not.toContain(practiceRoom);
		expect(s.matches.length).toBeGreaterThan(0);
		expect(s.matches.every((m) => m.roomId !== practiceRoom)).toBe(true);
		expect(s.practiceRooms.map((r) => r.id)).toEqual([practiceRoom]);
	});

	it('only practice rooms can start their own games', () => {
		expect(startPracticeGame(eventId, realRoom, { sessionId, teamA: team.Ox, teamB: team.Va })).toMatchObject({ ok: false });
		expect(startPracticeGame(eventId, practiceRoom, { sessionId, teamA: team.Ox, teamB: team.Ox })).toMatchObject({ ok: false });
		expect(startPracticeGame(eventId, practiceRoom, { sessionId, teamA: team.Ox, teamB: team.Va })).toMatchObject({ ok: true });
	});

	it('never roll up, and practice scoring does not lock the real schedule', () => {
		generateDraft(eventId, sessionId, { rounds: 3, fillByesWithNonCounters: false, onlyArrived: false });
		const res = startPracticeGame(eventId, practiceRoom, { sessionId, teamA: team.Ox, teamB: team.Va });
		if (!res.ok) throw new Error(res.error);
		const pm = getDb().select().from(schema.matches).where(eq(schema.matches.id, res.matchId)).get()!;
		expect(pm.counts).toBe(false);
		expect(play(pm, 'Ox', 'Va', 20).status).toBe('accepted');

		// The practice room's computer sees the game though the schedule isn't published; real rooms don't.
		expect(buildRoomState(eventId, practiceRoom).matches.map((m) => m.id)).toEqual([pm.id]);
		expect(buildRoomState(eventId, practiceRoom).room.practice).toBe(true);
		expect(buildRoomState(eventId, practiceRoom).practice?.teams.length).toBe(4);
		expect(buildRoomState(eventId, realRoom).matches).toEqual([]);

		// Nothing from it in standings, individuals, reports.
		const live = computeLive(eventId);
		expect(live.matches.some((m) => m.id === pm.id)).toBe(false);
		expect(live.provisional.records[String(team.Ox)]?.played ?? 0).toBe(0);
		expect(live.provisional.individuals.flatMap((g) => g.rows).some((r) => r.total > 0)).toBe(false);
		expect(sessionMatchIds(eventId, sessionId)).not.toContain(pm.id);

		// Scoring practice doesn't lock the schedule: it can still be regenerated, and the practice game stays.
		expect(startedMatchIds(sessionId).size).toBe(0);
		expect(generateDraft(eventId, sessionId, { rounds: 3, fillByesWithNonCounters: false, onlyArrived: false }).ok).toBe(true);
		expect(getDb().select().from(schema.matches).where(eq(schema.matches.id, pm.id)).get()).toBeTruthy();
		expect(loadSchedule(eventId, sessionId).practiceMatches.map((m) => m.id)).toEqual([pm.id]);
	});

	it('real games still count normally beside practice games', () => {
		generateDraft(eventId, sessionId, { rounds: 3, fillByesWithNonCounters: false, onlyArrived: false });
		const res = startPracticeGame(eventId, practiceRoom, { sessionId, teamA: team.Sy, teamB: team.Au });
		if (!res.ok) throw new Error(res.error);
		const pm = getDb().select().from(schema.matches).where(eq(schema.matches.id, res.matchId)).get()!;
		play(pm, 'Sy', 'Au', 25);
		const real = loadSchedule(eventId, sessionId).matches[0];
		const row = getDb().select().from(schema.matches).where(eq(schema.matches.id, real.id!)).get()!;
		const name = (id: number) => Object.keys(team).find((n) => team[n] === id)!;
		play(row, name(row.teamAId), name(row.teamBId), 7);
		const live = computeLive(eventId);
		const indiv = live.provisional.individuals.flatMap((g) => g.rows).filter((r) => r.total > 0);
		expect(indiv).toHaveLength(1);
		expect(indiv[0].total).toBe(7000);
		expect(live.provisional.records[String(row.teamAId)].wins).toBe(1);
	});
});
