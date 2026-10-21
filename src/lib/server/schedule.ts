import { generateSchedule, type PoolDef, type SchedMatch, type SchedRoom, type SchedTeam } from '$lib/schedule';
import { error } from '@sveltejs/kit';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db';
import { sortClassifications } from './events';
import { listTeams } from './teams';

export function getSession(eventId: number, sessionId: number) {
	const s = getDb().select().from(schema.sessions).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.eventId, eventId))).get();
	if (!s) error(404, 'Session not found');
	return s;
}

export function sessionRooms(sessionId: number) {
	return getDb()
		.select({ id: schema.rooms.id, name: schema.rooms.name, sortOrder: schema.rooms.sortOrder, moderator: schema.sessionRooms.moderator })
		.from(schema.sessionRooms)
		.innerJoin(schema.rooms, eq(schema.sessionRooms.roomId, schema.rooms.id))
		.where(and(eq(schema.sessionRooms.sessionId, sessionId), eq(schema.rooms.active, true)))
		.orderBy(asc(schema.rooms.sortOrder))
		.all();
}

export function sessionPools(sessionId: number) {
	return getDb().select().from(schema.pools).where(eq(schema.pools.sessionId, sessionId)).all();
}

/** Pool key for a classification: its saved pool, or its own pool by default. */
export function poolKeyFor(pools: { id: number; classifications: string[] }[], classification: string) {
	const p = pools.find((x) => x.classifications.includes(classification));
	return p ? `pool:${p.id}` : `class:${classification}`;
}

export function poolLabel(pools: { id: number; name: string; classifications: string[] }[], classification: string) {
	return pools.find((x) => x.classifications.includes(classification))?.name ?? classification;
}

/** Match IDs in a session that already have scoring events (locked against edits). */
export function startedMatchIds(sessionId: number): Set<number> {
	const rows = getDb()
		.select({ matchId: schema.scoreEvents.matchId })
		.from(schema.scoreEvents)
		.innerJoin(schema.matches, eq(schema.scoreEvents.matchId, schema.matches.id))
		.where(eq(schema.matches.sessionId, sessionId))
		.groupBy(schema.scoreEvents.matchId)
		.all();
	return new Set(rows.map((r) => r.matchId));
}

export function loadSchedule(eventId: number, sessionId: number) {
	const session = getSession(eventId, sessionId);
	const pools = sessionPools(sessionId);
	const allTeams = listTeams(eventId).filter((t) => t.sessionId === sessionId);
	const teams: (SchedTeam & { arrived: boolean; poolName: string })[] = allTeams.map((t) => ({
		id: t.id,
		name: t.name,
		schoolId: t.schoolId,
		classification: t.classification,
		poolKey: poolKeyFor(pools, t.classification),
		poolName: poolLabel(pools, t.classification),
		withdrawn: t.withdrawn,
		arrived: !!t.arrivedAt,
		lastRound: pools.find((p) => p.classifications.includes(t.classification))?.rounds ?? null
	}));
	const rooms = sessionRooms(sessionId);
	const started = startedMatchIds(sessionId);
	const matches = getDb()
		.select()
		.from(schema.matches)
		.where(eq(schema.matches.sessionId, sessionId))
		.orderBy(asc(schema.matches.roundNo))
		.all()
		.map((m) => ({
			id: m.id,
			roundNo: m.roundNo,
			roomId: m.roomId,
			teamA: m.teamAId,
			teamB: m.teamBId,
			counts: m.counts,
			poolKey: m.poolId ? `pool:${m.poolId}` : null,
			locked: started.has(m.id)
		})) satisfies SchedMatch[];
	const classifications = sortClassifications([...new Set([...session.classifications, ...teams.map((t) => t.classification)])]);
	return { session, pools, teams, rooms, matches, classifications };
}

