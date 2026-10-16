import { describe, expect, it } from 'vitest';
import { bonusShare, formatPoints, parsePoints } from './points';
import { HIGH_SCHOOL_DEFAULTS as HS } from './rules';
import { computeRound } from './round';
import { LogBuilder, rulesWith } from './testkit';

const kinds = (r: ReturnType<typeof computeRound>) => r.flags.map((f) => f.kind);

describe('points math (integer hundredths)', () => {
	it('splits bonuses proportionally per part', () => {
		expect(bonusShare(2000, 2, 1, 'exact').points).toBe(1000); // 20-pt, 2 parts, 1 right = 10
		expect(bonusShare(2000, 4, 3, 'exact').points).toBe(1500); // 3/4 of 20 = 15
		expect(bonusShare(3000, 3, 3, 'exact').points).toBe(3000);
		expect(bonusShare(3000, 3, 0, 'exact').points).toBe(0);
	});

	it('handles fractional shares per the rounding rule and reports them', () => {
		const exact = bonusShare(2500, 2, 1, 'exact');
		expect(exact.points).toBe(1250);
		expect(exact.fractional).toBe(true);
		expect(exact.inexact).toBe(false);
		expect(bonusShare(2500, 2, 1, 'half_up').points).toBe(1300);
		expect(bonusShare(2500, 2, 1, 'down').points).toBe(1200);
		expect(bonusShare(2500, 4, 1, 'half_up').points).toBe(600); // 6.25 → 6
		expect(bonusShare(1000, 4, 1, 'half_up').points).toBe(300); // 2.5 → 3
	});

	it('flags shares that cannot be exact in hundredths (thirds)', () => {
		const s = bonusShare(1000, 3, 1, 'exact');
		expect(s.points).toBe(333);
		expect(s.inexact).toBe(true);
		expect(bonusShare(1000, 3, 2, 'exact').points).toBe(667);
		expect(bonusShare(1000, 3, 1, 'down').points).toBe(300);
	});

	it('rejects invalid input instead of guessing', () => {
		expect(() => bonusShare(1000, 0, 0, 'exact')).toThrow();
		expect(() => bonusShare(1000, 2, 3, 'exact')).toThrow();
		expect(() => bonusShare(10.5, 2, 1, 'exact')).toThrow();
	});

	it('formats and parses points', () => {
		expect(formatPoints(1250)).toBe('12.5');
		expect(formatPoints(1000)).toBe('10');
		expect(formatPoints(-500)).toBe('-5');
		expect(formatPoints(333)).toBe('3.33');
		expect(formatPoints(5)).toBe('0.05');
		expect(parsePoints('12.5')).toBe(1250);
		expect(parsePoints(' 20 ')).toBe(2000);
		expect(parsePoints('7.25')).toBe(725);
		expect(parsePoints('abc')).toBeNull();
		expect(parsePoints('1.234')).toBeNull();
	});
});

