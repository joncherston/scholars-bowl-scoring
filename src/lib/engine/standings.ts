import type { Hundredths } from './points';
import type { RoundResult } from './round';
import { divisionOf, type RuleSettings, type StandingsCriterion } from './rules';
import type { RoundStatus, Side } from './types';

export interface TeamInfo {
	id: string;
	name: string;
	schoolId: string;
	classification: string;
	sessionId: string;
	poolId: string | null;
	poolName?: string;
	sessionName?: string;
}

export interface MatchInfo {
	id: string;
	sessionId: string;
	roundNo: number;
	teamA: string;
	teamB: string;
	counts: boolean;
}

/** The parts of a computed round that standings need. */
export interface MatchOutcome {
	status: RoundStatus;
	winner: Side | null;
	totals: Record<Side, Hundredths>;
	roundScores: Record<Side, Hundredths>;
	lineups: Record<Side, string[]>;
	players: { playerId: string; side: Side; individualTotal: Hundredths; tossupPoints: Hundredths; corrects: number; negs: number }[];
	hasFractional: boolean;
}

export function summarizeRound(r: RoundResult): MatchOutcome {
	const players = new Map<string, MatchOutcome['players'][number]>();
	for (const side of ['A', 'B'] as const)
		for (const id of r.lineups[side])
			players.set(`${side}:${id}`, { playerId: id, side, individualTotal: 0, tossupPoints: 0, corrects: 0, negs: 0 });
	for (const p of r.players)
		players.set(`${p.side}:${p.playerId}`, {
			playerId: p.playerId,
			side: p.side,
			individualTotal: p.individualTotal,
			tossupPoints: p.tossupPoints,
			corrects: p.corrects,
			negs: p.negs
		});
	return {
		status: r.status,
		winner: r.winner,
		totals: { A: r.teams.A.totalPoints, B: r.teams.B.totalPoints },
		roundScores: { A: r.teams.A.roundScore, B: r.teams.B.roundScore },
		lineups: r.lineups,
		players: [...players.values()],
		hasFractional: r.flags.some((f) => f.kind === 'fractional_bonus')
	};
}

export interface TeamRecord {
	teamId: string;
	played: number;
	wins: number;
	losses: number;
	/** Rounds that ended level with no tiebreaker winner (flagged). */
	ties: number;
	totalPoints: Hundredths;
	pointsAgainst: Hundredths;
	/** Results against each opponent in counting games. */
	h2h: Record<string, { wins: number; losses: number; played: number }>;
}

export interface StandingRow {
	teamId: string;
	place: number;
	tied: boolean;
	record: TeamRecord;
}

export interface StandingGroup {
	key: string;
	/** pool: who plays whom. classification: information only. division: awards. */
	kind: 'pool' | 'classification' | 'division';
	/** The group's session, or null for a division whose teams are in more than one session. */
	sessionId: string | null;
	sessionIds: string[];
	label: string;
	classification: string | null;
	division: string | null;
	rows: StandingRow[];
	soleTeam: boolean;
}

export interface IndividualRow {
	playerId: string;
	teamId: string;
	place: number;
	tied: boolean;
	total: Hundredths;
	tossupPoints: Hundredths;
	corrects: number;
	negs: number;
	games: number;
}

export interface IndividualGroup {
	key: string;
	label: string;
	/** The group's session, or null when its players come from more than one session. */
	sessionId: string | null;
	sessionIds: string[];
	classification: string | null;
	division: string | null;
	rows: IndividualRow[];
}

export type StandingsFlagKind =
	| 'team_tie'
	| 'individual_tie'
	| 'unequal_games'
	| 'fractional_points'
	| 'unresolved_round_tie'
	| 'sole_team'
	| 'division_split_pools'
	| 'division_spans_sessions';

export interface StandingsFlag {
	kind: StandingsFlagKind;
	message: string;
	groupKey?: string;
	teamIds?: string[];
	playerIds?: string[];
	matchId?: string;
}

export interface StandingsInput {
	teams: TeamInfo[];
	matches: MatchInfo[];
	outcomes: Record<string, MatchOutcome | undefined>;
	rules: RuleSettings;
	/** final: approved rounds only. provisional: submitted and approved rounds. */
	mode: 'final' | 'provisional';
}

export interface Standings {
	records: Record<string, TeamRecord>;
	pools: StandingGroup[];
	/** Per classification within each session. Information only: awards use divisions. */
	classifications: StandingGroup[];
	/** Award divisions, each ranked across the whole event. */
	divisions: StandingGroup[];
	individuals: IndividualGroup[];
	/** Counting matches whose results are not included yet. */
	pendingMatchIds: string[];
	flags: StandingsFlag[];
}

const INCLUDED: Record<StandingsInput['mode'], Set<RoundStatus>> = {
	final: new Set(['approved', 'forfeit']),
	provisional: new Set(['submitted', 'approved', 'forfeit'])
};

/**
 * Standings and leaderboards from computed rounds. Only counting games are
 * used. Ties that the configured criteria cannot separate are flagged, never
 * broken silently.
 */
