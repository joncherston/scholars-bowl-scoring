import { describe, expect, it } from 'vitest';
import { computeRound, HIGH_SCHOOL_DEFAULTS as HS, type EventBody } from '$lib/engine';
import { LogBuilder } from '$lib/engine/testkit';
import type { ScorerMatch } from '$lib/scorer-types';
import { buildPlan, exactPlayer, exactTeam, likeness, usedColumns, type ParsedSheet, type RawCell } from './import';
import { rowChanges, SHEET_TOSSUPS, sheetRows, sheetSlots } from './model';

const player = (id: string, first: string, last: string) => ({ id, name: `${first} ${last}`, firstName: first, lastName: last });
const match: ScorerMatch = {
	id: 1,
	sessionId: 1,
	sessionName: 'Morning',
	roundNo: 2,
	time: null,
	counts: true,
	roomId: 1,
	roomName: 'Room 3',
	teams: {
		A: { id: 1, name: 'Riverbend Christian B', classification: 'Private', roster: [player('k', 'Kendall', 'Fairbanks'), player('p', 'Parker', 'Yarborough')], defaultLineup: ['k', 'p'] },
		B: { id: 2, name: 'Fox Run High School', classification: '4A', roster: [player('f', 'Finley', 'Fairbanks'), player('b', 'Blake', 'Fairbanks'), player('m', 'Morgan', 'Pemberton')], defaultLineup: ['f', 'b'] }
	},
	rules: HS,
	ruleVersion: 1,
	events: []
};

function sheet(): ParsedSheet {
	const rows = Array.from({ length: SHEET_TOSSUPS }, () => ({ cells: [Array<RawCell>(5).fill(null), Array<RawCell>(5).fill(null)] as [RawCell[], RawCell[]], bonus: [null, null] as [RawCell, RawCell], note: '' }));
	rows[0].cells[0][1] = 10;
	rows[0].bonus[0] = 20;
	rows[1].cells[1][0] = 10;
	rows[1].bonus[1] = '12.5';
	rows[2].cells[0][0] = 15;
	rows[2].cells[1][3] = 10;
	rows[25].bonus[0] = 10;
	rows[1].note = 'Answer: Lincoln';
	return {
		name: 'Round (2)',
		round: 2,
		moderator: 'Mrs. Example',
		room: 'Room 3',
		teams: ['Fox Run HS', 'Riverbend Christian B'],
		players: [
			['Finley Fairbanks', 'B. Fairbanks', '', '', ''],
			['Kendall Fairbanks', '', '', '', '']
		],
		rows
	};
}

describe('matching names from an uploaded scoresheet', () => {
	it('matches schools and players only when the names are the same, ignoring case and punctuation', () => {
		expect(exactTeam('riverbend christian b', match)).toBe('A');
		expect(exactTeam('Fox Run HS', match)).toBeNull();
		expect(exactPlayer('Fairbanks, Kendall', match.teams.A.roster)).toBe('k');
		expect(exactPlayer('KENDALL  FAIRBANKS', match.teams.A.roster)).toBe('k');
		expect(exactPlayer('B. Fairbanks', match.teams.B.roster)).toBeNull();
		expect(exactPlayer('Fairbanks', match.teams.B.roster)).toBeNull();
	});

	it('ranks the likeliest player first for a name that does not match', () => {
		const ranked = match.teams.B.roster.map((p) => [p.id, likeness('B. Fairbanks', p.name)] as const).sort((a, b) => b[1] - a[1]);
		expect(ranked[0][0]).toBe('b');
		expect(likeness('Fox Run HS', 'Fox Run High School')).toBeGreaterThan(likeness('Fox Run HS', 'Riverbend Christian B'));
	});

	it('asks about every column that has a name or entries', () => {
		expect(usedColumns(sheet(), 0)).toEqual([0, 1]);
		expect(usedColumns(sheet(), 1)).toEqual([0, 3]);
	});
});

describe('importing an uploaded scoresheet', () => {
	it('turns the sheet into rows for this game, with the schools swapped, and lists cells it cannot use', () => {
		const { plan, problems } = buildPlan(sheet(), { sides: ['B', 'A'], players: [['f', 'b', null, null, null], ['k', null, null, null, null]] }, match, HS);
		expect(plan.slots.B.map((s) => s.playerId)).toEqual(['f', 'b', null, null, null]);
		expect(plan.rows[0].B.players[1]).toBe(1000);
		expect(plan.rows[0].B.bonus).toBe(2000);
		expect(plan.rows[1].A.players[0]).toBe(1000);
		expect(plan.rows[1].A.bonus).toBe(1250);
		expect(plan.rows[2].B.players[0]).toBeNull();
		expect(plan.moderator).toBe('Mrs. Example');
		expect(plan.notes[1]).toBe('Answer: Lincoln');
		expect(problems).toEqual([
			'B7 ("15") was skipped: In a player\'s column, type 10 for a correct answer, 0 for a wrong answer.',
			'G30 ("10") was skipped: No bonus is played on the tiebreaker row. Enter only the tossup.'
		]);

		// Applied the way the scoresheet page does it, the round scores what the sheet shows.
		const log = new LogBuilder();
		log.add({ type: 'round_started', lineups: { A: ['k'], B: ['f', 'b'] } });
		for (let n = 1; n <= SHEET_TOSSUPS; n++) for (const b of rowChanges(computeRound(log.events, HS), n, plan.rows[n - 1], plan.slots, HS) ?? []) log.add(b as EventBody);
		const res = computeRound(log.events, HS);
		expect(res.teams.B.roundScore).toBe(3000);
		expect(res.teams.A.roundScore).toBe(3250);
		expect(res.players.find((p) => p.playerId === 'b')?.corrects).toBe(1);
		// The tossup in column N of row 3 had no name above it: it counts for the team.
		expect(res.tossups[2].answers[0]).toMatchObject({ side: 'A', playerId: null, correct: true });
		const slots = { A: sheetSlots(match, res, 'A'), B: sheetSlots(match, res, 'B') };
		expect(sheetRows(res, slots, HS)[2].A.players[1]).toBe(1000);
	});
});
