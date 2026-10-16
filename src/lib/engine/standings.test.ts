import { describe, expect, it } from 'vitest';
import { HIGH_SCHOOL_DEFAULTS as HS } from './rules';
import { computeRound } from './round';
import { computeStandings, summarizeRound, type MatchInfo, type MatchOutcome, type TeamInfo } from './standings';
import { LogBuilder, rulesWith } from './testkit';
import type { Side } from './types';

const team = (id: string, classification: string, poolId: string | null = null, sessionId = 'am'): TeamInfo => ({
	id,
	name: id,
	schoolId: id,
	classification,
	sessionId,
	poolId
});

/** A finished, approved round where A scores `a` tossups and B scores `b` (10 pts each, no bonus credit). */
function outcome(a: number, b: number, opts: { status?: MatchOutcome['status']; tbWinner?: Side; pa?: string; pb?: string } = {}): MatchOutcome {
	const L = new LogBuilder();
	const pa = opts.pa ?? 'pa';
	const pb = opts.pb ?? 'pb';
	L.start([pa], [pb]);
	let n = 0;
	for (let i = 0; i < a; i++) L.correct(++n, 'A', pa), L.bonus(n, 'A', 10, ['incorrect']);
	for (let i = 0; i < b; i++) L.correct(++n, 'B', pb), L.bonus(n, 'B', 10, ['incorrect']);
	L.end();
	if (opts.tbWinner) L.correct(1, opts.tbWinner, opts.tbWinner === 'A' ? pa : pb, { tiebreaker: true });
	L.add({ type: 'submitted', scoreA: a * 1000, scoreB: b * 1000 });
	if ((opts.status ?? 'approved') === 'approved') L.add({ type: 'approved' }, 'user:1');
	const r = computeRound(L.events, HS);
	return summarizeRound(r);
}

let mid = 0;
const match = (a: string, b: string, counts = true, roundNo = 1): MatchInfo => ({
	id: `m${++mid}`,
	sessionId: 'am',
	roundNo,
	teamA: a,
	teamB: b,
	counts
});

