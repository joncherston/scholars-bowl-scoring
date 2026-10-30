import { describe, expect, it } from 'vitest';
import { computeRound } from './round';
import { DEFAULT_BRACKET_FORMAT, HIGH_SCHOOL_DEFAULTS, type RuleSettings } from './rules';
import { computeStandings, summarizeRound, type MatchInfo, type MatchOutcome, type TeamInfo } from './standings';
import { LogBuilder } from './testkit';

/** Rules where the "Public 4A–7A" and "Private" divisions are brackets seeded by 3 pool-play rounds. */
const rules = (over: Partial<typeof DEFAULT_BRACKET_FORMAT> = {}): RuleSettings => {
	const r = structuredClone(HIGH_SCHOOL_DEFAULTS);
	r.format.divisions['Public 4A–7A'] = { ...DEFAULT_BRACKET_FORMAT, ...over };
	r.format.divisions['Private'] = { ...DEFAULT_BRACKET_FORMAT, ...over };
	return r;
};
const team = (id: string, classification: string, poolId: string | null = null): TeamInfo => ({ id, name: id, schoolId: id, classification, sessionId: 'pm', poolId });

/** Approved round: A answers `a` tossups (player `${A}1`), B answers `b`, 10 points each plus a 10-point bonus. */
function outcome(teamA: string, a: number, teamB: string, b: number): MatchOutcome {
	const L = new LogBuilder();
	L.start([`${teamA}1`], [`${teamB}1`]);
	let n = 0;
	for (let i = 0; i < a; i++) L.correct(++n, 'A', `${teamA}1`), L.bonus(n, 'A', 10, ['correct']);
	for (let i = 0; i < b; i++) L.correct(++n, 'B', `${teamB}1`), L.bonus(n, 'B', 10, ['correct']);
	L.end();
	L.add({ type: 'submitted', scoreA: a * 2000, scoreB: b * 2000 });
	L.add({ type: 'approved' }, 'user:1');
	return summarizeRound(computeRound(L.events, HIGH_SCHOOL_DEFAULTS));
}

function play(games: [number, string, number, string, number, string?][]) {
	const matches: MatchInfo[] = [];
	const outcomes: Record<string, MatchOutcome> = {};
	games.forEach(([roundNo, a, sa, b, sb, slot], i) => {
		const id = `g${i}`;
		matches.push({ id, sessionId: 'pm', roundNo, teamA: a, teamB: b, counts: true, stage: slot ? 'bracket' : 'pool', slot: slot ?? null });
		outcomes[id] = outcome(a, sa, b, sb);
	});
	return { matches, outcomes };
}

// Shaped like the 2026 afternoon: 3 round-robin rounds, then semifinals (1v4, 2v3), a final and a 3rd-place game.
const PM_TEAMS = [team('Ox', '5A'), team('Va', '5A'), team('Sy', '4A'), team('Au', '6A')];
const POOL: [number, string, number, string, number][] = [
	[1, 'Ox', 14, 'Va', 4], [1, 'Au', 11, 'Sy', 6],
	[2, 'Ox', 6, 'Sy', 9], [2, 'Au', 20, 'Va', 1],
	[3, 'Va', 5, 'Sy', 6], [3, 'Au', 10, 'Ox', 9]
];

