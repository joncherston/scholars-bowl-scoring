import type { Hundredths } from './points';
import type { RoundResult } from './round';
import { divisionOf, formatOf, type RuleSettings, type StandingsCriterion } from './rules';
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
	/** pool (default): pool play / round robin. bracket: a game in a division's bracket. */
	stage?: 'pool' | 'bracket';
	/** Bracket position: F, 3P, SF1, SF2, QF1–QF4. */
	slot?: string | null;
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
	/** Bracket divisions: seed from pool play, and how the team finished in the bracket. */
	seed?: number;
	bracketResult?: string;
	/** Bracket divisions: this place still depends on bracket games that aren't final. */
	pending?: boolean;
}

export interface SeedRow {
	teamId: string;
	seed: number;
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
	/** Division format; brackets also carry the pool-play seeding. */
	format?: 'round_robin' | 'bracket';
	seeds?: SeedRow[];
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
	| 'division_spans_sessions'
	| 'seed_tie';

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
	/** Head scorekeeper's decisions for seeding ties (groupKey "seed:<division>"). */
	seedResolutions?: { groupKey: string; ordered: string[] }[];
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
	/** Pool-play games only: what seeds a bracket. */
	const seedRecords: Record<string, TeamRecord> = {};
	for (const t of teams) {
		records[t.id] = { teamId: t.id, played: 0, wins: 0, losses: 0, ties: 0, totalPoints: 0, pointsAgainst: 0, h2h: {} };
		seedRecords[t.id] = { teamId: t.id, played: 0, wins: 0, losses: 0, ties: 0, totalPoints: 0, pointsAgainst: 0, h2h: {} };
	}
	const divisionOfTeam = (id: string) => {
		const t = teamById.get(id);
		return t ? divisionOf(rules, t.classification) : null;
	};
	const addResult = (recs: Record<string, TeamRecord>, ids: Record<Side, string>, o: MatchOutcome) => {
		for (const side of ['A', 'B'] as const) {
			const me = recs[ids[side]];
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
	};

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
		addResult(records, ids, o);
		const isBracket = m.stage === 'bracket';
		if (!isBracket) addResult(seedRecords, ids, o);
		if (o.winner === null)
			flags.push({ kind: 'unresolved_round_tie', message: 'A counting round ended tied without a tiebreaker', matchId: m.id, teamIds: [m.teamA, m.teamB] });
		if (o.hasFractional)
			flags.push({ kind: 'fractional_points', message: 'A counting round includes fractional bonus points', matchId: m.id, teamIds: [m.teamA, m.teamB] });
		// Bracket games count for individuals only when the division's format says so.
		const div = divisionOfTeam(m.teamA) ?? divisionOfTeam(m.teamB);
		if (isBracket && div && !formatOf(rules, div).bracketCountsForIndividuals) continue;
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
		const fmt = kind === 'division' && g.division ? formatOf(rules, g.division) : null;
		if (fmt?.type === 'bracket') return rankBracketDivision(key, g, fmt);
		// Pools show pool play only (bracket games are not pool games).
		const recs = kind === 'pool' ? seedRecords : records;
		const tiers = rankTiers(g.ids, rules.standings.order, recs);
		const rows: StandingRow[] = [];
		let place = 1;
		for (const tier of tiers) {
			const sortedTier = [...tier].sort((a, b) => (teamById.get(a)?.name ?? '').localeCompare(teamById.get(b)?.name ?? ''));
			for (const id of sortedTier) rows.push({ teamId: id, place, tied: tier.length > 1, record: recs[id] });
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
			const played = new Set(g.ids.map((id) => recs[id].played));
			if (played.size > 1)
				flags.push({ kind: 'unequal_games', message: `${g.label}: teams have played different numbers of counting games`, groupKey: key, teamIds: g.ids });
		}
		if (kind === 'division') {
			flagClassTies(key, g.label, tiers);
			if (soleTeam) flags.push({ kind: 'sole_team', message: `${g.label}: only team in its award division`, groupKey: key, teamIds: g.ids });
			if (sessionIds.length > 1)
				flags.push({ kind: 'division_spans_sessions', message: `${g.label}: teams from different sessions are ranked together for awards`, groupKey: key, teamIds: g.ids });
			else if (new Set(g.ids.map((id) => poolKeyOf(teamById.get(id)!))).size > 1)
				flags.push({ kind: 'division_split_pools', message: `${g.label}: teams in different pools didn't all play each other.`, groupKey: key, teamIds: g.ids });
		}
		return { key, kind, sessionId: sessionIds.length === 1 ? sessionIds[0] : null, sessionIds, label: g.label, classification: g.classification, division: g.division, rows, soleTeam, format: kind === 'division' ? 'round_robin' : undefined };
	};

