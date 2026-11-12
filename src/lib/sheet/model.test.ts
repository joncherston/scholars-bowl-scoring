import { describe, expect, it } from 'vitest';
import { computeRound, HIGH_SCHOOL_DEFAULTS as HS, type EventBody, type ScoreEvent } from '$lib/engine';
import { LogBuilder, rulesWith } from '$lib/engine/testkit';
import type { ScorerMatch } from '$lib/scorer-types';
import { emptyRow, parseCell, rowChanges, rowNote, moderatorNote, sheetNotes, sheetRows, sheetSlots, sheetTotals, type SheetRow } from './model';

const player = (id: string, name: string) => ({ id, name, firstName: name.split(' ')[0], lastName: name.split(' ')[1] ?? '' });
const match = (rules = HS): ScorerMatch => ({
	id: 1,
	sessionId: 1,
	sessionName: 'Morning',
	roundNo: 1,
	time: null,
	counts: true,
	roomId: 1,
	roomName: 'Room 1',
	teams: {
		A: { id: 1, name: 'Wadley', classification: '1A', roster: ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => player(id, `Ann ${id}`)), defaultLineup: ['a1', 'a2', 'a3', 'a4'] },
		B: { id: 2, name: 'Ranburne', classification: '2A', roster: ['b1', 'b2', 'b3', 'b4'].map((id) => player(id, `Bo ${id}`)), defaultLineup: ['b1', 'b2', 'b3', 'b4'] }
	},
	rules,
	ruleVersion: 1,
	events: []
});

/** A tiny stand-in for the scorer store: applies sheet edits to a log the way the page does. */
function sheet(rules = HS, log = new LogBuilder()) {
	const m = match(rules);
	const result = () => computeRound(log.events, rules);
	const slots = () => ({ A: sheetSlots(m, result(), 'A'), B: sheetSlots(m, result(), 'B') });
	const rows = () => sheetRows(result(), slots(), rules);
	const apply = (bodies: EventBody[]) => {
		const ids = new Map<string, string>();
		for (const b of bodies) ids.set(JSON.stringify(b), log.add(b));
		return ids;
	};
	const edit = (n: number, f: (row: SheetRow) => void) => {
		if (result().status === 'not_started') apply([{ type: 'round_started', lineups: { A: slots().A.flatMap((s) => (s.playerId ? [s.playerId] : [])), B: slots().B.flatMap((s) => (s.playerId ? [s.playerId] : [])) } }]);
		const row = structuredClone(rows()[n - 1]);
		f(row);
		const changes = rowChanges(result(), n, row, slots(), rules);
		if (changes) apply(changes);
		return changes;
	};
	return { log, result, slots, rows, edit, apply };
}

describe('classic scoresheet: reading a round', () => {
	it('shows answers from the new screen in player columns, a team answer in the first empty column, and bonus points', () => {
		const log = new LogBuilder();
		log.start(['a1', 'a2', 'a3'], ['b1', 'b2', 'b3', 'b4']);
		log.wrong(1, 'B', 'b2');
		log.correct(1, 'A', 'a3');
		log.bonus(1, 'A', 20, ['correct', 'incorrect']);
		log.correct(2, 'A', null);
		log.bonus(2, 'A', 25, ['correct', 'incorrect']);
		log.dead(3);
		const s = sheet(HS, log);
		const r = s.rows();
		expect(r[0].A.players).toEqual([null, null, 1000, null, null]);
		expect(r[0].A.bonus).toBe(1000);
		expect(r[0].B.players).toEqual([null, 0, null, null, null]);
		expect(r[1].A.players).toEqual([null, null, null, 1000, null]); // no player chosen: first empty column
		expect(r[1].A.bonus).toBe(1250);
		expect(r[2]).toEqual(emptyRow());
		expect(s.slots().A.map((x) => x.name)).toEqual(['Ann a1', 'Ann a2', 'Ann a3', '', '']);
	});

	it('fills player names from the usual lineup before the round starts', () => {
		const m = match();
		expect(sheetSlots(m, null, 'A').map((x) => x.playerId)).toEqual(['a1', 'a2', 'a3', 'a4', null]);
	});
});

