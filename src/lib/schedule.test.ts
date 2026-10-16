import { describe, expect, it } from 'vitest';
import { byesByRound, generateSchedule, roundRobin, validateSchedule, type PoolDef, type SchedRoom, type SchedTeam } from './schedule';

const team = (id: number, classification: string, poolKey = classification, schoolId = id): SchedTeam => ({
	id,
	name: `T${id}`,
	schoolId,
	classification,
	poolKey
});
const rooms = (n: number): SchedRoom[] => Array.from({ length: n }, (_, i) => ({ id: 100 + i, name: `Room ${i + 1}` }));
const pool = (key: string, ids: number[]): PoolDef => ({ key, name: key, teamIds: ids });

describe('roundRobin (circle method)', () => {
	it('every pair meets exactly once for an even count', () => {
		const rr = roundRobin([1, 2, 3, 4, 5, 6]);
		expect(rr).toHaveLength(5);
		const seen = new Set<string>();
		for (const round of rr) {
			const inRound = round.flatMap(([a, b]) => [a, b]);
			expect(new Set(inRound).size).toBe(6);
			for (const [a, b] of round) seen.add([a, b].sort().join('-'));
		}
		expect(seen.size).toBe(15);
	});

	it('odd counts give each team exactly one bye per cycle', () => {
		const rr = roundRobin([1, 2, 3, 4, 5]);
		expect(rr).toHaveLength(5);
		const byes = rr.flatMap((round) => round.filter(([, b]) => b === null).map(([a]) => a));
		expect(byes.sort()).toEqual([1, 2, 3, 4, 5]);
	});
});

describe('generateSchedule', () => {
	it('repeats the round robin to fill the rounds; a two-team pool plays every round', () => {
		const teams = [team(1, '5A'), team(2, '5A')];
		const res = generateSchedule({ pools: [pool('5A', [1, 2])], teams, rooms: rooms(2), rounds: 4, fillByesWithNonCounters: false });
		expect(res.matches).toHaveLength(4);
		expect(res.matches.every((m) => m.counts)).toBe(true);
		// Sides alternate on repeats.
		expect(res.matches.map((m) => m.teamA)).toEqual([1, 2, 1, 2]);
	});

	it('fills byes with cross-classification non-counters and never double-books', () => {
		const teams = [team(1, 'Private'), team(2, 'Private'), team(3, 'Private'), team(4, '2A'), team(5, '3A')];
		const pools = [pool('Private', [1, 2, 3]), pool('2A', [4]), pool('3A', [5])];
		const res = generateSchedule({ pools, teams, rooms: rooms(4), rounds: 6, fillByesWithNonCounters: true });
		const issues = validateSchedule({ teams, rooms: rooms(4), roundCount: 6, matches: res.matches.map((m, i) => ({ ...m, id: i })) });
		expect(issues.filter((i) => i.level === 'error')).toEqual([]);
		const nc = res.matches.filter((m) => !m.counts);
		expect(nc.length).toBeGreaterThan(0);
		// Every round: 3 byes (one Private + 2A + 3A) → one NC game + one true bye.
		for (let r = 1; r <= 6; r++) {
			expect(res.matches.filter((m) => m.roundNo === r && !m.counts)).toHaveLength(1);
			expect(res.byes.filter((b) => b.roundNo === r)).toHaveLength(1);
		}
		expect(res.warnings.some((w) => w.includes('only one team'))).toBe(true);
	});

	it('merged pool: small classifications play each other in counting games', () => {
		const teams = [team(1, '1A', 'p'), team(2, '2A', 'p'), team(3, '3A', 'p')];
		const res = generateSchedule({ pools: [pool('p', [1, 2, 3])], teams, rooms: rooms(3), rounds: 6, fillByesWithNonCounters: false });
		expect(res.matches.filter((m) => m.counts)).toHaveLength(6);
		const games = (id: number) => res.matches.filter((m) => m.teamA === id || m.teamB === id).length;
		expect([games(1), games(2), games(3)]).toEqual([4, 4, 4]);
	});

	it('balances room usage and drops non-counters first when rooms run out', () => {
		const teams = Array.from({ length: 8 }, (_, i) => team(i + 1, i < 7 ? 'Private' : '2A'));
		const pools = [pool('Private', [1, 2, 3, 4, 5, 6, 7]), pool('2A', [8])];
		const res = generateSchedule({ pools, teams, rooms: rooms(3), rounds: 7, fillByesWithNonCounters: true });
		for (let r = 1; r <= 7; r++) {
			const these = res.matches.filter((m) => m.roundNo === r);
			expect(these.filter((m) => m.counts)).toHaveLength(3);
			expect(new Set(these.map((m) => m.roomId)).size).toBe(these.length);
		}
		const usage = rooms(3).map((rm) => res.matches.filter((m) => m.roomId === rm.id).length);
		expect(Math.max(...usage) - Math.min(...usage)).toBeLessThanOrEqual(1);
	});

	it('warns when there are more counting games than rooms', () => {
		const teams = Array.from({ length: 6 }, (_, i) => team(i + 1, 'Private'));
		const res = generateSchedule({ pools: [pool('Private', [1, 2, 3, 4, 5, 6])], teams, rooms: rooms(2), rounds: 5, fillByesWithNonCounters: false });
		expect(res.warnings.some((w) => w.includes('only 2 rooms'))).toBe(true);
	});
});