describe('computeRound: tossups and bonuses', () => {
	it('scores a simple round', () => {
		const L = new LogBuilder();
		L.start();
		L.correct(1, 'A', 'a1');
		L.bonus(1, 'A', 20, ['correct', 'incorrect']);
		L.wrong(2, 'A', 'a2');
		L.correct(2, 'B', 'b1');
		L.bonus(2, 'B', 30, ['correct', 'correct', 'correct']);
		L.dead(3);
		const r = computeRound(L.events, HS);
		expect(r.teams.A.roundScore).toBe(2000);
		expect(r.teams.B.roundScore).toBe(4000);
		expect(r.winner).toBe('B');
		expect(r.tossups.map((t) => t.running)).toEqual([
			{ A: 2000, B: 0 },
			{ A: 2000, B: 4000 },
			{ A: 2000, B: 4000 }
		]);
		expect(r.currentTossup).toEqual({ number: 4, tiebreaker: false });
		expect(r.status).toBe('in_progress');
		expect(r.flags).toEqual([]);
	});

	it('individual scores are tossups only by default; bonuses are team points', () => {
		const L = new LogBuilder();
		L.start();
		L.correct(1, 'A', 'a1');
		L.bonus(1, 'A', 30, ['correct', 'correct', 'correct']);
		const r = computeRound(L.events, HS);
		const a1 = r.players.find((p) => p.playerId === 'a1')!;
		expect(a1.individualTotal).toBe(1000);
		expect(a1.bonusPoints).toBe(3000);
		const withBonus = computeRound(L.events, rulesWith((x) => (x.individual.includeBonus = true)));
		expect(withBonus.players.find((p) => p.playerId === 'a1')!.individualTotal).toBe(4000);
	});

	it('tracks tossup state for the scorer', () => {
		const L = new LogBuilder();
		L.start();
		L.wrong(1, 'A', 'a1');
		expect(computeRound(L.events, HS).tossups[0].state).toBe('open');
		expect(computeRound(L.events, HS).currentTossup.number).toBe(1);
		L.correct(1, 'B', 'b2');
		expect(computeRound(L.events, HS).tossups[0].state).toBe('awaiting_bonus');
		L.bonus(1, 'B', 10, ['incorrect']);
		expect(computeRound(L.events, HS).tossups[0].state).toBe('complete');
		L.wrong(2, 'A', 'a1');
		L.wrong(2, 'B', 'b1');
		const r = computeRound(L.events, HS);
		expect(r.tossups[1].state).toBe('complete');
		expect(r.currentTossup.number).toBe(3);
	});

	it('applies powers and negs only when enabled', () => {
		const L = new LogBuilder();
		L.start();
		L.correct(1, 'A', 'a1', { power: true, interrupt: true });
		L.wrong(2, 'B', 'b1', { interrupt: true });
		L.correct(2, 'A', 'a2');
		L.wrong(3, 'B', 'b1');
		L.dead(3);
		const off = computeRound(L.events, HS);
		expect(off.teams.A.roundScore).toBe(2000);
		expect(off.teams.B.roundScore).toBe(0);

		const on = computeRound(
			L.events,
			rulesWith((r) => {
				r.power.enabled = true;
				r.neg.enabled = true;
			})
		);
		expect(on.teams.A.roundScore).toBe(2500); // 15 power + 10
		expect(on.teams.B.roundScore).toBe(-500); // neg only on the interrupt
		expect(on.players.find((p) => p.playerId === 'b1')!.individualTotal).toBe(-500);

		const negAlways = computeRound(
			L.events,
			rulesWith((r) => {
				r.neg.enabled = true;
				r.neg.onlyOnInterrupt = false;
			})
		);
		expect(negAlways.teams.B.roundScore).toBe(-1000);
	});

	it('supports bounceback parts when enabled', () => {
		const L = new LogBuilder();
		L.start();
		L.correct(1, 'A', 'a1');
		L.bonus(1, 'A', 30, ['correct', 'bounceback', 'incorrect']);
		const on = computeRound(L.events, rulesWith((r) => (r.bonus.bounceback = true)));
		expect(on.teams.A.roundScore).toBe(2000);
		expect(on.teams.B.roundScore).toBe(1000);
		expect(kinds(on)).toEqual([]);
		expect(kinds(computeRound(L.events, HS))).toContain('bounceback_disabled');
	});

	it('flags fractional bonuses in the audit', () => {
		const L = new LogBuilder();
		L.start();
		L.correct(1, 'A', 'a1');
		L.bonus(1, 'A', 25, ['correct', 'incorrect']);
		const r = computeRound(L.events, HS);
		expect(r.teams.A.roundScore).toBe(2250);
		expect(r.tossups[0].bonuses[0].fractional).toBe(true);
		expect(kinds(r)).toContain('fractional_bonus');
		const rounded = computeRound(L.events, rulesWith((x) => (x.bonus.rounding = 'half_up')));
		expect(rounded.teams.A.roundScore).toBe(2300);
		expect(kinds(rounded)).toContain('fractional_bonus');
	});

	it('flags impossible sequences instead of hiding them', () => {
		const L = new LogBuilder();
		L.start();
		L.correct(1, 'A', 'a1');
		L.correct(1, 'B', 'b1');
		L.bonus(2, 'A', 10, ['correct']);
		L.correct(3, 'A', null);
		L.dead(4);
		L.correct(4, 'A', 'a9');
		const r = computeRound(L.events, HS);
		expect(kinds(r)).toEqual(
			expect.arrayContaining(['multiple_correct', 'bonus_without_correct', 'unattributed_answer', 'dead_with_correct', 'player_not_in_lineup'])
		);
	});
});