describe('classic scoresheet: typing in cells', () => {
	it('records typed rows as answers and bonuses that score the same as the new screen', () => {
		const s = sheet();
		s.edit(1, (row) => {
			row.A.players[1] = 1000;
			row.A.bonus = 2000;
		});
		s.edit(2, (row) => {
			row.A.players[0] = 0;
			row.B.players[3] = 1000;
			row.B.bonus = 0;
		});
		const res = s.result();
		expect(res.teams.A.roundScore).toBe(3000);
		expect(res.teams.B.roundScore).toBe(1000);
		expect(res.players.find((p) => p.playerId === 'a2')?.corrects).toBe(1);
		expect(res.players.find((p) => p.playerId === 'a1')?.incorrects).toBe(1);
		expect(res.tossups[1].answers.map((a) => [a.side, a.correct])).toEqual([
			['A', false],
			['B', true]
		]);
		expect(res.flags).toEqual([]);
		expect(s.rows()[1].B.bonus).toBe(0);
	});

	it('replaces a row when it is edited, adds only what is new, and does nothing when the value is unchanged', () => {
		const s = sheet();
		s.edit(1, (row) => (row.A.players[0] = 1000));
		expect(s.edit(1, (row) => (row.A.bonus = 2000))).toEqual([{ type: 'bonus', tossup: 1, side: 'A', value: 2000, parts: ['correct'] }]);
		expect(s.edit(1, () => {})).toEqual([]);
		const changes = s.edit(1, (row) => {
			row.A.players[0] = null;
			row.B.players[2] = 1000;
			row.A.bonus = null;
			row.B.bonus = 1000;
		})!;
		expect(changes.filter((c) => c.type === 'undo')).toHaveLength(2);
		expect(s.result().teams.A.roundScore).toBe(0);
		expect(s.result().teams.B.roundScore).toBe(2000);
		expect(s.rows()[0].B.players[2]).toBe(1000);
	});

	it('uses row 26 as the tiebreaker, with no bonus', () => {
		const s = sheet();
		s.edit(1, (row) => (row.A.players[0] = 1000));
		s.edit(2, (row) => (row.B.players[0] = 1000));
		expect(s.result().tied).toBe(true);
		s.edit(26, (row) => (row.B.players[1] = 1000));
		const res = s.result();
		expect(res.decidedByTiebreaker).toBe(true);
		expect(res.winner).toBe('B');
		expect(res.teams.B.totalPoints).toBe(1000); // tiebreaker points never count toward total points
		expect(s.rows()[25].B.players[1]).toBe(1000);
		expect(parseCell('10', 'bonus', HS, true).ok).toBe(false);
	});

	it('keeps answers in the same column when the player name at the top of a column is changed', () => {
		const s = sheet();
		s.edit(1, (row) => (row.A.players[1] = 1000));
		const slots = s.slots();
		slots.A[1] = { playerId: 'a5', name: 'Ann a5' };
		s.apply([{ type: 'lineup_set', side: 'A', players: slots.A.flatMap((x) => (x.playerId ? [x.playerId] : [])) }]);
		const changes = rowChanges(s.result(), 1, s.rows()[0], slots, HS);
		// The answer is now credited to whoever's name is at the top of column C.
		const row = emptyRow();
		row.A.players[1] = 1000;
		s.apply(rowChanges(s.result(), 1, row, slots, HS)!);
		expect(changes).not.toBeNull();
		expect(s.result().players.map((p) => p.playerId)).toEqual(['a5']);
		expect(s.slots().A[1].playerId).toBe('a5');
	});

	it('will not change a row the head scorekeeper corrected', () => {
		const s = sheet();
		s.edit(1, (row) => (row.A.players[0] = 1000));
		const target = s.result().tossups[0].answers[0].eventId;
		s.log.add({ type: 'correction', action: 'void', target, reason: 'wrong team' }, 'user:1');
		expect(rowChanges(s.result(), 1, emptyRow(), s.slots(), HS)).toBeNull();
	});

	it('accepts only the values the event allows in player columns', () => {
		expect(parseCell('10', 'player', HS, false)).toEqual({ ok: true, value: 1000 });
		expect(parseCell(' 0 ', 'player', HS, false)).toEqual({ ok: true, value: 0 });
		expect(parseCell('', 'player', HS, false)).toEqual({ ok: true, value: null });
		const bad = parseCell('15', 'player', HS, false);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.message).toBe("In a player's column, type 10 for a correct answer, 0 for a wrong answer.");
		const withPowers = rulesWith((r) => {
			r.power.enabled = true;
			r.neg.enabled = true;
		});
		expect(parseCell('15', 'player', withPowers, false)).toEqual({ ok: true, value: 1500 });
		expect(parseCell('-5', 'player', withPowers, false)).toEqual({ ok: true, value: -500 });
		expect(parseCell('12.5', 'bonus', HS, false)).toEqual({ ok: true, value: 1250 });
		expect(parseCell('-10', 'bonus', HS, false).ok).toBe(false);
	});

	it('records powers and negs when the event uses them', () => {
		const rules = rulesWith((r) => {
			r.power.enabled = true;
			r.neg.enabled = true;
		});
		const s = sheet(rules);
		s.edit(1, (row) => {
			row.A.players[0] = -500;
			row.B.players[0] = 1500;
		});
		const res = s.result();
		expect(res.teams.A.roundScore).toBe(-500);
		expect(res.teams.B.powers).toBe(1);
		expect(s.rows()[0].A.players[0]).toBe(-500);
		expect(s.rows()[0].B.players[0]).toBe(1500);
	});
});

