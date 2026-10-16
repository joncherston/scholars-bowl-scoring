import { computeRound, type EventBody } from '$lib/engine';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, schema, useMemoryDb } from './db';
import { currentRuleVersion, saveRules } from './events';
import { deviceGaps, ingestEvents, matchEvents, ROOM_TYPES, rulesForMatch, STAFF_TYPES, type IngestContext } from './ingest';
import { createPracticeEvent } from './practice';

let eventId: number;
let match: typeof schema.matches.$inferSelect;
let roomCtx: IngestContext;

const uuid = () => crypto.randomUUID();
const ev = (body: EventBody, deviceSeq?: number) => ({ id: uuid(), matchId: match.id, deviceSeq, body });

beforeEach(() => {
	process.env.DISABLE_BACKUPS = '1';
	useMemoryDb();
	eventId = createPracticeEvent('test', { date: '2026-10-28' });
	match = getDb().select().from(schema.matches).limit(1).get()!;
	getDb().update(schema.rooms).set({ activeDeviceId: 'dev-1' }).where(eq(schema.rooms.id, match.roomId)).run();
	roomCtx = {
		eventId,
		roomId: match.roomId,
		deviceId: 'dev-1',
		actor: `room:${match.roomId}`,
		actorName: 'Room 1',
		source: 'live',
		allowed: ROOM_TYPES,
		enforceLease: true,
		lockSubmitted: true
	};
});

describe('ingestEvents', () => {
	it('appends in order and ignores duplicate IDs (idempotent)', () => {
		const a = ev({ type: 'round_started', lineups: { A: [], B: [] } }, 1);
		const b = ev({ type: 'tossup_answer', tossup: 1, side: 'A', playerId: null, correct: true }, 2);
		expect(ingestEvents(roomCtx, [a, b]).map((r) => [r.status, r.seq])).toEqual([
			['accepted', 1],
			['accepted', 2]
		]);
		expect(ingestEvents(roomCtx, [a, b]).map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
		expect(matchEvents(match.id)).toHaveLength(2);
	});

	it('snapshots the settings version when scoring starts', () => {
		const v1 = currentRuleVersion(eventId);
		ingestEvents(roomCtx, [ev({ type: 'round_started', lineups: { A: [], B: [] } }, 1)]);
		const s = structuredClone(v1.settings);
		s.tossupPoints = 2000;
		saveRules(eventId, s, 'test', 'double tossups');
		const m = getDb().select().from(schema.matches).where(eq(schema.matches.id, match.id)).get()!;
		expect(m.ruleVersionId).toBe(v1.id);
		ingestEvents(roomCtx, [ev({ type: 'tossup_answer', tossup: 1, side: 'A', playerId: null, correct: true }, 2)]);
		const r = computeRound(matchEvents(match.id), rulesForMatch(m, eventId).settings);
		expect(r.teams.A.roundScore).toBe(1000);
	});

	it('rejects events from a device that was taken over, and keeps them for audit', () => {
		getDb().update(schema.rooms).set({ activeDeviceId: 'dev-2' }).where(eq(schema.rooms.id, match.roomId)).run();
		const res = ingestEvents(roomCtx, [ev({ type: 'tossup_dead', tossup: 1 }, 1)]);
		expect(res[0]).toMatchObject({ status: 'rejected', reason: 'device_replaced' });
		expect(getDb().select().from(schema.rejectedEvents).all()).toHaveLength(1);
	});

	it('locks a round for the room once it is submitted, but staff can still correct it', () => {
		const start = ev({ type: 'round_started', lineups: { A: [], B: [] } }, 1);
		const ans = ev({ type: 'tossup_answer', tossup: 1, side: 'A', playerId: null, correct: true }, 2);
		ingestEvents(roomCtx, [start, ans, ev({ type: 'round_ended', reason: 'Time called' }, 3), ev({ type: 'submitted', scoreA: 1000, scoreB: 0 }, 4)]);
		expect(ingestEvents(roomCtx, [ev({ type: 'tossup_dead', tossup: 2 }, 5)])[0].reason).toBe('round_submitted');
		const staff: IngestContext = { ...roomCtx, roomId: null, deviceId: null, actor: 'user:1', actorName: 'Head', source: 'staff', allowed: STAFF_TYPES, enforceLease: false, lockSubmitted: false };
		const fix = ingestEvents(staff, [ev({ type: 'correction', action: 'void', target: ans.id, reason: 'Answer was accepted in error' })]);
		expect(fix[0].status).toBe('accepted');
		// Room scorers cannot send staff-only events.
		expect(ingestEvents(roomCtx, [ev({ type: 'approved' })])[0].reason).toBe('invalid_event');
	});

	it('rejects malformed events, wrong rooms, and unknown undo targets', () => {
		const other = getDb().select().from(schema.matches).all().find((m) => m.roomId !== match.roomId)!;
		const res = ingestEvents(roomCtx, [
			{ id: 'not-a-uuid', matchId: match.id, body: { type: 'tossup_dead', tossup: 1 } },
			{ id: uuid(), matchId: other.id, body: { type: 'tossup_dead', tossup: 1 } },
			ev({ type: 'bonus', tossup: 1, side: 'A', value: 10.5, parts: ['correct'] } as EventBody),
			ev({ type: 'undo', target: uuid() })
		]);
		expect(res.map((r) => r.reason)).toEqual(['invalid_id', 'wrong_room', 'invalid_event', 'unknown_target']);
	});

	it('detects gaps in a device sequence', () => {
		ingestEvents(roomCtx, [ev({ type: 'round_started', lineups: { A: [], B: [] } }, 1), ev({ type: 'tossup_dead', tossup: 1 }, 4)]);
		expect(deviceGaps(match.id)).toEqual([{ deviceId: 'dev-1', missing: [2, 3] }]);
	});
});