describe('computeRound: tiebreakers', () => {
	const tiedRound = () => {
		const L = new LogBuilder();
		L.start();
		L.correct(1, 'A', 'a1');
		L.bonus(1, 'A', 10, ['correct']);
		L.correct(2, 'B', 'b1');
		L.bonus(2, 'B', 10, ['correct']);
		L.end();
		return L;
	};

	it('detects a tied round', () => {
		const r = computeRound(tiedRound().events, HS);
		expect(r.tied).toBe(true);
		expect(r.winner).toBeNull();
		expect(kinds(r)).toContain('tied_without_tiebreaker');
	});

	it('first correct tiebreaker answer wins; points count for team, not individual (defaults)', () => {
		const L = tiedRound();
		L.add({ type: 'tiebreaker_started' });
		L.wrong(1, 'A', 'a2', { tiebreaker: true });
		L.correct(1, 'B', 'b3', { tiebreaker: true });
		const r = computeRound(L.events, HS);
		expect(r.winner).toBe('B');
		expect(r.decidedByTiebreaker).toBe(true);
		expect(r.teams.B.roundScore).toBe(3000);
		expect(r.teams.B.totalPoints).toBe(3000);
		expect(r.teams.B.tiebreakerPoints).toBe(1000);
		const b3 = r.players.find((p) => p.playerId === 'b3')!;
		expect(b3.individualTotal).toBe(0);
		expect(b3.tiebreakerPoints).toBe(1000);
		expect(kinds(r)).not.toContain('tied_without_tiebreaker');
		expect(r.tossups.at(-1)!.running).toEqual({ A: 2000, B: 3000 });
	});

	it('tiebreaker point settings are independent', () => {
		const L = tiedRound();
		L.add({ type: 'tiebreaker_started' });
		L.correct(1, 'A', 'a1', { tiebreaker: true });
		const r = computeRound(
			L.events,
			rulesWith((x) => {
				x.tiebreaker.countsInRoundScore = false;
				x.tiebreaker.countsInTotalPoints = false;
				x.individual.includeTiebreaker = true;
			})
		);
		expect(r.winner).toBe('A');
		expect(r.teams.A.roundScore).toBe(2000);
		expect(r.teams.A.totalPoints).toBe(2000);
		expect(r.players.find((p) => p.playerId === 'a1')!.individualTotal).toBe(2000);
	});

	it('a dead tiebreaker tossup leads to another', () => {
		const L = tiedRound();
		L.add({ type: 'tiebreaker_started' });
		expect(computeRound(L.events, HS).currentTossup).toEqual({ number: 1, tiebreaker: true });
		L.dead(1, true);
		const r = computeRound(L.events, HS);
		expect(r.currentTossup).toEqual({ number: 2, tiebreaker: true });
		expect(r.tied).toBe(true);
	});
});

