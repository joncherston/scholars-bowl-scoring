import { computeRound, type EventBody, type ScoreEvent, type ScoringBody } from '$lib/engine';
import { and, asc, eq, max } from 'drizzle-orm';
import { publish } from './bus';
import { getDb, schema } from './db';
import { currentRuleVersion, ruleVersionById } from './events';

export type Source = 'live' | 'file_import' | 'simulation' | 'staff';

export interface IncomingEvent {
	id: string;
	matchId: number;
	deviceSeq?: number | null;
	body: EventBody;
	clientTs?: string | null;
}

export interface IngestResult {
	id: string;
	status: 'accepted' | 'duplicate' | 'rejected';
	seq?: number;
	reason?: string;
}

export interface IngestContext {
	eventId: number;
	/** Set for room scorers: matches must be in this room. */
	roomId: number | null;
	deviceId: string | null;
	actor: string;
	actorName: string;
	source: Source;
	allowed: ReadonlySet<EventBody['type']>;
	/** Reject events from a device that no longer holds the room. */
	enforceLease: boolean;
	/** Reject room events for rounds already submitted. */
	lockSubmitted: boolean;
}

export const ROOM_TYPES: ReadonlySet<EventBody['type']> = new Set([
	'round_started',
	'lineup_set',
	'tossup_answer',
	'tossup_dead',
	'bonus',
	'tiebreaker_started',
	'round_ended',
	'submitted',
	'undo',
	'note',
	'device_takeover'
]);