	/** A tie that decides a classification award place (e.g. two 2A teams tied for the 2A 2nd place). */
	function flagClassTies(key: string, label: string, tiers: string[][]) {
		const seen = new Map<string, number>();
		let place = 1;
		for (const tier of tiers) {
			if (tier.length > 1) {
				const byClass = new Map<string, string[]>();
				for (const id of tier) {
					const c = teamById.get(id)?.classification ?? '';
					byClass.set(c, [...(byClass.get(c) ?? []), id]);
				}
				for (const [c, ids] of byClass) {
					const classRank = (seen.get(c) ?? 0) + 1;
					if (ids.length > 1 && classRank <= rules.awards.classPlaces && place > rules.awards.teamPlaces)
						flags.push({ kind: 'team_tie', message: `${label}: ${ids.length} ${c} teams tied for the ${c} place ${classRank} after all tie-breakers`, groupKey: key, teamIds: tier });
				}
			}
			for (const id of tier) {
				const c = teamById.get(id)?.classification ?? '';
				seen.set(c, (seen.get(c) ?? 0) + 1);
			}
			place += tier.length;
		}
	}

	/** Seed order from pool play; ties the head scorekeeper decided are split in the decided order. */
	function seedTiers(ids: string[], division: string, fmt: ReturnType<typeof formatOf>): string[][] {
		const resolve = (tiers: string[][]) =>
			tiers.flatMap((t) => {
				if (t.length < 2) return [t];
				const res = input.seedResolutions?.find((r) => r.groupKey === `seed:${division}` && r.ordered.length === t.length && t.every((x) => r.ordered.includes(x)));
				return res ? res.ordered.map((x) => [x]) : [t];
			});
		const order = rules.format.seedingOrder;
		if (fmt.seeding !== 'poolWinnersFirst') return resolve(rankTiers(ids, order, seedRecords));
		const byPool = new Map<string, string[]>();
		for (const id of ids) {
			const k = poolKeyOf(teamById.get(id)!);
			byPool.set(k, [...(byPool.get(k) ?? []), id]);
		}
		if (byPool.size < 2) return resolve(rankTiers(ids, order, seedRecords));
		const winners: string[] = [];
		for (const poolIds of byPool.values()) {
			const t = resolve(rankTiers(poolIds, order, seedRecords));
			if (t[0].length === 1) winners.push(t[0][0]);
		}
		const rest = ids.filter((id) => !winners.includes(id));
		return [...resolve(rankTiers(winners, order, seedRecords)), ...resolve(rankTiers(rest, order, seedRecords))];
	}

