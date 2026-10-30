/**
 * Pool play → bracket, end to end through the server: draft generation plans the bracket,
 * bracket games appear by themselves as results come in, and the final places come from the bracket.
 */
import { DEFAULT_BRACKET_FORMAT, HIGH_SCHOOL_DEFAULTS, type EventBody, type Side } from '$lib/engine';
import { advanceBrackets } from '$lib/server/bracket';
import { getDb, schema, useMemoryDb } from '$lib/server/db';
import { createEvent, listRooms, listSessions } from '$lib/server/events';
import { ingestEvents, ROOM_TYPES, STAFF_TYPES } from '$lib/server/ingest';
import { computeLive } from '$lib/server/live';
import { generateDraft, loadSchedule } from '$lib/server/schedule';
import { addPlayerToTeam, createTeam } from '$lib/server/teams';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

let eventId: number;
let sessionId: number;
const team: Record<string, number> = {};
const players: Record<string, string[]> = {};

function setup(fmt = DEFAULT_BRACKET_FORMAT) {
	process.env.DISABLE_BACKUPS = '1';
	useMemoryDb();
	const settings = structuredClone(HIGH_SCHOOL_DEFAULTS);
	settings.format.divisions['Public 4A–7A'] = fmt;
	eventId = createEvent(
		{
			name: 'Bracket QA',
			eventDate: '2026-10-28',
			isTest: true,
			classifications: ['4A', '5A', '6A', '7A'],
			sessions: [{ name: 'Afternoon', date: '2026-10-28', startTime: '12:15', classifications: ['4A', '5A', '6A', '7A'], roundCount: 5, roundTimes: [] }],
			roomNames: ['Room 214', 'Room 215'],
			settings,
			settingsSource: 'QA'
		},
		'QA'
	);
	sessionId = listSessions(eventId)[0].id;
	for (const r of listRooms(eventId)) getDb().update(schema.rooms).set({ activeDeviceId: `dev-${r.id}` }).where(eq(schema.rooms.id, r.id)).run();
	const db = getDb();
	// One pool for the whole division so everyone plays everyone.
	db.insert(schema.pools).values({ sessionId, name: 'Public 4A–7A', classifications: ['4A', '5A', '6A', '7A'] }).run();
	db.transaction((tx) => {
		for (const [n, c] of [['Ox', '5A'], ['Va', '5A'], ['Sy', '4A'], ['Au', '6A']] as const) {
			team[n] = createTeam(tx, eventId, { name: n, classification: c, sessionId, source: 'manual' });
			players[n] = [1, 2, 3, 4].map((i) => addPlayerToTeam(tx, team[n], { firstName: `${n}${i}`, lastName: 'QA' }));
		}
	});
}

const seq = new Map<number, number>();
function send(m: { id: number; roomId: number }, body: EventBody) {
	const n = (seq.get(m.id) ?? 0) + 1;
	seq.set(m.id, n);
	return ingestEvents({ eventId, roomId: m.roomId, deviceId: `dev-${m.roomId}`, actor: `room:${m.roomId}`, actorName: 'room', source: 'live', allowed: ROOM_TYPES, enforceLease: true, lockSubmitted: true }, [
		{ id: crypto.randomUUID(), matchId: m.id, deviceSeq: n, body }
	])[0];
}
const approve = (id: number) => ingestEvents({ eventId, roomId: null, deviceId: null, actor: 'user:1', actorName: 'QA', source: 'staff', allowed: STAFF_TYPES, enforceLease: false, lockSubmitted: false }, [{ id: crypto.randomUUID(), matchId: id, body: { type: 'approved' } }]);

/** Play a game to `want` (team name → tossups won, 10 points each, no bonuses) and approve it. */
function score(want: Record<string, number>) {
	const names = Object.keys(want);
	const m = getDb().select().from(schema.matches).all().find((x) => [x.teamAId, x.teamBId].sort().join() === names.map((n) => team[n]).sort().join() && !done.has(x.id));
	if (!m) throw new Error(`no game for ${names.join(' v ')}`);
	done.add(m.id);
	const nameOf = (id: number) => names.find((n) => team[n] === id)!;
	const lineups: Record<Side, string[]> = { A: players[nameOf(m.teamAId)], B: players[nameOf(m.teamBId)] };
	send(m, { type: 'round_started', lineups });
	let t = 0;
	for (const side of ['A', 'B'] as const) for (let i = 0; i < want[nameOf(side === 'A' ? m.teamAId : m.teamBId)]; i++) send(m, { type: 'tossup_answer', tossup: ++t, side, playerId: lineups[side][0], correct: true });
	send(m, { type: 'round_ended', reason: 'Time called' });
	const pts = (id: number) => want[nameOf(id)] * 1000;
	send(m, { type: 'submitted', scoreA: pts(m.teamAId), scoreB: pts(m.teamBId) });
	approve(m.id);
	return m;
}
const done = new Set<number>();