describe('classic scoresheet: calculated cells', () => {
	it('follows the old formulas for totals, counts, bonus conversion and highlighting', () => {
		const s = sheet();
		s.edit(1, (row) => {
			row.A.players[0] = 1000;
			row.A.bonus = 2000;
		});
		s.edit(2, (row) => (row.A.players[1] = 0));
		s.edit(4, (row) => {
			row.B.players[0] = 1000;
			row.B.bonus = 1250;
		});
		const t = sheetTotals(s.rows(), s.slots(), s.result(), HS);
		expect(t.rowTotal.A.slice(0, 4)).toEqual([3000, 0, 0, 0]);
		expect(t.cumulative.A.slice(0, 4)).toEqual([3000, null, null, null]);
		expect(t.cumulative.B.slice(0, 4)).toEqual([null, null, null, 2250]);
		expect(t.count10.A).toEqual([1, 0, 0, 0, null]);
		expect(t.tuPoints.A).toEqual([1000, 0, 0, 0, null]);
		expect(t.subtotal).toEqual({ A: 1000, B: 1000 });
		expect(t.bonusTotal).toEqual({ A: 2000, B: 1250 });
		expect(t.bonusConv).toEqual({ A: 20, B: 12.5 });
		expect(t.final).toEqual({ A: 3000, B: 2250 });
		expect(t.tuState.slice(0, 5)).toEqual(['played', 'played', 'skipped', 'played', 'next']);
		expect(t.errorRows.some(Boolean)).toBe(false);
	});

	it('outlines rows the old sheet flagged: two answers on a team, both teams scoring, a bonus with no tossup', () => {
		const s = sheet();
		s.edit(1, (row) => {
			row.A.players[0] = 1000;
			row.A.players[1] = 1000;
		});
		s.edit(2, (row) => {
			row.A.players[0] = 1000;
			row.B.players[0] = 1000;
		});
		s.edit(3, (row) => (row.B.bonus = 2000));
		const t = sheetTotals(s.rows(), s.slots(), s.result(), HS);
		expect(t.errorRows.slice(0, 4)).toEqual([true, true, true, false]);
	});

	it('shows the fifth player column totals only when it is used', () => {
		const s = sheet();
		expect(sheetTotals(s.rows(), s.slots(), s.result(), HS).count10.A[4]).toBeNull();
		s.edit(1, (row) => (row.A.players[4] = 1000));
		expect(sheetTotals(s.rows(), s.slots(), s.result(), HS).count10.A[4]).toBe(1);
	});
});

describe('classic scoresheet: moderator and notes', () => {
	it('keeps the latest moderator name and row notes', () => {
		const log = new LogBuilder();
		log.add(moderatorNote('Mr. Smith'));
		log.add(rowNote(3, 'Answer was Lincoln'));
		log.add(moderatorNote('Ms. Jones'));
		const n = sheetNotes(computeRound(log.events as ScoreEvent[], HS));
		expect(n.moderator).toBe('Ms. Jones');
		expect(n.notes[2]).toBe('Answer was Lincoln');
		expect(n.notes[0]).toBe('');
	});
});