export const STAFF_TYPES: ReadonlySet<EventBody['type']> = new Set(['correction', 'approved', 'unapproved', 'note']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const side = (s: unknown) => s === 'A' || s === 'B';
const posInt = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 99;
const str = (s: unknown, maxLen = 500) => typeof s === 'string' && s.length <= maxLen;

function validScoring(b: ScoringBody): boolean {
	if (!posInt(b.tossup)) return false;
	if (b.type === 'tossup_answer')
		return side(b.side) && (b.playerId === null || str(b.playerId, 64)) && typeof b.correct === 'boolean';
	if (b.type === 'tossup_dead') return true;
	if (b.type === 'bonus')
		return (
			side(b.side) &&
			Number.isInteger(b.value) &&
			b.value >= 0 &&
			b.value <= 100000 &&
			Array.isArray(b.parts) &&
			b.parts.length >= 1 &&
			b.parts.length <= 10 &&
			b.parts.every((p) => p === 'correct' || p === 'incorrect' || p === 'bounceback')
		);
	return false;
}

/** Shape check for every event body. The scoring engine handles semantics. */
export function validBody(b: EventBody): boolean {
	if (!b || typeof b !== 'object' || typeof b.type !== 'string') return false;
	switch (b.type) {
		case 'tossup_answer':
		case 'tossup_dead':
		case 'bonus':
			return validScoring(b);
		case 'round_started':
			return !!b.lineups && Array.isArray(b.lineups.A) && Array.isArray(b.lineups.B) && [...b.lineups.A, ...b.lineups.B].every((p) => str(p, 64));
		case 'lineup_set':
			return side(b.side) && Array.isArray(b.players) && b.players.every((p) => str(p, 64));
		case 'tiebreaker_started':
		case 'approved':
			return true;
		case 'round_ended':
			return str(b.reason, 200) && (b.note === undefined || str(b.note, 1000));
		case 'submitted':
			return Number.isInteger(b.scoreA) && Number.isInteger(b.scoreB);
		case 'unapproved':
			return str(b.reason, 1000) && b.reason.trim().length > 0;
		case 'undo':
			return str(b.target, 64);
		case 'note':
			return str(b.text, 2000);
		case 'device_takeover':
			return b.previousDevice === null || str(b.previousDevice, 64);
		case 'correction':
			if (!str(b.reason, 1000) || !b.reason.trim()) return false;
			if (b.action === 'void') return str(b.target, 64);
			if (b.action === 'amend') return str(b.target, 64) && validScoring(b.replacement);
			if (b.action === 'add') return validScoring(b.replacement);
			return false;
	}
	return false;
}

export function toScoreEvent(r: typeof schema.scoreEvents.$inferSelect): ScoreEvent {
	return {
		id: r.id,
		seq: r.seq,
		body: r.body as EventBody,
		actor: r.actor,
		actorName: r.actorName ?? undefined,
		deviceId: r.deviceId,
		deviceSeq: r.deviceSeq,
		clientTs: r.clientTs ?? undefined,
		serverTs: r.serverTs
	};
}

export function matchEvents(matchId: number): ScoreEvent[] {
	return getDb().select().from(schema.scoreEvents).where(eq(schema.scoreEvents.matchId, matchId)).orderBy(asc(schema.scoreEvents.seq)).all().map(toScoreEvent);
}

/** Settings a match is scored under: its snapshot, or the event's current version if not started. */
export function rulesForMatch(match: { ruleVersionId: number | null }, eventId: number) {
	return match.ruleVersionId ? ruleVersionById(match.ruleVersionId) : currentRuleVersion(eventId);
}

function matchInEvent(matchId: number, eventId: number) {
	return getDb()
		.select({ match: schema.matches, eventId: schema.sessions.eventId })
		.from(schema.matches)
		.innerJoin(schema.sessions, eq(schema.matches.sessionId, schema.sessions.id))
		.where(and(eq(schema.matches.id, matchId), eq(schema.sessions.eventId, eventId)))
		.get()?.match;
}

/**
 * Append events to round logs. Idempotent: an event ID already stored is
 * reported as a duplicate and not stored again. Rejected events are kept in
 * rejected_events for the audit trail. Runs in one transaction.
 */
export function ingestEvents(ctx: IngestContext, incoming: IncomingEvent[]): IngestResult[] {
	const db = getDb();
	const results: IngestResult[] = [];
	const touched = new Set<number>();
	const reject = (e: IncomingEvent, reason: string) => {
		db.insert(schema.rejectedEvents)
			.values({ eventUuid: String(e?.id ?? ''), matchId: Number(e?.matchId) || null, deviceId: ctx.deviceId, reason, raw: e ?? null })
			.run();
		results.push({ id: String(e?.id ?? ''), status: 'rejected', reason });
	};

	db.transaction(() => {
		const room = ctx.roomId ? db.select().from(schema.rooms).where(eq(schema.rooms.id, ctx.roomId)).get() : null;
		const leaseLost = ctx.enforceLease && room && room.activeDeviceId !== ctx.deviceId;

		for (const e of incoming) {
			if (!e || typeof e.id !== 'string' || !UUID.test(e.id)) {
				reject(e, 'invalid_id');
				continue;
			}
			const existing = db.select({ seq: schema.scoreEvents.seq, matchId: schema.scoreEvents.matchId }).from(schema.scoreEvents).where(eq(schema.scoreEvents.id, e.id)).get();
			if (existing) {
				results.push({ id: e.id, status: 'duplicate', seq: existing.seq });
				continue;
			}
			if (leaseLost) {
				reject(e, 'device_replaced');
				continue;
			}
			const match = matchInEvent(Number(e.matchId), ctx.eventId);
			if (!match) {
				reject(e, 'unknown_match');
				continue;
			}
			if (ctx.roomId && match.roomId !== ctx.roomId) {
				reject(e, 'wrong_room');
				continue;
			}
			if (!ctx.allowed.has(e.body?.type) || !validBody(e.body)) {
				reject(e, 'invalid_event');
				continue;
			}
			const log = matchEvents(match.id);
			if (e.body.type === 'undo' || (e.body.type === 'correction' && e.body.action !== 'add')) {
				const target = (e.body as { target: string }).target;
				const t = log.find((x) => x.id === target);
				if (!t) {
					reject(e, 'unknown_target');
					continue;
				}
				// A room may only undo its own actions, never a staff correction.
				if (ctx.roomId && !t.actor.startsWith('room:')) {
					reject(e, 'not_allowed');
					continue;
				}
			}
			if (ctx.lockSubmitted) {
				const status = computeRound(log, rulesForMatch(match, ctx.eventId).settings).status;
				if (status === 'submitted' || status === 'approved') {
					reject(e, 'round_submitted');
					continue;
				}
			}
			// Snapshot the settings version when scoring starts.
			if (!match.ruleVersionId) {
				const v = currentRuleVersion(ctx.eventId);
				db.update(schema.matches).set({ ruleVersionId: v.id }).where(eq(schema.matches.id, match.id)).run();
			}
			const next = (db.select({ m: max(schema.scoreEvents.seq) }).from(schema.scoreEvents).where(eq(schema.scoreEvents.matchId, match.id)).get()?.m ?? 0) + 1;
			db.insert(schema.scoreEvents)
				.values({
					id: e.id,
					matchId: match.id,
					seq: next,
					type: e.body.type,
					body: e.body,
					actor: ctx.actor,
					actorName: ctx.actorName,
					deviceId: ctx.deviceId,
					deviceSeq: Number.isInteger(e.deviceSeq) ? e.deviceSeq : null,
					clientTs: typeof e.clientTs === 'string' ? e.clientTs.slice(0, 40) : null,
					source: ctx.source
				})
				.run();
			touched.add(match.id);
			results.push({ id: e.id, status: 'accepted', seq: next });
		}
		if (room && !leaseLost && ctx.source === 'live') db.update(schema.rooms).set({ lastHeardAt: new Date().toISOString() }).where(eq(schema.rooms.id, room.id)).run();
	});

	for (const matchId of touched) publish({ type: 'round', eventId: ctx.eventId, matchId, roomId: ctx.roomId ?? undefined });
	return results;
}

/** Gaps in each device's per-round sequence numbers (events that never arrived). */
export function deviceGaps(matchId: number): { deviceId: string; missing: number[] }[] {
	const rows = getDb()
		.select({ deviceId: schema.scoreEvents.deviceId, deviceSeq: schema.scoreEvents.deviceSeq })
		.from(schema.scoreEvents)
		.where(eq(schema.scoreEvents.matchId, matchId))
		.all();
	const byDevice = new Map<string, number[]>();
	for (const r of rows) if (r.deviceId && r.deviceSeq != null) byDevice.set(r.deviceId, [...(byDevice.get(r.deviceId) ?? []), r.deviceSeq]);
	const out: { deviceId: string; missing: number[] }[] = [];
	for (const [deviceId, seqs] of byDevice) {
		const have = new Set(seqs);
		const lo = 1;
		const hi = Math.max(...seqs);
		const missing: number[] = [];
		for (let i = lo; i <= hi; i++) if (!have.has(i)) missing.push(i);
		if (missing.length) out.push({ deviceId, missing });
	}
	return out;
}
