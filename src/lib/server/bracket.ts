/**
 * Brackets on the server: plan the bracket games of each bracket division (with rooms), and
 * create the real games as soon as their teams are known (seeds after pool play, winners and
 * losers after each bracket round). Everything is logged; head scorekeepers can still edit games.
 */
import { bracketPlan, describeSource } from '$lib/bracket';
import { divisionOf, formatOf, isFinalStatus, type RuleSettings } from '$lib/engine';
import { and, eq, inArray } from 'drizzle-orm';
import { audit } from './audit';
import { publish } from './bus';
import { getDb, schema } from './db';
import { currentRuleVersion } from './events';
import { computeLive } from './live';
import { loadSchedule, sessionRooms, startedMatchIds } from './schedule';

/** Bracket divisions with teams in this session, and those teams. */
export function bracketDivisions(eventId: number, sessionId: number, rules: RuleSettings = currentRuleVersion(eventId).settings) {
	const sched = loadSchedule(eventId, sessionId);
	const out = new Map<string, { fmt: ReturnType<typeof formatOf>; teamIds: number[] }>();
	for (const t of sched.teams) {
		if (t.withdrawn) continue;
		const d = divisionOf(rules, t.classification);
		const fmt = formatOf(rules, d);
		if (fmt.type !== 'bracket') continue;
		const e = out.get(d) ?? { fmt, teamIds: [] };
		e.teamIds.push(t.id);
		out.set(d, e);
	}
	return out;
}

/**
 * (Re)plan the bracket games for every bracket division in a session. Slots whose game has
 * started are kept; the rest are replaced. Rooms: the first free rooms in each round, preferring
 * rooms the division used in pool play. Returns warnings (e.g. not enough rooms for non-counters).
 */
export function planBrackets(eventId: number, sessionId: number, actor: string): string[] {
	const db = getDb();
	const rules = currentRuleVersion(eventId).settings;
	const divisions = bracketDivisions(eventId, sessionId, rules);
	const sched = loadSchedule(eventId, sessionId);
	const rooms = sessionRooms(sessionId);
	const started = startedMatchIds(sessionId);
	const warnings: string[] = [];
	let maxRound = sched.session.roundCount;
	db.transaction((tx) => {
		const existing = tx.select().from(schema.bracketSlots).where(eq(schema.bracketSlots.sessionId, sessionId)).all();
		const keep = existing.filter((s) => s.matchId && started.has(s.matchId));
		const drop = existing.filter((s) => !keep.includes(s));
		const dropMatchIds = drop.map((s) => s.matchId).filter((x): x is number => !!x);
		if (drop.length) tx.delete(schema.bracketSlots).where(inArray(schema.bracketSlots.id, drop.map((s) => s.id))).run();
		if (dropMatchIds.length) tx.delete(schema.matches).where(inArray(schema.matches.id, dropMatchIds)).run();

		// Rooms already taken in each round: pool games and kept bracket games.
		const taken = new Map<number, Set<number>>();
		const take = (r: number, roomId: number) => taken.set(r, (taken.get(r) ?? new Set()).add(roomId));
		for (const m of sched.matches) if (!dropMatchIds.includes(m.id!)) take(m.roundNo, m.roomId);
		for (const s of keep) if (s.roomId) take(s.roundNo, s.roomId);

		// Counting bracket games get rooms first (every division), then the non-counters.
		const planned = [...divisions].flatMap(([division, { fmt, teamIds }]) => {
			// Rooms this division used most in pool play come first.
			const use = new Map<number, number>();
			for (const m of sched.matches) if (teamIds.includes(m.teamA) || teamIds.includes(m.teamB)) use.set(m.roomId, (use.get(m.roomId) ?? 0) + (m.counts ? 1 : 0));
			const preferred = [...rooms].sort((a, b) => (use.get(b.id) ?? 0) - (use.get(a.id) ?? 0) || a.sortOrder - b.sortOrder);
			return bracketPlan(fmt, teamIds.length).map((p) => ({ p, division, fmt, preferred }));
		});
		planned.sort((a, b) => Number(b.p.counts) - Number(a.p.counts) || a.fmt.seedingRounds + a.p.bracketRound - (b.fmt.seedingRounds + b.p.bracketRound));
		for (const { p, division, fmt, preferred } of planned) {
			{
				if (keep.some((k) => k.division === division && k.slot === p.slot)) continue;
				const roundNo = fmt.seedingRounds + p.bracketRound;
				maxRound = Math.max(maxRound, roundNo);
				const room = preferred.find((r) => !taken.get(roundNo)?.has(r.id));
				if (!room && !p.counts) {
					warnings.push(`${division}, round ${roundNo}: no room left for "${p.label}"; those teams have a bye.`);
					continue;
				}
				if (!room) warnings.push(`${division}, round ${roundNo}: no free room for ${p.label}. Add a room or move a game.`);
				if (room) take(roundNo, room.id);
				tx.insert(schema.bracketSlots)
					.values({ sessionId, division, slot: p.slot, label: p.label, roundNo, roomId: room?.id ?? null, sourceA: p.sourceA, sourceB: p.sourceB, counts: p.counts })
					.run();
			}
		}
		if (maxRound > sched.session.roundCount) tx.update(schema.sessions).set({ roundCount: maxRound }).where(eq(schema.sessions.id, sessionId)).run();
	});
	audit(actor, 'bracket_planned', { sessionId, divisions: [...divisions.keys()], warnings }, eventId);
	publish({ type: 'schedule', eventId, sessionId });
	return warnings;
}

