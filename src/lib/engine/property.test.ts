import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HIGH_SCHOOL_DEFAULTS, type RuleSettings } from './rules';
import { computeRound } from './round';
import type { BonusPart, EventBody, ScoreEvent, Side } from './types';

/** Random rule settings covering every scoring switch. */
const rulesArb: fc.Arbitrary<RuleSettings> = fc
	.record({
		power: fc.boolean(),
		neg: fc.boolean(),
		negOnInterrupt: fc.boolean(),
		bounceback: fc.boolean(),
		rounding: fc.constantFrom('exact', 'half_up', 'down') as fc.Arbitrary<RuleSettings['bonus']['rounding']>,
		includeBonus: fc.boolean(),
		includeTb: fc.boolean(),
		tbRound: fc.boolean(),
		tbTotal: fc.boolean()
	})
	.map((o) => {
		const r = structuredClone(HIGH_SCHOOL_DEFAULTS);
		r.power.enabled = o.power;
		r.neg.enabled = o.neg;
		r.neg.onlyOnInterrupt = o.negOnInterrupt;
		r.bonus.bounceback = o.bounceback;
		r.bonus.rounding = o.rounding;
		r.individual.includeBonus = o.includeBonus;
		r.individual.includeTiebreaker = o.includeTb;
		r.tiebreaker.countsInRoundScore = o.tbRound;
		r.tiebreaker.countsInTotalPoints = o.tbTotal;
		return r;
	});

const side = fc.constantFrom<Side>('A', 'B');
const player = (s: Side) => fc.option(fc.constantFrom(`${s}1`, `${s}2`, `${s}3`, `${s}4`), { nil: null, freq: 6 });

/** Arbitrary scoring actions, including nonsense sequences: the engine must stay consistent anyway. */
const actionArb: fc.Arbitrary<{ kind: string; body?: EventBody; undoIndex?: number }> = fc.oneof(
	{ weight: 5, arbitrary: fc.record({ tossup: fc.integer({ min: 1, max: 26 }), tb: fc.boolean(), s: side, correct: fc.boolean(), interrupt: fc.boolean(), power: fc.boolean() }).chain((o) =>
		player(o.s).map((p) => ({
			kind: 'answer',
			body: { type: 'tossup_answer', tossup: o.tossup, tiebreaker: o.tb && o.tossup < 4, side: o.s, playerId: p, correct: o.correct, interrupt: o.interrupt, power: o.power } as EventBody
		}))
	) },
	{ weight: 3, arbitrary: fc.record({
		tossup: fc.integer({ min: 1, max: 26 }),
		s: side,
		value: fc.oneof(fc.constantFrom(1000, 2000, 2500, 3000), fc.integer({ min: 0, max: 9999 })),
		parts: fc.array(fc.constantFrom<BonusPart>('correct', 'incorrect', 'bounceback'), { minLength: 1, maxLength: 5 })
	}).map((o) => ({ kind: 'bonus', body: { type: 'bonus', tossup: o.tossup, side: o.s, value: o.value, parts: o.parts } as EventBody })) },
	{ weight: 1, arbitrary: fc.integer({ min: 1, max: 26 }).map((t) => ({ kind: 'dead', body: { type: 'tossup_dead', tossup: t } as EventBody })) },
	{ weight: 2, arbitrary: fc.nat().map((i) => ({ kind: 'undo', undoIndex: i })) },
	{ weight: 1, arbitrary: fc.nat().map((i) => ({ kind: 'void', undoIndex: i })) }
);

function buildLog(actions: { kind: string; body?: EventBody; undoIndex?: number }[]): ScoreEvent[] {
	const events: ScoreEvent[] = [
		{ id: 'start', seq: 1, actor: 'room:1', body: { type: 'round_started', lineups: { A: ['A1', 'A2', 'A3', 'A4'], B: ['B1', 'B2', 'B3', 'B4'] } } }
	];
	for (const a of actions) {
		const seq = events.length + 1;
		const id = `e${seq}`;
		if (a.body) events.push({ id, seq, actor: 'room:1', body: a.body });
		else {
			const target = events[a.undoIndex! % events.length].id;
			const body: EventBody =
				a.kind === 'undo' ? { type: 'undo', target } : { type: 'correction', action: 'void', target, reason: 'test' };
			events.push({ id, seq, actor: a.kind === 'undo' ? 'room:1' : 'user:1', body });
		}
	}
	return events;
}