describe('computeStandings', () => {
	it('ranks by rounds won, then total points', () => {
		const teams = [team('X', '1A'), team('Y', '1A'), team('Z', '1A')];
		const m1 = match('X', 'Y');
		const m2 = match('Y', 'Z');
		const m3 = match('Z', 'X');
		const s = computeStandings({
			teams,
			matches: [m1, m2, m3],
			outcomes: { [m1.id]: outcome(5, 3), [m2.id]: outcome(6, 2), [m3.id]: outcome(4, 1) },
			rules: HS,
			mode: 'final'
		});
		// Everyone is 1-1. Points: X 50+10=60, Y 30+60=90, Z 20+40=60.
		// X and Z tie on wins and points; Z beat X head-to-head, so Z is second.
		const g = s.classifications[0];
		expect(g.rows.map((r) => [r.teamId, r.place, r.tied])).toEqual([
			['Y', 1, false],
			['Z', 2, false],
			['X', 3, false]
		]);
		expect(s.records.X.totalPoints).toBe(6000);
		expect(s.records.Z.totalPoints).toBe(6000);
	});

	it('breaks a two-team tie by head-to-head', () => {
		const teams = [team('X', '1A'), team('Y', '1A'), team('Z', '1A')];
		const m1 = match('X', 'Y');
		const m2 = match('Y', 'Z');
		const m3 = match('Z', 'X');
		const s = computeStandings({
			teams,
			matches: [m1, m2, m3],
			outcomes: { [m1.id]: outcome(5, 3), [m2.id]: outcome(6, 2), [m3.id]: outcome(5, 1) },
			rules: HS,
			mode: 'final'
		});
		// X: wins m1 (50) + loses m3 (10) = 60; Y: 30+60 = 90; Z: 20+50 = 70
		expect(s.classifications[0].rows.map((r) => r.teamId)).toEqual(['Y', 'Z', 'X']);
		expect(s.flags.filter((f) => f.kind === 'team_tie')).toEqual([]);
	});

	it('uses head-to-head among tied teams when wins and points are level', () => {
		const teams = [team('X', '2A'), team('Y', '2A')];
		const m1 = match('X', 'Y', true, 1);
		const m2 = match('Y', 'X', true, 2);
		const m3 = match('X', 'Y', true, 3);
		// X wins 1 and 3 by narrow margins, loses 2 big: equal points, X 2-1 in wins → X first by wins.
		const s = computeStandings({
			teams,
			matches: [m1, m2, m3],
			outcomes: { [m1.id]: outcome(3, 2), [m2.id]: outcome(4, 2), [m3.id]: outcome(3, 2) },
			rules: rulesWith((r) => (r.standings.order = ['totalPoints', 'headToHead'])),
			mode: 'final'
		});
		// points: X = 30+20+30 = 80, Y = 20+40+20 = 80 → tie on points; h2h X 2-1 → X first
		expect(s.records.X.totalPoints).toBe(s.records.Y.totalPoints);
		expect(s.classifications[0].rows.map((r) => [r.teamId, r.place, r.tied])).toEqual([
			['X', 1, false],
			['Y', 2, false]
		]);
	});

	it('flags ties that cannot be broken, never breaking them silently', () => {
		const teams = [team('X', '3A'), team('Y', '3A'), team('Z', '3A')];
		const m1 = match('X', 'Y');
		const m2 = match('Y', 'Z');
		const m3 = match('Z', 'X');
		// Perfect cycle with equal scores: everyone 1-1, 60 points, h2h net 0.
		const s = computeStandings({
			teams,
			matches: [m1, m2, m3],
			outcomes: { [m1.id]: outcome(4, 2), [m2.id]: outcome(4, 2), [m3.id]: outcome(4, 2) },
			rules: HS,
			mode: 'final'
		});
		const rows = s.classifications[0].rows;
		expect(rows.every((r) => r.place === 1 && r.tied)).toBe(true);
		expect(s.flags.find((f) => f.kind === 'team_tie')?.teamIds?.sort()).toEqual(['X', 'Y', 'Z']);
	});

	it('non-counter games never count, team or individual', () => {
		const teams = [team('X', '1A'), team('Y', '2A')];
		const nc = match('X', 'Y', false);
		const s = computeStandings({
			teams,
			matches: [nc],
			outcomes: { [nc.id]: outcome(9, 0, { pa: 'x1', pb: 'y1' }) },
			rules: HS,
			mode: 'final'
		});
		expect(s.records.X).toMatchObject({ played: 0, wins: 0, totalPoints: 0 });
		expect(s.individuals).toEqual([]);
		expect(s.pendingMatchIds).toEqual([]);
	});

	it('final mode uses approved rounds only; provisional includes submitted', () => {
		const teams = [team('X', '1A'), team('Y', '1A')];
		const m = match('X', 'Y');
		const o = outcome(3, 1, { status: 'submitted' });
		const final = computeStandings({ teams, matches: [m], outcomes: { [m.id]: o }, rules: HS, mode: 'final' });
		expect(final.records.X.wins).toBe(0);
		expect(final.pendingMatchIds).toEqual([m.id]);
		const prov = computeStandings({ teams, matches: [m], outcomes: { [m.id]: o }, rules: HS, mode: 'provisional' });
		expect(prov.records.X.wins).toBe(1);
	});

	it('pooled classifications play counting games but are ranked per classification', () => {
		const teams = [team('W', '1A', 'p1'), team('R', '2A', 'p1'), team('D', '3A', 'p1')];
		const m1 = match('W', 'R');
		const m2 = match('R', 'D');
		const s = computeStandings({
			teams,
			matches: [m1, m2],
			outcomes: { [m1.id]: outcome(2, 1), [m2.id]: outcome(3, 1) },
			rules: HS,
			mode: 'final'
		});
		expect(s.pools).toHaveLength(1);
		expect(s.pools[0].rows.map((r) => r.teamId)).toEqual(['R', 'W', 'D']);
		expect(s.classifications).toHaveLength(3);
		expect(s.classifications.every((g) => g.soleTeam && g.rows[0].place === 1)).toBe(true);
		expect(s.flags.filter((f) => f.kind === 'sole_team')).toHaveLength(3);
	});

	it('individual leaderboards flag ties at award places', () => {
		const teams = [team('X', '1A'), team('Y', '1A')];
		const m1 = match('X', 'Y');
		const m2 = match('Y', 'X');
		const s = computeStandings({
			teams,
			matches: [m1, m2],
			outcomes: {
				[m1.id]: outcome(3, 2, { pa: 'x1', pb: 'y1' }),
				[m2.id]: outcome(1, 0, { pa: 'y1', pb: 'x1' })
			},
			rules: HS,
			mode: 'final'
		});
		const rows = s.individuals[0].rows;
		expect(rows.map((r) => [r.playerId, r.total, r.place, r.tied, r.games])).toEqual([
			['x1', 3000, 1, true, 2],
			['y1', 3000, 1, true, 2]
		]);
		expect(s.flags.some((f) => f.kind === 'individual_tie' && f.playerIds?.length === 2)).toBe(true);
	});

	it('individual grouping can be per session or overall', () => {
		const teams = [team('X', '1A'), team('Y', '2A')];
		const m = match('X', 'Y');
		const outcomes = { [m.id]: outcome(2, 1, { pa: 'x1', pb: 'y1' }) };
		const perClass = computeStandings({ teams, matches: [m], outcomes, rules: HS, mode: 'final' });
		expect(perClass.individuals).toHaveLength(2);
		const overall = computeStandings({
			teams,
			matches: [m],
			outcomes,
			rules: rulesWith((r) => (r.awards.individualGrouping = 'overall')),
			mode: 'final'
		});
		expect(overall.individuals).toHaveLength(1);
		expect(overall.individuals[0].rows.map((r) => r.playerId)).toEqual(['x1', 'y1']);
	});

	it('a tiebreaker win counts as a round won', () => {
		const teams = [team('X', '1A'), team('Y', '1A')];
		const m = match('X', 'Y');
		const s = computeStandings({
			teams,
			matches: [m],
			outcomes: { [m.id]: outcome(2, 2, { tbWinner: 'B' }) },
			rules: HS,
			mode: 'final'
		});
		expect(s.records.Y.wins).toBe(1);
		expect(s.records.Y.totalPoints).toBe(3000);
		expect(s.records.X.losses).toBe(1);
	});

	it('flags unequal games played within a group', () => {
		const teams = [team('X', '1A'), team('Y', '1A'), team('Z', '1A')];
		const m = match('X', 'Y');
		const s = computeStandings({ teams, matches: [m], outcomes: { [m.id]: outcome(2, 1) }, rules: HS, mode: 'final' });
		expect(s.flags.some((f) => f.kind === 'unequal_games')).toBe(true);
	});
});