	function rankBracketDivision(key: string, g: Group, fmt: ReturnType<typeof formatOf>): StandingGroup {
		const division = g.division!;
		const tiers = seedTiers(g.ids, division, fmt);
		const seeds: SeedRow[] = [];
		let n = 1;
		for (const tier of tiers) {
			const sorted = [...tier].sort((a, b) => (teamById.get(a)?.name ?? '').localeCompare(teamById.get(b)?.name ?? ''));
			for (const id of sorted) seeds.push({ teamId: id, seed: n, tied: tier.length > 1, record: seedRecords[id] });
			// A tie matters when it decides who makes the bracket or who plays whom.
			if (tier.length > 1 && n <= fmt.bracketSize)
				flags.push({ kind: 'seed_tie', message: `${g.label}: ${tier.length} teams tied for seed ${n} after all tie-breakers; head scorekeeper must decide the seeds`, groupKey: `seed:${division}`, teamIds: tier });
			n += tier.length;
		}
		const seedOf = new Map(seeds.map((s) => [s.teamId, s.seed]));
		const bySeed = (a: string, b: string) => (seedOf.get(a) ?? 99) - (seedOf.get(b) ?? 99);

		// Bracket games for this division.
		const inDiv = new Set(g.ids);
		const bracket = matches.filter((m) => m.counts && m.stage === 'bracket' && (inDiv.has(m.teamA) || inDiv.has(m.teamB)));
		const result = (slot: string) => {
			const m = bracket.find((x) => x.slot === slot);
			if (!m) return { exists: false as const };
			const o = outcomes[m.id];
			if (!o || !included.has(o.status) || !o.winner) return { exists: true as const, done: false as const, teams: [m.teamA, m.teamB] };
			const w = o.winner === 'A' ? m.teamA : m.teamB;
			return { exists: true as const, done: true as const, winner: w, loser: w === m.teamA ? m.teamB : m.teamA, teams: [m.teamA, m.teamB] };
		};
		const placed: { id: string; place: number; label: string; pending: boolean }[] = [];
		const inBracket = [...new Set(bracket.flatMap((m) => [m.teamA, m.teamB]).filter((id) => inDiv.has(id)))];
		const has = (id: string) => placed.some((p) => p.id === id);
		const fin = result('F');
		if (fin.exists && fin.done) {
			placed.push({ id: fin.winner, place: 1, label: 'Champion', pending: false }, { id: fin.loser, place: 2, label: 'Runner-up', pending: false });
		}
		const third = result('3P');
		if (third.exists && third.done) {
			placed.push({ id: third.winner, place: 3, label: 'Won 3rd-place game', pending: false }, { id: third.loser, place: 4, label: 'Lost 3rd-place game', pending: false });
		} else if (!fmt.thirdPlaceGame && !third.exists && fmt.bracketSize >= 4) {
			// No 3rd-place game: semifinal losers share the next places, ordered by seed.
			const losers = ['SF1', 'SF2'].map(result).filter((r) => r.exists && r.done).map((r) => (r as { loser: string }).loser);
			if (losers.length === 2) losers.sort(bySeed).forEach((id, i) => placed.push({ id, place: 3 + i, label: 'Semifinalist', pending: false }));
		}
		if (fmt.bracketSize === 8) {
			const losers = ['QF1', 'QF2', 'QF3', 'QF4'].map(result).filter((r) => r.exists && r.done).map((r) => (r as { loser: string }).loser);
			if (losers.length === 4) losers.sort(bySeed).forEach((id, i) => placed.push({ id, place: 5 + i, label: 'Quarterfinalist', pending: false }));
		}
		const rows: StandingRow[] = [];
		const firstOpen = () => (rows.length ? Math.max(...rows.map((r) => r.place)) + 1 : 1);
		for (const p of placed.sort((a, b) => a.place - b.place))
			rows.push({ teamId: p.id, place: p.place, tied: false, record: records[p.id], seed: seedOf.get(p.id), bracketResult: p.label });
		// Bracket teams whose places aren't settled yet, then everyone else by seed.
		for (const id of inBracket.filter((x) => !has(x)).sort(bySeed))
			rows.push({ teamId: id, place: firstOpen(), tied: false, record: records[id], seed: seedOf.get(id), bracketResult: 'In bracket', pending: true });
		const rest = seeds.filter((s) => !inBracket.includes(s.teamId));
		let i = 0;
		while (i < rest.length) {
			let j = i;
			while (j < rest.length && rest[j].seed === rest[i].seed) j++;
			const place = firstOpen();
			for (let k = i; k < j; k++)
				rows.push({ teamId: rest[k].teamId, place, tied: j - i > 1, record: records[rest[k].teamId], seed: rest[k].seed, pending: !inBracket.length });
			i = j;
		}
		const restTiers = (() => {
			const out: string[][] = [];
			for (const r of rows) {
				const last = out[out.length - 1];
				const prev = rows.find((x) => x.teamId === last?.[0]);
				if (last && prev && prev.place === r.place) last.push(r.teamId);
				else out.push([r.teamId]);
			}
			return out;
		})();
		flagClassTies(key, g.label, restTiers);
		const sessionIds = sessionsOf(g.ids);
		const soleTeam = g.ids.length === 1;
		if (soleTeam) flags.push({ kind: 'sole_team', message: `${g.label}: only team in its award division`, groupKey: key, teamIds: g.ids });
		if (sessionIds.length > 1)
			flags.push({ kind: 'division_spans_sessions', message: `${g.label}: teams from different sessions are ranked together for awards`, groupKey: key, teamIds: g.ids });
		const played = new Set(g.ids.map((id) => seedRecords[id].played));
		if (played.size > 1)
			flags.push({ kind: 'unequal_games', message: `${g.label}: teams have played different numbers of pool-play games`, groupKey: key, teamIds: g.ids });
		return { key, kind: 'division', sessionId: sessionIds.length === 1 ? sessionIds[0] : null, sessionIds, label: g.label, classification: null, division, rows, soleTeam, format: 'bracket', seeds };
	}

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
		// Win/loss ratio; a tied round counts as half a win. Rounded so equal ratios compare equal.
		if (c === 'winPct') return r.played ? Math.round(((r.wins + r.ties / 2) / r.played) * 1e6) : 0;
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

export interface ClassAward {
	key: string;
	classification: string;
	division: string;
	sessionIds: string[];
	/** Teams of this classification in the division's final order. Place = rank within the classification. */
	rows: { teamId: string; place: number; tied: boolean; divisionPlace: number; pending: boolean }[];
}

/**
 * Classification awards (e.g. 1st and 2nd in 2A) follow the division's final order:
 * the best-placed 2A team in its division is 2A's 1st place. Call this after tie decisions are applied.
 */
export function classAwards(divisions: StandingGroup[], teams: TeamInfo[]): ClassAward[] {
	const byId = new Map(teams.map((t) => [t.id, t]));
	const out: ClassAward[] = [];
	for (const d of divisions) {
		const classes = new Map<string, StandingRow[]>();
		for (const r of d.rows) {
			const c = byId.get(r.teamId)?.classification;
			if (!c) continue;
			classes.set(c, [...(classes.get(c) ?? []), r]);
		}
		for (const [c, rows] of classes) {
			const ranked: ClassAward['rows'] = [];
			rows.forEach((r, i) => {
				const prev = rows[i - 1];
				const sharesPlace = !!prev && prev.place === r.place && r.tied;
				const place = sharesPlace ? ranked[i - 1].place : i + 1;
				if (sharesPlace) ranked[i - 1].tied = true;
				ranked.push({ teamId: r.teamId, place, tied: sharesPlace, divisionPlace: r.place, pending: !!r.pending });
			});
			out.push({ key: `class:${d.division ?? d.label}:${c}`, classification: c, division: d.division ?? d.label, sessionIds: d.sessionIds, rows: ranked });
		}
	}
	return out;
}