/** Replace the session's pools from a classification → pool-name map (same name = merged). */
export function savePools(sessionId: number, assignment: Record<string, string>) {
	const byName = new Map<string, string[]>();
	for (const [cls, name] of Object.entries(assignment)) {
		const n = name.trim() || cls;
		byName.set(n, [...(byName.get(n) ?? []), cls]);
	}
	const db = getDb();
	db.transaction((tx) => {
		const old = tx.select().from(schema.pools).where(eq(schema.pools.sessionId, sessionId)).all();
		if (old.length) {
			tx.update(schema.matches).set({ poolId: null }).where(inArray(schema.matches.poolId, old.map((p) => p.id))).run();
			tx.delete(schema.pools).where(eq(schema.pools.sessionId, sessionId)).run();
		}
		// A pool that keeps its name keeps its round count.
		for (const [name, classifications] of byName)
			tx.insert(schema.pools).values({ sessionId, name, classifications, rounds: old.find((p) => p.name === name)?.rounds ?? null }).run();
	});
}

/** Set how many rounds each pool plays (null or the session's count = every round). */
export function savePoolRounds(sessionId: number, sessionRounds: number, rounds: Record<number, number | null>) {
	const db = getDb();
	for (const p of sessionPools(sessionId)) {
		if (!(p.id in rounds)) continue;
		const r = rounds[p.id];
		db.update(schema.pools).set({ rounds: r && r < sessionRounds ? r : null }).where(eq(schema.pools.id, p.id)).run();
	}
}

export interface DraftOptions {
	rounds: number;
	onlyArrived: boolean;
	fillByesWithNonCounters: boolean;
}

/** Generate a draft schedule. Refuses if any game in the session has already been scored. */
export function generateDraft(eventId: number, sessionId: number, opts: DraftOptions) {
	const { teams, rooms } = loadSchedule(eventId, sessionId);
	if (startedMatchIds(sessionId).size) return { ok: false as const, error: 'Scoring has started in this session, so the schedule cannot be regenerated. Edit games individually instead.' };
	// Make sure every classification has a pool row so games can reference it.
	const pools = ensurePools(sessionId, teams.map((t) => t.classification));
	const playing = teams.filter((t) => !t.withdrawn && (!opts.onlyArrived || t.arrived));
	const poolDefs: PoolDef[] = pools
		.map((p) => ({ key: `pool:${p.id}`, name: p.name, rounds: p.rounds, teamIds: playing.filter((t) => p.classifications.includes(t.classification)).map((t) => t.id) }))
		.filter((p) => p.teamIds.length);
	const schedTeams = playing.map((t) => ({ ...t, poolKey: poolKeyFor(pools, t.classification) }));
	const res = generateSchedule({ pools: poolDefs, teams: schedTeams, rooms: rooms as SchedRoom[], rounds: opts.rounds, fillByesWithNonCounters: opts.fillByesWithNonCounters });
	const db = getDb();
	db.transaction((tx) => {
		tx.delete(schema.matches).where(eq(schema.matches.sessionId, sessionId)).run();
		for (const m of res.matches)
			tx.insert(schema.matches)
				.values({
					sessionId,
					roundNo: m.roundNo,
					roomId: m.roomId,
					teamAId: m.teamA,
					teamBId: m.teamB,
					counts: m.counts,
					poolId: m.poolKey ? Number(m.poolKey.slice(5)) : null
				})
				.run();
		tx.update(schema.sessions).set({ roundCount: opts.rounds, scheduleStatus: 'draft', schedulePublishedAt: null }).where(eq(schema.sessions.id, sessionId)).run();
	});
	return { ok: true as const, warnings: res.warnings, matches: res.matches.length };
}

function ensurePools(sessionId: number, classifications: string[]) {
	const db = getDb();
	const pools = sessionPools(sessionId);
	for (const c of new Set(classifications))
		if (!pools.some((p) => p.classifications.includes(c))) db.insert(schema.pools).values({ sessionId, name: c, classifications: [c] }).run();
	return sessionPools(sessionId);
}

export function poolIdForTeams(sessionId: number, a: { classification: string }, b: { classification: string }) {
	const pools = sessionPools(sessionId);
	const pa = pools.find((p) => p.classifications.includes(a.classification));
	const pb = pools.find((p) => p.classifications.includes(b.classification));
	return pa && pb && pa.id === pb.id ? pa.id : null;
}