describe('property: totals always equal the sum of their parts', () => {
	it('team scores, tossup lines, running totals, and player totals agree', () => {
		fc.assert(
			fc.property(fc.array(actionArb, { maxLength: 80 }), rulesArb, (actions, rules) => {
				const r = computeRound(buildLog(actions), rules);
				// Tiebreaker points count only when regulation is level (a correction can break the tie).
				const regulation = (s: 'A' | 'B') => r.teams[s].tossupPoints + r.teams[s].negPoints + r.teams[s].bonusPoints + r.teams[s].bouncebackPoints;
				const tbCounts = regulation('A') === regulation('B');
				for (const s of ['A', 'B'] as const) {
					const t = r.teams[s];
					// Round score is the sum of what each tossup line added.
					const lineSum = r.tossups.reduce((acc, l) => acc + l.points[s], 0);
					expect(t.roundScore).toBe(lineSum);
					// Running score after the last tossup equals the round score.
					expect(r.tossups.length ? r.tossups.at(-1)!.running[s] : 0).toBe(t.roundScore);
					// Round score is the sum of its components.
					expect(t.roundScore).toBe(
						t.tossupPoints + t.negPoints + t.bonusPoints + t.bouncebackPoints + (rules.tiebreaker.countsInRoundScore && tbCounts ? t.tiebreakerPoints : 0)
					);
					// Answer-level points add up to the team's tossup, neg, and tiebreaker points.
					let answerPts = 0;
					let tbPts = 0;
					for (const l of r.tossups)
						for (const a of l.answers) if (a.side === s) l.tiebreaker ? (tbPts += a.points) : (answerPts += a.points);
					expect(t.tossupPoints + t.negPoints).toBe(answerPts);
					expect(t.tiebreakerPoints).toBe(tbPts);
					// Player tossup points plus unattributed answers equal the team's.
					const playerPts = r.players.filter((p) => p.side === s).reduce((acc, p) => acc + p.tossupPoints + p.negPoints, 0);
					const unattributed = r.tossups
						.filter((l) => !l.tiebreaker)
						.flatMap((l) => l.answers)
						.filter((a) => a.side === s && !a.playerId)
						.reduce((acc, a) => acc + a.points, 0);
					expect(playerPts + unattributed).toBe(t.tossupPoints + t.negPoints);
					// Every value is an integer number of hundredths.
					for (const v of Object.values(t)) expect(Number.isInteger(v)).toBe(true);
				}
				for (const p of r.players) {
					expect(p.individualTotal).toBe(
						p.tossupPoints +
							p.negPoints +
							(rules.individual.includeBonus ? p.bonusPoints : 0) +
							(rules.individual.includeTiebreaker && tbCounts ? p.tiebreakerPoints : 0)
					);
				}
				// The audit lists every event exactly once.
				expect(r.audit).toHaveLength(actions.length + 1);
			}),
			{ numRuns: 1500 }
		);
	});

	it('undoing every action, newest first, returns the round to zero', () => {
		fc.assert(
			fc.property(fc.array(actionArb.filter((a) => !!a.body), { maxLength: 40 }), rulesArb, (actions, rules) => {
				const log = buildLog(actions);
				const ids = log.slice(1).map((e) => e.id).reverse();
				let seq = log.length;
				for (const target of ids) log.push({ id: `u${++seq}`, seq, actor: 'room:1', body: { type: 'undo', target } });
				const r = computeRound(log, rules);
				expect(r.teams.A.roundScore).toBe(0);
				expect(r.teams.B.roundScore).toBe(0);
				expect(r.tossups).toEqual([]);
			}),
			{ numRuns: 500 }
		);
	});

	it('scores never depend on the order events are passed in', () => {
		fc.assert(
			fc.property(fc.array(actionArb, { maxLength: 40 }), rulesArb, fc.integer(), (actions, rules, seed) => {
				const log = buildLog(actions);
				const shuffled = [...log].sort((a, b) => ((a.seq * 7919 + seed) % 101) - ((b.seq * 7919 + seed) % 101));
				expect(computeRound(shuffled, rules).teams).toEqual(computeRound(log, rules).teams);
			}),
			{ numRuns: 300 }
		);
	});
});
