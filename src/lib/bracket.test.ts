import { describe, expect, it } from 'vitest';
import { bracketPlan, effectiveBracketSize } from './bracket';
import { DEFAULT_BRACKET_FORMAT as F } from './engine/rules';

describe('bracketPlan', () => {
	it('4-team bracket: semifinals 1v4 and 2v3, then the final and the 3rd-place game', () => {
		const p = bracketPlan(F, 4);
		expect(p.map((s) => [s.slot, s.bracketRound, s.sourceA, s.sourceB, s.counts])).toEqual([
			['SF1', 1, 'seed:1', 'seed:4', true],
			['SF2', 1, 'seed:2', 'seed:3', true],
			['F', 2, 'winner:SF1', 'winner:SF2', true],
			['3P', 2, 'loser:SF1', 'loser:SF2', true]
		]);
	});

	it('9 private teams (2026): the other five play non-counters with new opponents each round', () => {
		const p = bracketPlan(F, 9).filter((s) => !s.counts);
		expect(p.map((s) => [s.bracketRound, s.sourceA, s.sourceB])).toEqual([
			[1, 'seed:5', 'seed:6'],
			[1, 'seed:7', 'seed:8'],
			[2, 'seed:5', 'seed:8'],
			[2, 'seed:9', 'seed:7']
		]);
	});

	it('fits the bracket to the teams', () => {
		expect(effectiveBracketSize(4, 3)).toBe(2);
		expect(effectiveBracketSize(8, 6)).toBe(4);
		expect(effectiveBracketSize(4, 1)).toBe(0);
		expect(bracketPlan({ ...F, bracketSize: 8, fillNonCounters: false }, 8).map((s) => s.slot)).toEqual(['QF1', 'QF2', 'QF3', 'QF4', 'SF1', 'SF2', 'F', '3P']);
		expect(bracketPlan({ ...F, thirdPlaceGame: false }, 4).map((s) => s.slot)).toEqual(['SF1', 'SF2', 'F']);
	});
});