describe('validateSchedule', () => {
	const teams = [team(1, '1A', '1A', 50), team(2, '1A', '1A', 50), team(3, '2A'), team(4, '2A')];
	it('catches double bookings of teams and rooms', () => {
		const issues = validateSchedule({
			teams,
			rooms: rooms(2),
			roundCount: 2,
			matches: [
				{ id: 1, roundNo: 1, roomId: 100, teamA: 1, teamB: 3, counts: false },
				{ id: 2, roundNo: 1, roomId: 100, teamA: 1, teamB: 4, counts: false }
			]
		});
		expect(issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual([
			'Round 1: T1 is booked in two games.',
			'Round 1: Room 1 has two games.'
		]);
	});

	it('raises a notice when two teams from the same school meet', () => {
		const issues = validateSchedule({ teams, rooms: rooms(2), roundCount: 1, matches: [{ id: 9, roundNo: 1, roomId: 100, teamA: 1, teamB: 2, counts: true }] });
		const notice = issues.find((i) => i.level === 'notice');
		expect(notice?.matchIds).toEqual([9]);
		expect(notice?.message).toMatch(/same school/);
	});

	it('warns about cross-pool counting games, unequal games, and missing pairs', () => {
		const issues = validateSchedule({
			teams: [...teams, team(5, '2A')],
			rooms: rooms(2),
			roundCount: 4,
			matches: [
				{ id: 1, roundNo: 1, roomId: 100, teamA: 1, teamB: 3, counts: true },
				{ id: 2, roundNo: 2, roomId: 100, teamA: 3, teamB: 4, counts: true },
				{ id: 3, roundNo: 3, roomId: 100, teamA: 3, teamB: 4, counts: true },
				{ id: 4, roundNo: 4, roomId: 100, teamA: 4, teamB: 3, counts: true }
			]
		});
		const msgs = issues.map((i) => i.message).join('\n');
		expect(msgs).toMatch(/different pools/);
		expect(msgs).toMatch(/unequal numbers of counting games/);
		expect(msgs).toMatch(/never play each other: T3 \/ T5; T4 \/ T5/);
		expect(msgs).toMatch(/unbalanced pairings/);
	});

	it('lists byes per round', () => {
		const b = byesByRound(teams, [{ roundNo: 1, roomId: 100, teamA: 1, teamB: 2, counts: true }], 2);
		expect(b.get(1)).toEqual([3, 4]);
		expect(b.get(2)).toEqual([1, 2, 3, 4]);
	});
});