export interface AdvanceResult {
	created: string[];
	updated: string[];
	waiting: string[];
	problems: string[];
}

/**
 * Create bracket games whose teams are now known, and keep not-yet-started bracket games in step
 * with corrected results. Seeds use submitted and approved games (the dashboard flags any later
 * correction that would change a game that has already started).
 */
export function advanceBrackets(eventId: number, actor: string, opts: { sessionId?: number; force?: boolean } = {}): AdvanceResult {
	const db = getDb();
	const out: AdvanceResult = { created: [], updated: [], waiting: [], problems: [] };
	const sessionIds = db
		.select({ id: schema.sessions.id })
		.from(schema.sessions)
		.where(eq(schema.sessions.eventId, eventId))
		.all()
		.map((s) => s.id)
		.filter((id) => !opts.sessionId || id === opts.sessionId);
	const slots = sessionIds.length ? db.select().from(schema.bracketSlots).where(inArray(schema.bracketSlots.sessionId, sessionIds)).all() : [];
	if (!slots.length) return out;
	const live = computeLive(eventId);
	const st = live.provisional;
	const resultOf = (matchId: number | null) => live.matches.find((m) => m.id === matchId)?.result;
	const started = new Set(live.matches.filter((m) => m.result.status !== 'not_started').map((m) => m.id));

	for (const sessionId of sessionIds) {
		const mine = slots.filter((s) => s.sessionId === sessionId);
		for (const division of new Set(mine.map((s) => s.division))) {
			const group = st.divisions.find((g) => g.division === division);
			const divTeams = new Set(live.teams.filter((t) => divisionOf(live.rules, t.classification) === division && t.sessionId === String(sessionId)).map((t) => Number(t.id)));
			// Seeds are ready when every pool-play counting game of the division has a result and no seeding tie is open.
			const poolGames = live.matches.filter((m) => m.sessionId === sessionId && m.counts && (divTeams.has(m.teamA) || divTeams.has(m.teamB)) && !mine.some((s) => s.matchId === m.id));
			const unfinished = poolGames.filter((m) => !(m.result.status === 'submitted' || isFinalStatus(m.result.status)));
			const seedTie = st.flags.some((f) => f.kind === 'seed_tie' && f.groupKey === `seed:${division}`);
			const seedsReady = (unfinished.length === 0 && !seedTie) || !!opts.force;
			const seeds = group?.seeds ?? [];
			const resolve = (src: string): number | null | 'wait' => {
				const [kind, ref] = src.split(':');
				if (kind === 'seed') {
					if (!seedsReady) return 'wait';
					const sd = seeds.find((x) => x.seed === Number(ref)) ?? seeds[Number(ref) - 1];
					return sd ? Number(sd.teamId) : null;
				}
				const from = mine.find((s) => s.division === division && s.slot === ref);
				const r = resultOf(from?.matchId ?? null);
				if (!from?.matchId || !r || !(r.status === 'submitted' || isFinalStatus(r.status)) || !r.winner) return 'wait';
				const m = live.matches.find((x) => x.id === from.matchId)!;
				const w = r.winner === 'A' ? m.teamA : m.teamB;
				return kind === 'winner' ? w : w === m.teamA ? m.teamB : m.teamA;
			};
			for (const slot of mine.filter((s) => s.division === division).sort((a, b) => a.roundNo - b.roundNo || a.id - b.id)) {
				const a = resolve(slot.sourceA);
				const b = resolve(slot.sourceB);
				const label = `${division} ${slot.label}`;
				if (a === 'wait' || b === 'wait') {
					if (!slot.matchId) out.waiting.push(`${label}: waiting for ${[a === 'wait' ? describeSource(slot.sourceA, mine) : null, b === 'wait' ? describeSource(slot.sourceB, mine) : null].filter(Boolean).join(' and ')}`);
					continue;
				}
				if (a === null || b === null) {
					if (!slot.matchId) out.waiting.push(`${label}: not enough teams (no ${a === null ? describeSource(slot.sourceA) : describeSource(slot.sourceB)})`);
					continue;
				}
				if (!slot.matchId) {
					if (!slot.roomId) {
						out.problems.push(`${label} (round ${slot.roundNo}) has no room. Give it a room on the Schedule page.`);
						continue;
					}
					const clash = db
						.select()
						.from(schema.matches)
						.where(and(eq(schema.matches.sessionId, sessionId), eq(schema.matches.roundNo, slot.roundNo)))
						.all()
						.find((m) => m.roomId === slot.roomId || [m.teamAId, m.teamBId].some((t) => t === a || t === b));
					if (clash) {
						out.problems.push(`${label}: round ${slot.roundNo} already has a game in that room or for one of these teams (game ${clash.id}). Move it, then the bracket game will be created.`);
						continue;
					}
					const [m] = db
						.insert(schema.matches)
						.values({ sessionId, roundNo: slot.roundNo, roomId: slot.roomId, teamAId: a, teamBId: b, counts: slot.counts, poolId: null, stage: 'bracket', bracketSlot: slot.slot, division })
						.returning()
						.all();
					db.update(schema.bracketSlots).set({ matchId: m.id }).where(eq(schema.bracketSlots.id, slot.id)).run();
					out.created.push(`${label}: ${teamName(live, a)} v ${teamName(live, b)} (round ${slot.roundNo}, ${live.rooms.find((r) => r.id === slot.roomId)?.name ?? 'room ?'})`);
					audit(actor, 'bracket_game_created', { sessionId, division, slot: slot.slot, matchId: m.id, teamA: a, teamB: b, forced: !!opts.force && !seedsReady }, eventId);
					continue;
				}
				const m = db.select().from(schema.matches).where(eq(schema.matches.id, slot.matchId)).get();
				if (!m) continue;
				const same = (m.teamAId === a && m.teamBId === b) || (m.teamAId === b && m.teamBId === a);
				if (same) continue;
				if (started.has(m.id)) {
					out.problems.push(`${label} has started with ${teamName(live, m.teamAId)} v ${teamName(live, m.teamBId)}, but results now say ${teamName(live, a)} v ${teamName(live, b)}. Decide with the head scorekeeper.`);
					continue;
				}
				db.update(schema.matches).set({ teamAId: a, teamBId: b }).where(eq(schema.matches.id, m.id)).run();
				out.updated.push(`${label}: now ${teamName(live, a)} v ${teamName(live, b)}`);
				audit(actor, 'bracket_game_updated', { matchId: m.id, from: [m.teamAId, m.teamBId], to: [a, b] }, eventId);
			}
		}
	}
	if (out.created.length || out.updated.length) {
		for (const s of sessionIds) publish({ type: 'schedule', eventId, sessionId: s });
		// Later bracket rounds may now be ready too (e.g. a forfeit decided a semifinal instantly).
		const again = advanceBrackets(eventId, actor, { sessionId: opts.sessionId });
		out.created.push(...again.created);
		out.updated.push(...again.updated);
		out.waiting = again.waiting;
		out.problems = again.problems;
	}
	return out;
}

const teamName = (live: ReturnType<typeof computeLive>, id: number) => live.teams.find((t) => t.id === String(id))?.name ?? `Team ${id}`;

/** Does any session of this event have bracket games planned? (Cheap check before advancing.) */
export function hasBracketSlots(eventId: number): boolean {
	return !!getDb()
		.select({ id: schema.bracketSlots.id })
		.from(schema.bracketSlots)
		.innerJoin(schema.sessions, eq(schema.bracketSlots.sessionId, schema.sessions.id))
		.where(eq(schema.sessions.eventId, eventId))
		.limit(1)
		.get();
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
/** Advance brackets shortly after a result changes (bursts of changes are coalesced). */
export function scheduleBracketAdvance(eventId: number) {
	if (!hasBracketSlots(eventId)) return;
	clearTimeout(timers.get(eventId));
	timers.set(
		eventId,
		setTimeout(() => {
			timers.delete(eventId);
			try {
				const r = advanceBrackets(eventId, 'system:bracket');
				if (r.created.length || r.updated.length) console.log('[bracket]', JSON.stringify({ eventId, ...r }));
			} catch (e) {
				console.error('[bracket] advance failed', e);
			}
		}, 300)
	);
}
