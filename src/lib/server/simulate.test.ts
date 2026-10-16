import { computeRound, HIGH_SCHOOL_DEFAULTS, type ScoreEvent } from '$lib/engine';
import { describe, expect, it } from 'vitest';
import { scriptGame } from './simulate';

describe('simulation scripts', () => {
	it('produce clean, plausible rounds', () => {
		for (let seed = 1; seed < 200; seed++) {
			const bodies = scriptGame({ A: ['a1', 'a2', 'a3', 'a4'], B: ['b1', 'b2', 'b3', 'b4'] }, HIGH_SCHOOL_DEFAULTS, seed);
			const events: ScoreEvent[] = bodies.map((body, i) => ({ id: `e${i}`, seq: i + 1, body, actor: 'room:1' }));
			const r = computeRound(events, HIGH_SCHOOL_DEFAULTS);
			expect(r.flags.filter((f) => f.kind !== 'fractional_bonus' && f.kind !== 'inexact_bonus')).toEqual([]);
			expect(r.lastRegularTossup).toBeGreaterThanOrEqual(16);
			expect(r.lastRegularTossup).toBeLessThanOrEqual(25);
			expect(r.tossups.every((t) => t.state === 'complete')).toBe(true);
		}
	});
});