describe('bracket divisions', () => {
	it('seeds from pool play by win ratio then points, and places from the bracket (the final winner is champion)', () => {
		const { matches, outcomes } = play([...POOL, [4, 'Au', 12, 'Va', 4, 'SF1'], [4, 'Sy', 6, 'Ox', 13, 'SF2'], [5, 'Au', 7, 'Ox', 8, 'F'], [5, 'Sy', 4, 'Va', 1, '3P']]);
		const s = computeStandings({ teams: PM_TEAMS, matches, outcomes, rules: rules(), mode: 'final' });
		const d = s.divisions.find((g) => g.division === 'Public 4A–7A')!;
		expect(d.format).toBe('bracket');
		// Pool play: Au 3–0, Sy 2–1, Ox 1–2 (580), Va 0–3.
		expect(d.seeds!.map((x) => [x.teamId, x.seed])).toEqual([['Au', 1], ['Sy', 2], ['Ox', 3], ['Va', 4]]);
		// Oxford wins the final, so Oxford is 1st even though Auburn has more wins overall.
		expect(d.rows.map((r) => [r.teamId, r.place, r.bracketResult])).toEqual([
			['Ox', 1, 'Champion'],
			['Au', 2, 'Runner-up'],
			['Sy', 3, 'Won 3rd-place game'],
			['Va', 4, 'Lost 3rd-place game']
		]);
		expect(s.records.Au.wins).toBe(4); // records still include bracket games
		expect(s.flags.filter((f) => f.kind === 'seed_tie' || f.kind === 'team_tie')).toEqual([]);
	});

	it('shows pending bracket places until the bracket games are final', () => {
		const { matches, outcomes } = play([...POOL, [4, 'Au', 12, 'Va', 4, 'SF1'], [4, 'Sy', 6, 'Ox', 13, 'SF2']]);
		const s = computeStandings({ teams: PM_TEAMS, matches, outcomes, rules: rules(), mode: 'final' });
		const d = s.divisions[0];
		expect(d.rows.map((r) => [r.teamId, r.place, r.pending ?? false])).toEqual([
			['Au', 1, true],
			['Sy', 2, true],
			['Ox', 3, true],
			['Va', 4, true]
		]);
	});

	it('bracket games can be left out of individual totals', () => {
		const { matches, outcomes } = play([...POOL, [4, 'Au', 12, 'Va', 4, 'SF1']]);
		const withB = computeStandings({ teams: PM_TEAMS, matches, outcomes, rules: rules(), mode: 'final' });
		const without = computeStandings({ teams: PM_TEAMS, matches, outcomes, rules: rules({ bracketCountsForIndividuals: false }), mode: 'final' });
		const au = (s: typeof withB) => s.individuals.flatMap((g) => g.rows).find((r) => r.playerId === 'Au1')!.total;
		expect(au(withB)).toBe((11 + 20 + 10 + 12) * 1000);
		expect(au(without)).toBe((11 + 20 + 10) * 1000);
	});

	it('a seeding tie inside the bracket is flagged and can be decided by the head scorekeeper', () => {
		// P and Q both 1–1 with equal points and they split head-to-head: no criterion separates them.
		const teams = [team('P', 'Private'), team('Q', 'Private'), team('R', 'Private'), team('S', 'Private')];
		const { matches, outcomes } = play([[1, 'P', 10, 'Q', 5], [2, 'Q', 10, 'P', 5], [1, 'R', 9, 'S', 1], [2, 'S', 1, 'R', 9]]);
		const s = computeStandings({ teams, matches, outcomes, rules: rules(), mode: 'final' });
		expect(s.flags.find((f) => f.kind === 'seed_tie')?.teamIds?.sort()).toEqual(['P', 'Q']);
		const r = computeStandings({ teams, matches, outcomes, rules: rules(), mode: 'final', seedResolutions: [{ groupKey: 'seed:Private', ordered: ['Q', 'P'] }] });
		expect(r.flags.some((f) => f.kind === 'seed_tie')).toBe(false);
		expect(r.divisions[0].seeds!.map((x) => x.teamId)).toEqual(['R', 'Q', 'P', 'S']);
	});

	it('pool winners first: each pool winner is seeded ahead of the best runner-up', () => {
		// Pool A: A1 beats A2 narrowly. Pool B: B1 beats B2. A2 has more points than B1 but did not win its pool.
		const teams = [team('A1', 'Private', 'a'), team('A2', 'Private', 'a'), team('B1', 'Private', 'b'), team('B2', 'Private', 'b')];
		const { matches, outcomes } = play([[1, 'A1', 21, 'A2', 20], [1, 'B1', 6, 'B2', 1]]);
		const std = computeStandings({ teams, matches, outcomes, rules: rules(), mode: 'final' });
		expect(std.divisions[0].seeds!.map((x) => x.teamId)).toEqual(['A1', 'B1', 'A2', 'B2']);
		const pw = computeStandings({ teams, matches, outcomes, rules: rules({ seeding: 'poolWinnersFirst' }), mode: 'final' });
		expect(pw.divisions[0].seeds!.map((x) => x.teamId)).toEqual(['A1', 'B1', 'A2', 'B2']);
		// Make A2 out-score B1 with a win elsewhere: standings seeding puts A2 above B1 only by win ratio.
		const { matches: m2, outcomes: o2 } = play([[1, 'A1', 21, 'A2', 20], [1, 'B1', 6, 'B2', 1], [2, 'A2', 30, 'B2', 1], [2, 'B1', 2, 'A1', 3]]);
		const st2 = computeStandings({ teams, matches: m2, outcomes: o2, rules: rules(), mode: 'final' });
		expect(st2.divisions[0].seeds!.map((x) => x.teamId)).toEqual(['A1', 'A2', 'B1', 'B2']);
		const pw2 = computeStandings({ teams, matches: m2, outcomes: o2, rules: rules({ seeding: 'poolWinnersFirst' }), mode: 'final' });
		expect(pw2.divisions[0].seeds!.map((x) => x.teamId)).toEqual(['A1', 'B1', 'A2', 'B2']);
	});

	it('ranks by win ratio, so a team with fewer games is not punished for a bye', () => {
		const r = structuredClone(HIGH_SCHOOL_DEFAULTS);
		r.standings.order = ['winPct', 'totalPoints', 'headToHead'];
		const teams = [team('X', '1A'), team('Y', '1A'), team('Z', '1A')];
		// X 2–1 (3 games), Y 1–0 (1 game).
		const { matches, outcomes } = play([[1, 'X', 5, 'Z', 1], [2, 'X', 5, 'Z', 1], [3, 'Z', 5, 'X', 1], [3, 'Y', 2, 'Z', 1]]);
		const s = computeStandings({ teams, matches, outcomes, rules: r, mode: 'final' });
		expect(s.divisions[0].rows.map((x) => x.teamId)).toEqual(['Y', 'X', 'Z']);
	});
});

describe('classification awards', () => {
	it('follow the division order: 1st and 2nd within each classification', async () => {
		const { classAwards } = await import('./standings');
		const { matches, outcomes } = play([...POOL, [4, 'Au', 12, 'Va', 4, 'SF1'], [4, 'Sy', 6, 'Ox', 13, 'SF2'], [5, 'Au', 7, 'Ox', 8, 'F'], [5, 'Sy', 4, 'Va', 1, '3P']]);
		const s = computeStandings({ teams: PM_TEAMS, matches, outcomes, rules: rules(), mode: 'final' });
		const ca = classAwards(s.divisions, PM_TEAMS);
		const get = (c: string) => ca.find((x) => x.classification === c)!.rows.map((r) => [r.teamId, r.place]);
		expect(get('5A')).toEqual([['Ox', 1], ['Va', 2]]);
		expect(get('6A')).toEqual([['Au', 1]]);
		expect(get('4A')).toEqual([['Sy', 1]]);
	});
});