export function computeStandings(input: StandingsInput): Standings {
	const { teams, matches, outcomes, rules } = input;
	const included = INCLUDED[input.mode];
	const teamById = new Map(teams.map((t) => [t.id, t]));
	const flags: StandingsFlag[] = [];

	const records: Record<string, TeamRecord> = {};
	for (const t of teams)
		records[t.id] = { teamId: t.id, played: 0, wins: 0, losses: 0, ties: 0, totalPoints: 0, pointsAgainst: 0, h2h: {} };

	interface PlayerAgg {
		playerId: string;
		teamId: string;
		total: number;
		tossupPoints: number;
		corrects: number;
		negs: number;
		games: number;
	}
	const playerAgg = new Map<string, PlayerAgg>();
	const pendingMatchIds: string[] = [];

	for (const m of matches) {
		if (!m.counts) continue;
		const o = outcomes[m.id];
		if (!o || !included.has(o.status)) {
			pendingMatchIds.push(m.id);
			continue;
		}
		const ids: Record<Side, string> = { A: m.teamA, B: m.teamB };
		for (const side of ['A', 'B'] as const) {
			const me = records[ids[side]];
			const opp = side === 'A' ? 'B' : 'A';
			if (!me) continue;
			me.played++;
			me.totalPoints += o.totals[side];
			me.pointsAgainst += o.totals[opp];
			const h = (me.h2h[ids[opp]] ??= { wins: 0, losses: 0, played: 0 });
			h.played++;
			if (o.winner === side) {
				me.wins++;
				h.wins++;
			} else if (o.winner === opp) {
				me.losses++;
				h.losses++;
			} else me.ties++;
		}
		if (o.winner === null)
			flags.push({ kind: 'unresolved_round_tie', message: 'A counting round ended tied without a tiebreaker', matchId: m.id, teamIds: [m.teamA, m.teamB] });
		if (o.hasFractional)
			flags.push({ kind: 'fractional_points', message: 'A counting round includes fractional bonus points', matchId: m.id, teamIds: [m.teamA, m.teamB] });
		for (const p of o.players) {
			const teamId = ids[p.side];
			const key = `${teamId}:${p.playerId}`;
			let a = playerAgg.get(key);
			if (!a) playerAgg.set(key, (a = { playerId: p.playerId, teamId, total: 0, tossupPoints: 0, corrects: 0, negs: 0, games: 0 }));
			a.total += p.individualTotal;
			a.tossupPoints += p.tossupPoints;
			a.corrects += p.corrects;
			a.negs += p.negs;
			if (o.lineups[p.side].includes(p.playerId)) a.games++;
		}
	}

	// Team groups: pools (who plays whom), classifications (information), and award divisions.
	interface Group {
		label: string;
		classification: string | null;
		division: string | null;
		ids: string[];
	}
	const poolGroups = new Map<string, Group>();
	const classGroups = new Map<string, Group>();
	const divGroups = new Map<string, Group>();
	const addTo = (groups: Map<string, Group>, key: string, init: Omit<Group, 'ids'>, id: string) => {
		const g = groups.get(key) ?? { ...init, ids: [] };
		g.ids.push(id);
		groups.set(key, g);
	};
	const poolKeyOf = (t: TeamInfo) => `${t.sessionId}|pool:${t.poolId ?? `class:${t.classification}`}`;
	for (const t of teams) {
		addTo(poolGroups, poolKeyOf(t), { label: t.poolName ?? t.classification, classification: null, division: null }, t.id);
		addTo(classGroups, `${t.sessionId}|class:${t.classification}`, { label: t.classification, classification: t.classification, division: null }, t.id);
		const d = divisionOf(rules, t.classification);
		addTo(divGroups, `division:${d}`, { label: d, classification: null, division: d }, t.id);
	}
	const sessionsOf = (ids: string[]) => [...new Set(ids.map((id) => teamById.get(id)!.sessionId))].sort();

	const rankGroup = (key: string, kind: StandingGroup['kind'], g: Group): StandingGroup => {
		const tiers = rankTiers(g.ids, rules.standings.order, records);
		const rows: StandingRow[] = [];
		let place = 1;
		for (const tier of tiers) {
			const sortedTier = [...tier].sort((a, b) => (teamById.get(a)?.name ?? '').localeCompare(teamById.get(b)?.name ?? ''));
			for (const id of sortedTier) rows.push({ teamId: id, place, tied: tier.length > 1, record: records[id] });
			if (kind === 'division' && tier.length > 1 && place <= rules.awards.teamPlaces)
				flags.push({
					kind: 'team_tie',
					message: `${g.label}: ${tier.length} teams tied for place ${place} after all tie-breakers`,
					groupKey: key,
					teamIds: tier
				});
			place += tier.length;
		}
		const sessionIds = sessionsOf(g.ids);
		const soleTeam = g.ids.length === 1;
		if (kind !== 'classification') {
			const played = new Set(g.ids.map((id) => records[id].played));
			if (played.size > 1)
				flags.push({ kind: 'unequal_games', message: `${g.label}: teams have played different numbers of counting games`, groupKey: key, teamIds: g.ids });
		}
		if (kind === 'division') {
			if (soleTeam) flags.push({ kind: 'sole_team', message: `${g.label}: only team in its award division`, groupKey: key, teamIds: g.ids });
			if (sessionIds.length > 1)
				flags.push({ kind: 'division_spans_sessions', message: `${g.label}: teams from different sessions are ranked together for awards`, groupKey: key, teamIds: g.ids });
			else if (new Set(g.ids.map((id) => poolKeyOf(teamById.get(id)!))).size > 1)
				flags.push({ kind: 'division_split_pools', message: `${g.label}: teams in different pools didn't all play each other.`, groupKey: key, teamIds: g.ids });
		}
		return { key, kind, sessionId: sessionIds.length === 1 ? sessionIds[0] : null, sessionIds, label: g.label, classification: g.classification, division: g.division, rows, soleTeam };
	};

	const pools = [...poolGroups].map(([k, g]) => rankGroup(k, 'pool', g));
	const classifications = [...classGroups].map(([k, g]) => rankGroup(k, 'classification', g));
	const divisions = [...divGroups].map(([k, g]) => rankGroup(k, 'division', g));
	const divisionSessions = new Map(divisions.map((g) => [g.division!, g.sessionIds]));

	// Individual leaderboards.
	const indGroups = new Map<string, Omit<IndividualGroup, 'key' | 'rows'> & { rows: PlayerAgg[] }>();
	const allSessions = sessionsOf(teams.map((t) => t.id));
	for (const a of playerAgg.values()) {
		const t = teamById.get(a.teamId);
		if (!t) continue;
		let key: string, g: Omit<IndividualGroup, 'key' | 'rows'>;
		switch (rules.awards.individualGrouping) {
			case 'division': {
				const d = divisionOf(rules, t.classification);
				const sessionIds = divisionSessions.get(d) ?? [t.sessionId];
				key = `division:${d}`;
				g = { label: d, sessionId: sessionIds.length === 1 ? sessionIds[0] : null, sessionIds, classification: null, division: d };
				break;
			}
			case 'classification':
				key = `${t.sessionId}|class:${t.classification}`;
				g = { label: t.classification, sessionId: t.sessionId, sessionIds: [t.sessionId], classification: t.classification, division: null };
				break;
			case 'session':
				key = `${t.sessionId}`;
				g = { label: t.sessionName ?? 'Session', sessionId: t.sessionId, sessionIds: [t.sessionId], classification: null, division: null };
				break;
			default:
				key = 'overall';
				g = { label: 'Overall', sessionId: null, sessionIds: allSessions, classification: null, division: null };
		}
		const grp = indGroups.get(key) ?? { ...g, rows: [] };
		grp.rows.push(a);
		indGroups.set(key, grp);
	}
	const individuals: IndividualGroup[] = [];
	for (const [key, g] of indGroups) {
		const sorted = [...g.rows].sort((a, b) => b.total - a.total || a.playerId.localeCompare(b.playerId));
		const rows: IndividualRow[] = [];
		let i = 0;
		while (i < sorted.length) {
			let j = i;
			while (j < sorted.length && sorted[j].total === sorted[i].total) j++;
			const place = i + 1;
			const tied = j - i > 1;
			for (let k = i; k < j; k++) rows.push({ ...sorted[k], place, tied });
			if (tied && place <= rules.awards.individualPlaces)
				flags.push({
					kind: 'individual_tie',
					message: `${g.label}: ${j - i} players tied for individual place ${place}; head scorekeeper must resolve`,
					groupKey: key,
					playerIds: sorted.slice(i, j).map((r) => r.playerId)
				});
			i = j;
		}
		individuals.push({ key, label: g.label, sessionId: g.sessionId, sessionIds: g.sessionIds, classification: g.classification, division: g.division, rows });
	}

	return { records, pools, classifications, divisions, individuals, pendingMatchIds, flags };
}

/** Split teams into ordered tiers using each criterion in turn; head-to-head is computed within the tied group. */
export function rankTiers(ids: string[], criteria: StandingsCriterion[], records: Record<string, TeamRecord>): string[][] {
	if (ids.length <= 1 || criteria.length === 0) return [ids];
	const [c, ...rest] = criteria;
	const group = new Set(ids);
	const key = (id: string): number => {
		const r = records[id];
		if (c === 'roundsWon') return r.wins;
		if (c === 'totalPoints') return r.totalPoints;
		let net = 0;
		for (const [opp, h] of Object.entries(r.h2h)) if (group.has(opp)) net += h.wins - h.losses;
		return net;
	};
	const sorted = [...ids].sort((a, b) => key(b) - key(a));
	const tiers: string[][] = [];
	for (const id of sorted) {
		const last = tiers[tiers.length - 1];
		if (last && key(last[0]) === key(id)) last.push(id);
		else tiers.push([id]);
	}
	if (tiers.length === 1) return rankTiers(ids, rest, records);
	return tiers.flatMap((t) => (t.length > 1 ? rankTiers(t, criteria, records) : [t]));
}