describe('computeRound: undo and corrections never delete', () => {
	it('undo voids the target; undo chains walk backward', () => {
		const L = new LogBuilder();
		L.start();
		const c1 = L.correct(1, 'A', 'a1');
		const b1 = L.bonus(1, 'A', 20, ['correct', 'correct']);
		const c2 = L.correct(2, 'B', 'b1');
		L.undo(c2);
		L.undo(b1);
		L.undo(c1);
		const r = computeRound(L.events, HS);
		expect(r.teams.A.roundScore).toBe(0);
		expect(r.teams.B.roundScore).toBe(0);
		expect(r.audit).toHaveLength(7);
		expect(r.audit.filter((a) => !a.active).map((a) => a.event.id)).toEqual([c1, b1, c2]);
		expect(r.currentTossup.number).toBe(1);
	});

	it('undoing an undo restores the original event', () => {
		const L = new LogBuilder();
		L.start();
		const c1 = L.correct(1, 'A', 'a1');
		const u = L.undo(c1);
		L.undo(u);
		const r = computeRound(L.events, HS);
		expect(r.teams.A.roundScore).toBe(1000);
		expect(r.audit.find((a) => a.event.id === c1)!.active).toBe(true);
	});

	it('double undo of the same event is flagged and ignored', () => {
		const L = new LogBuilder();
		L.start();
		const c1 = L.correct(1, 'A', 'a1');
		L.undo(c1);
		L.undo(c1);
		const r = computeRound(L.events, HS);
		expect(kinds(r)).toContain('already_voided');
		expect(r.teams.A.roundScore).toBe(0);
	});

	it('corrections void, amend, and add with reasons; voiding a correction restores', () => {
		const L = new LogBuilder();
		L.start();
		L.correct(1, 'A', 'a1');
		const bonus = L.bonus(1, 'A', 20, ['correct', 'incorrect']);
		L.correct(2, 'B', 'b1');
		L.end();
		L.add({ type: 'submitted', scoreA: 2000, scoreB: 1000 });
		const amend = L.add(
			{
				type: 'correction',
				action: 'amend',
				target: bonus,
				replacement: { type: 'bonus', tossup: 1, side: 'A', value: 2000, parts: ['correct', 'correct'] },
				reason: 'Coach sheet shows both parts correct'
			},
			'user:7'
		);
		let r = computeRound(L.events, HS);
		expect(r.teams.A.roundScore).toBe(3000);
		expect(r.tossups[0].bonuses[0].amended).toBe(true);
		expect(kinds(r)).toEqual(expect.arrayContaining(['edited_after_submission', 'submitted_score_mismatch']));

		L.add(
			{
				type: 'correction',
				action: 'add',
				replacement: { type: 'bonus', tossup: 2, side: 'B', value: 1000, parts: ['correct'] },
				reason: 'Bonus was read but not entered'
			},
			'user:7'
		);
		r = computeRound(L.events, HS);
		expect(r.teams.B.roundScore).toBe(2000);

		L.add({ type: 'correction', action: 'void', target: amend, reason: 'Amended the wrong tossup' }, 'user:7');
		r = computeRound(L.events, HS);
		expect(r.teams.A.roundScore).toBe(2000);
		expect(r.audit.find((a) => a.event.id === bonus)!.active).toBe(true);
	});

	it('amended answers keep their position within the tossup', () => {
		const L = new LogBuilder();
		L.start();
		const first = L.wrong(1, 'A', 'a1');
		L.correct(1, 'B', 'b1');
		L.add({
			type: 'correction',
			action: 'amend',
			target: first,
			replacement: { type: 'tossup_answer', tossup: 1, side: 'A', playerId: 'a2', correct: false },
			reason: 'Wrong player recorded'
		});
		const r = computeRound(L.events, HS);
		expect(r.tossups[0].answers.map((a) => a.playerId)).toEqual(['a2', 'b1']);
		expect(r.flags).toEqual([]);
	});

	it('round lifecycle: ended, submitted, approved, and corrections require re-approval', () => {
		const L = new LogBuilder();
		L.start();
		const c = L.correct(1, 'A', 'a1');
		L.bonus(1, 'A', 10, ['correct']);
		const end = L.end();
		expect(computeRound(L.events, HS).status).toBe('ended');
		L.undo(end);
		expect(computeRound(L.events, HS).status).toBe('in_progress');
		L.end('All tossups read');
		L.add({ type: 'submitted', scoreA: 2000, scoreB: 0 });
		expect(computeRound(L.events, HS).status).toBe('submitted');
		L.add({ type: 'approved' }, 'user:1');
		let r = computeRound(L.events, HS);
		expect(r.status).toBe('approved');
		expect(r.endReason).toBe('All tossups read');
		expect(r.flags).toEqual([]);
		L.add({ type: 'correction', action: 'void', target: c, reason: 'Answer was accepted in error' }, 'user:1');
		r = computeRound(L.events, HS);
		expect(r.status).toBe('submitted');
		L.add({ type: 'approved' }, 'user:1');
		expect(computeRound(L.events, HS).status).toBe('approved');
	});

	it('is independent of input order (sorted by seq)', () => {
		const L = new LogBuilder();
		L.start();
		L.correct(1, 'A', 'a1');
		L.bonus(1, 'A', 20, ['correct', 'incorrect']);
		const r1 = computeRound(L.events, HS);
		const r2 = computeRound([...L.events].reverse(), HS);
		expect(r2.teams).toEqual(r1.teams);
	});
});