describe('pool play then a bracket (the 2026 afternoon shape)', () => {
	beforeEach(() => {
		done.clear();
		seq.clear();
		setup();
	});

	it('plans 3 pool-play rounds and the bracket, then creates each bracket game as results arrive', () => {
		const res = generateDraft(eventId, sessionId, { rounds: 5, onlyArrived: false, fillByesWithNonCounters: false });
		expect(res.ok).toBe(true);
		// generateDraft alone plans pool play only; the schedule page then plans the bracket.
		const { planBrackets } = awaitImport();
		planBrackets(eventId, sessionId, 'user:1');
		const s = loadSchedule(eventId, sessionId);
		expect(s.matches.map((m) => m.roundNo).sort()).toEqual([1, 1, 2, 2, 3, 3]);
		expect(s.slots.map((x) => [x.slot, x.roundNo, x.sourceA, x.sourceB, !!x.roomId])).toEqual([
			['SF1', 4, 'seed:1', 'seed:4', true],
			['SF2', 4, 'seed:2', 'seed:3', true],
			['F', 5, 'winner:SF1', 'winner:SF2', true],
			['3P', 5, 'loser:SF1', 'loser:SF2', true]
		]);

		// Pool play: Au 3–0, Sy 2–1, Ox 1–2, Va 0–3.
		score({ Ox: 14, Va: 4 });
		score({ Au: 11, Sy: 6 });
		score({ Ox: 6, Sy: 9 });
		expect(advanceBrackets(eventId, 'test').created).toEqual([]); // pool play not finished
		score({ Au: 20, Va: 1 });
		score({ Va: 5, Sy: 6 });
		score({ Au: 10, Ox: 9 });
		const a1 = advanceBrackets(eventId, 'test');
		expect(a1.created).toEqual(['Public 4A–7A Semifinal 1: Au v Va (round 4)', 'Public 4A–7A Semifinal 2: Sy v Ox (round 4)']);

		score({ Au: 12, Va: 4 });
		score({ Sy: 6, Ox: 13 });
		const a2 = advanceBrackets(eventId, 'test');
		expect(a2.created).toEqual(['Public 4A–7A Championship: Au v Ox (round 5)', 'Public 4A–7A 3rd-place game: Va v Sy (round 5)']);

		score({ Au: 7, Ox: 8 });
		score({ Va: 1, Sy: 4 });
		const live = computeLive(eventId);
		const d = live.final.divisions[0];
		const name = (id: string) => live.teams.find((t) => t.id === id)!.name;
		expect(d.rows.map((r) => [name(r.teamId), r.place, r.bracketResult])).toEqual([
			['Ox', 1, 'Champion'],
			['Au', 2, 'Runner-up'],
			['Sy', 3, 'Won 3rd-place game'],
			['Va', 4, 'Lost 3rd-place game']
		]);
		expect(live.classAwards.final.find((c) => c.classification === '5A')!.rows.map((r) => [name(r.teamId), r.place])).toEqual([['Ox', 1], ['Va', 2]]);
		expect(live.flags.filter((f) => f.level === 'error')).toEqual([]);
	});

	it('a correction that changes the seeds re-pairs a semifinal that has not started', () => {
		generateDraft(eventId, sessionId, { rounds: 5, onlyArrived: false, fillByesWithNonCounters: false });
		awaitImport().planBrackets(eventId, sessionId, 'user:1');
		score({ Ox: 14, Va: 4 });
		score({ Au: 11, Sy: 6 });
		score({ Ox: 6, Sy: 9 });
		const m = score({ Au: 20, Va: 1 });
		score({ Va: 5, Sy: 6 });
		score({ Au: 10, Ox: 9 });
		expect(advanceBrackets(eventId, 'test').created).toHaveLength(2); // SF1 Au v Va, SF2 Sy v Ox
		// The head scorekeeper finds 20 Valley tossups credited to the wrong team: Valley actually won.
		// Now Au 2–1 (410), Sy 2–1 (210), Va 1–2 (300), Ox 1–2 (290): SF1 Au v Ox, SF2 Sy v Va.
		const vaSide: Side = m.teamAId === team.Va ? 'A' : 'B';
		const staffCtx = { eventId, roomId: null, deviceId: null, actor: 'user:1', actorName: 'QA', source: 'staff' as const, allowed: STAFF_TYPES, enforceLease: false, lockSubmitted: false };
		const answers = getDb().select().from(schema.scoreEvents).all().filter((e) => e.matchId === m.id && e.type === 'tossup_answer' && (e.body as { side: Side }).side !== vaSide);
		for (const e of answers)
			ingestEvents(staffCtx, [{ id: crypto.randomUUID(), matchId: m.id, body: { type: 'correction', action: 'amend', target: e.id, reason: 'wrong team clicked', replacement: { ...(e.body as Extract<EventBody, { type: 'tossup_answer' }>), side: vaSide, playerId: players.Va[0] } } }]);
		approve(m.id);
		const a = advanceBrackets(eventId, 'test');
		expect(a.updated).toEqual(['Public 4A–7A Semifinal 1: now Au v Ox', 'Public 4A–7A Semifinal 2: now Sy v Va']);
	});
});

import * as bracketModule from '$lib/server/bracket';
const awaitImport = () => bracketModule;
