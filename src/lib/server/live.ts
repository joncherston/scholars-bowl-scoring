import {
	classAwards,
	computeRound,
	computeStandings,
	isFinalStatus,
	summarizeRound,
	type MatchOutcome,
	type RoundResult,
	type RuleSettings,
	type Standings,
	type TeamInfo
} from '$lib/engine';
import { validateSchedule, type Issue } from '$lib/schedule';
import { asc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from './db';
import { currentRuleVersion, getEvent, listRooms, listSessions } from './events';
import { deviceGaps, matchEvents, rulesForMatch } from './ingest';
import { loadSchedule, poolLabel, poolOf, sessionPools } from './schedule';
import { listTeams, playerDisplayName } from './teams';

export interface LiveMatch {
	id: number;
	sessionId: number;
	roundNo: number;
	roomId: number;
	roomName: string;
	teamA: number;
	teamB: number;
	counts: boolean;
	stage: 'pool' | 'bracket';
	slot: string | null;
	division: string | null;
	ruleVersion: number | null;
	result: RoundResult;
	lastEventAt: string | null;
	gaps: { deviceId: string; missing: number[] }[];
	rejected: number;
}

export interface LiveFlag {
	level: 'error' | 'warning' | 'info';
	kind: string;
	message: string;
	matchId?: number;
	sessionId?: number;
	/** For unresolved ties: what the head scorekeeper needs to order. */
	tie?: { kind: 'team' | 'individual'; groupKey: string; ids: string[] };
}

type Resolution = typeof schema.tieResolutions.$inferSelect;
type ResolvedStandings = Standings & {
	flags: (Standings['flags'][number] & { resolved?: string })[];
	divisions: (Standings['divisions'][number] & { rows: (Standings['divisions'][number]['rows'][number] & { resolved?: string })[] })[];
	individuals: (Standings['individuals'][number] & { rows: (Standings['individuals'][number]['rows'][number] & { resolved?: string })[] })[];
};

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Apply the head scorekeeper's recorded tie decisions to tied places. */
function applyResolutions(st: Standings, resolutions: Resolution[]): ResolvedStandings {
	const out = structuredClone(st) as ResolvedStandings;
	const reorder = <R extends { place: number; tied: boolean; resolved?: string }>(rows: R[], idOf: (r: R) => string, kind: 'team' | 'individual', groupKey: string) => {
		const byPlace = new Map<number, R[]>();
		for (const r of rows) if (r.tied) byPlace.set(r.place, [...(byPlace.get(r.place) ?? []), r]);
		for (const [place, tier] of byPlace) {
			const res = resolutions.find((x) => x.kind === kind && x.groupKey === groupKey && sameSet(x.ordered, tier.map(idOf)));
			if (!res) continue;
			for (const r of tier) {
				r.place = place + res.ordered.indexOf(idOf(r));
				r.tied = false;
				r.resolved = res.note;
			}
		}
		rows.sort((a, b) => a.place - b.place);
	};
	for (const g of out.divisions) reorder(g.rows, (r) => r.teamId, 'team', g.key);
	for (const g of out.individuals) reorder(g.rows, (r) => r.playerId, 'individual', g.key);
	for (const f of out.flags) {
		const ids = f.teamIds ?? f.playerIds;
		const kind = f.kind === 'team_tie' ? 'team' : f.kind === 'individual_tie' ? 'individual' : null;
		if (!kind || !ids || !f.groupKey) continue;
		const res = resolutions.find((x) => x.kind === kind && x.groupKey === f.groupKey && sameSet(x.ordered, ids));
		if (res) f.resolved = res.note;
	}
	return out;
}

/**
 * Everything the dashboard, reports, and public page need, computed from the event logs.
 * Standings always cover the whole event, because an award division can span sessions;
 * `sessionIds` limits the games, groups, and flags returned to those sessions.
 */
export function computeLive(eventId: number, opts: { sessionIds?: number[] } = {}) {
	const db = getDb();
	const event = getEvent(eventId);
	const rules: RuleSettings = currentRuleVersion(eventId).settings;
	const allSessions = listSessions(eventId);
	const sessions = allSessions.filter((s) => !opts.sessionIds || opts.sessionIds.includes(s.id));
	const sessionIds = sessions.map((s) => s.id);
	const allSessionIds = allSessions.map((s) => s.id);
	const rooms = listRooms(eventId, true);
	const teamRows = listTeams(eventId);
	const poolsBySession = new Map(allSessionIds.map((id) => [id, sessionPools(id)]));

	const teams: (TeamInfo & { schoolName: string; schoolDisplayName: string; withdrawn: boolean })[] = teamRows
		.filter((t) => t.sessionId && allSessionIds.includes(t.sessionId))
		.map((t) => {
			const pools = poolsBySession.get(t.sessionId!) ?? [];
			const pool = poolOf(pools, t);
			return {
				id: String(t.id),
				name: t.name,
				schoolId: String(t.schoolId),
				classification: t.classification,
				sessionId: String(t.sessionId),
				poolId: pool ? String(pool.id) : null,
				poolName: poolLabel(pools, t),
				sessionName: allSessions.find((s) => s.id === t.sessionId)?.name,
				schoolName: t.schoolName,
				schoolDisplayName: t.schoolDisplayName,
				withdrawn: t.withdrawn
			};
		});

	// Games in practice rooms never roll up: not in standings, individuals, brackets, awards, reports or public results.
	const practiceRooms = new Set(rooms.filter((r) => r.practice).map((r) => r.id));
	const matchRows = allSessionIds.length
		? db
				.select()
				.from(schema.matches)
				.where(inArray(schema.matches.sessionId, allSessionIds))
				.orderBy(asc(schema.matches.roundNo))
				.all()
				.filter((m) => !practiceRooms.has(m.roomId))
		: [];
	const shownIds = matchRows.filter((m) => sessionIds.includes(m.sessionId)).map((m) => m.id);
	const rejectedRows = shownIds.length
		? db.select({ matchId: schema.rejectedEvents.matchId }).from(schema.rejectedEvents).where(inArray(schema.rejectedEvents.matchId, shownIds)).all()
		: [];

	const allMatches: LiveMatch[] = matchRows.map((m) => {
		const events = matchEvents(m.id);
		const rv = rulesForMatch(m, eventId);
		const shown = shownIds.includes(m.id);
		return {
			id: m.id,
			sessionId: m.sessionId,
			roundNo: m.roundNo,
			roomId: m.roomId,
			roomName: rooms.find((r) => r.id === m.roomId)?.name ?? '',
			teamA: m.teamAId,
			teamB: m.teamBId,
			counts: m.counts,
			stage: m.stage,
			slot: m.bracketSlot,
			division: m.division,
			ruleVersion: m.ruleVersionId ? rv.version : null,
			result: computeRound(events, rv.settings),
			lastEventAt: events.length ? (events[events.length - 1].serverTs ?? null) : null,
			gaps: shown && events.length ? deviceGaps(m.id) : [],
			rejected: rejectedRows.filter((r) => r.matchId === m.id).length
		};
	});
	const matches = allMatches.filter((m) => shownIds.includes(m.id));

	const outcomes: Record<string, MatchOutcome> = {};
	for (const m of allMatches) outcomes[String(m.id)] = summarizeRound(m.result);
	// A withdrawn team stays in the standings once it has a counting game played or forfeited.
	const hasCountingResult = (teamId: string) =>
		allMatches.some((m) => m.counts && (String(m.teamA) === teamId || String(m.teamB) === teamId) && (m.result.status === 'submitted' || isFinalStatus(m.result.status)));
	const resolutions = db.select().from(schema.tieResolutions).where(eq(schema.tieResolutions.eventId, eventId)).all().filter((r) => r.active);
	const standingInput = {
		teams: teams.filter((t) => !t.withdrawn || hasCountingResult(t.id)),
		matches: allMatches.map((m) => ({ id: String(m.id), sessionId: String(m.sessionId), roundNo: m.roundNo, teamA: String(m.teamA), teamB: String(m.teamB), counts: m.counts, stage: m.stage, slot: m.slot })),
		outcomes,
		rules,
		seedResolutions: resolutions.filter((r) => r.kind === 'team' && r.groupKey.startsWith('seed:')).map((r) => ({ groupKey: r.groupKey, ordered: r.ordered }))
	};
	// Divisions in the event's classification order (by their first classification).
	const classOrder = (teamId: string) => {
		const i = event.classifications.indexOf(teams.find((t) => t.id === teamId)?.classification ?? '');
		return i < 0 ? event.classifications.length : i;
	};
	const groupOrder = (rows: { teamId: string }[]) => Math.min(event.classifications.length, ...rows.map((r) => classOrder(r.teamId)));
	const selected = new Set(sessionIds.map(String));
	const shownMatchIds = new Set(matches.map((m) => String(m.id)));
	const forView = (st: Standings): Standings => {
		const sortGroups = <G extends { rows: { teamId: string }[] }>(gs: G[]) => [...gs].sort((a, b) => groupOrder(a.rows) - groupOrder(b.rows));
		const out = { ...st, divisions: sortGroups(st.divisions), individuals: sortGroups(st.individuals) };
		if (!opts.sessionIds) return out;
		const inView = (g: { sessionIds: string[] }) => g.sessionIds.some((id) => selected.has(id));
		const view = {
			...out,
			pools: out.pools.filter(inView),
			classifications: out.classifications.filter(inView),
			divisions: out.divisions.filter(inView),
			individuals: out.individuals.filter(inView),
			pendingMatchIds: out.pendingMatchIds.filter((id) => shownMatchIds.has(id))
		};
		const keys = new Set([...view.pools, ...view.classifications, ...view.divisions, ...view.individuals].map((g) => g.key));
		view.flags = out.flags.filter((f) => (f.groupKey ? keys.has(f.groupKey) : f.matchId ? shownMatchIds.has(f.matchId) : true));
		return view;
	};
	const provisional = applyResolutions(forView(computeStandings({ ...standingInput, mode: 'provisional' })), resolutions);
	const final = applyResolutions(forView(computeStandings({ ...standingInput, mode: 'final' })), resolutions);

	// Player names for staff views.
	const playerIds = [...new Set(allMatches.flatMap((m) => [...m.result.lineups.A, ...m.result.lineups.B, ...m.result.players.map((p) => p.playerId)]))];
	const playerRows = playerIds.length ? db.select().from(schema.players).where(inArray(schema.players.id, playerIds)).all() : [];
	const playerNames: Record<string, string> = Object.fromEntries(playerRows.map((p) => [p.id, playerDisplayName(p)]));

	// Flags for the head scorekeeper.
	const flags: LiveFlag[] = [];
	const teamName = (id: number | string) => teams.find((t) => t.id === String(id))?.name ?? `Team ${id}`;
	const label = (m: LiveMatch) => `${sessions.find((s) => s.id === m.sessionId)?.name} R${m.roundNo} ${m.roomName} (${teamName(m.teamA)} vs ${teamName(m.teamB)})`;
	// A room that has started a later round should have submitted its earlier ones.
	const latestStarted = new Map<string, number>();
	const roomKey = (m: LiveMatch) => `${m.sessionId}:${m.roomId}`;
	for (const m of matches) if (m.result.status !== 'not_started') latestStarted.set(roomKey(m), Math.max(latestStarted.get(roomKey(m)) ?? 0, m.roundNo));
	for (const m of matches) {
		const r = m.result;
		for (const f of r.flags) {
			const level: LiveFlag['level'] = ['fractional_bonus', 'inexact_bonus', 'below_min_tossups'].includes(f.kind) ? 'info' : f.kind === 'edited_after_submission' || f.kind === 'submitted_score_mismatch' ? 'warning' : 'warning';
			flags.push({ level, kind: f.kind, message: `${label(m)}: ${f.message}`, matchId: m.id, sessionId: m.sessionId });
		}
		if (m.counts && r.status !== 'submitted' && !isFinalStatus(r.status) && m.roundNo < (latestStarted.get(roomKey(m)) ?? 0))
			flags.push({ level: 'warning', kind: 'not_submitted', message: `${label(m)}: not submitted yet, but this room has started a later round`, matchId: m.id, sessionId: m.sessionId });
		if (m.gaps.length) flags.push({ level: 'error', kind: 'sequence_gap', message: `${label(m)}: some actions from a scoring device never arrived (${m.gaps.map((g) => g.missing.length).reduce((a, b) => a + b, 0)} missing). Ask for that computer's results file.`, matchId: m.id, sessionId: m.sessionId });
		if (m.rejected) flags.push({ level: 'warning', kind: 'rejected_events', message: `${label(m)}: ${m.rejected} action(s) were rejected (see the round's audit)`, matchId: m.id, sessionId: m.sessionId });
	}
	// Ties only need a decision once every counting game involving those teams is approved.
	const teamOfPlayer = new Map<string, string>();
	for (const g of provisional.individuals) for (const r of g.rows) teamOfPlayer.set(r.playerId, r.teamId);
	const settled = (teamIds: string[]) =>
		allMatches.filter((m) => m.counts && (teamIds.includes(String(m.teamA)) || teamIds.includes(String(m.teamB)))).every((m) => isFinalStatus(m.result.status));
	// Seeds only depend on pool play (submitted results are enough to seed).
	const poolPlayDone = (teamIds: string[]) =>
		allMatches
			.filter((m) => m.counts && m.stage !== 'bracket' && (teamIds.includes(String(m.teamA)) || teamIds.includes(String(m.teamB))))
			.every((m) => m.result.status === 'submitted' || isFinalStatus(m.result.status));
	const played = (teamIds: string[]) => teamIds.some((id) => (provisional.records[id]?.played ?? 0) > 0);
	for (const f of provisional.flags) {
		if (f.kind === 'fractional_points' || f.kind === 'unresolved_round_tie') continue; // already flagged per round
		if (f.kind === 'team_tie' || f.kind === 'individual_tie' || f.kind === 'seed_tie') {
			const teamIds = f.teamIds ?? [...new Set((f.playerIds ?? []).map((p) => teamOfPlayer.get(p)!).filter(Boolean))];
			if (!played(teamIds)) continue;
			const ready = f.kind === 'seed_tie' ? poolPlayDone(teamIds) : settled(teamIds);
			if (!ready && !f.resolved) {
				flags.push({ level: 'info', kind: `${f.kind}_provisional`, message: `Currently ${f.message.replace(/^([^:]+): /, '$1: ')} (games still to finish or approve)` });
				continue;
			}
		}
		const isTie = f.kind === 'team_tie' || f.kind === 'individual_tie' || f.kind === 'seed_tie';
		if (f.resolved) flags.push({ level: 'info', kind: `${f.kind}_resolved`, message: `${f.message} — resolved: ${f.resolved}` });
		else
			flags.push({
				level: isTie ? 'error' : f.kind === 'division_spans_sessions' ? 'warning' : 'info',
				kind: f.kind,
				message: f.message,
				tie: isTie ? { kind: f.kind === 'individual_tie' ? 'individual' : 'team', groupKey: f.groupKey!, ids: (f.teamIds ?? f.playerIds)! } : undefined
			});
	}
	// Schedule problems in games that are already final (approved or forfeited) can no longer be acted on.
	const finalIds = new Set(matches.filter((m) => isFinalStatus(m.result.status)).map((m) => m.id));
	for (const s of sessions) {
		const sched = loadSchedule(eventId, s.id);
		const issues: Issue[] = validateSchedule({ teams: sched.teams, rooms: sched.rooms, roundCount: s.roundCount, matches: sched.matches });
		for (const i of issues.filter((x) => x.level !== 'notice' && !(x.matchIds?.length && x.matchIds.every((id) => finalIds.has(id)))))
			flags.push({ level: i.level === 'error' ? 'error' : 'info', kind: 'schedule', message: `${s.name} schedule: ${i.message}`, sessionId: s.id });
		if (!sched.matches.length) flags.push({ level: 'info', kind: 'schedule', message: `${s.name}: no games scheduled`, sessionId: s.id });
	}

	// Withdrawn teams' counting games that haven't started, for "Record forfeits for all remaining games".
	const withdrawn = teams
		.filter((t) => t.withdrawn && selected.has(t.sessionId))
		.map((t) => ({
			teamId: t.id,
			name: t.name,
			games: matches
				.filter((m) => m.counts && m.result.status === 'not_started' && (String(m.teamA) === t.id || String(m.teamB) === t.id))
				.map((m) => ({ matchId: m.id, roundNo: m.roundNo, roomName: m.roomName, opponent: teamName(String(m.teamA) === t.id ? m.teamB : m.teamA) }))
		}))
		.filter((t) => t.games.length);

	// Bracket games still waiting for their teams.
	const slots = sessionIds.length ? db.select().from(schema.bracketSlots).where(inArray(schema.bracketSlots.sessionId, sessionIds)).all() : [];

	return {
		event,
		rules,
		sessions,
		rooms,
		teams,
		matches,
		provisional,
		final,
		classAwards: { provisional: classAwards(provisional.divisions, teams), final: classAwards(final.divisions, teams) },
		slots,
		playerNames,
		flags,
		withdrawn
	};
}

export type Live = ReturnType<typeof computeLive>;

export function teamsById(live: Live) {
	return Object.fromEntries(live.teams.map((t) => [t.id, t]));
}

export const roomHealth = (lastHeardAt: string | null) => {
	if (!lastHeardAt) return { level: 'none' as const, seconds: null };
	const s = Math.round((Date.now() - Date.parse(lastHeardAt)) / 1000);
	return { level: s < 30 ? ('ok' as const) : s < 120 ? ('warn' as const) : ('bad' as const), seconds: s };
};

export function sessionOf(eventId: number, sessionId: number) {
	return getDb().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
}
