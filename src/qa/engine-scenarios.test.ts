/**
 * Independent QA scenarios for the scoring engine (Oct 2026 fresh-eyes review).
 * Every expected number here was worked out by hand from the script, not from the engine.
 */
import { computeRound, computeStandings, HIGH_SCHOOL_DEFAULTS, summarizeRound, type EventBody, type RuleSettings, type ScoreEvent, type Side } from '$lib/engine';
import { describe, expect, it } from 'vitest';

const R: RuleSettings = structuredClone(HIGH_SCHOOL_DEFAULTS);
// Decisions confirmed Oct 21, 2026: bonuses count for the team only, half points stay, tiebreakers never count in total points.
R.individual.includeBonus = false;
R.bonus.rounding = 'exact';
R.tiebreaker.countsInTotalPoints = false;
const P = (pts: number) => Math.round(pts * 100); // points → hundredths

class Log {
	ev: ScoreEvent[] = [];
	add(body: EventBody, actor = 'room:1') {
		const id = `q${this.ev.length + 1}`;
		this.ev.push({ id, seq: this.ev.length + 1, body, actor });
		return id;
	}
	start() {
		return this.add({ type: 'round_started', lineups: { A: ['a1', 'a2', 'a3', 'a4'], B: ['b1', 'b2', 'b3', 'b4'] } });
	}
	ans(t: number, side: Side, p: string | null, correct: boolean, tb = false) {
		return this.add({ type: 'tossup_answer', tossup: t, side, playerId: p, correct, ...(tb ? { tiebreaker: true } : {}) });
	}
	bonus(t: number, side: Side, value: number, parts: string) {
		return this.add({ type: 'bonus', tossup: t, side, value: P(value), parts: [...parts].map((c) => (c === 'c' ? 'correct' : 'incorrect')) });
	}
	dead(t: number, tb = false) {
		return this.add({ type: 'tossup_dead', tossup: t, ...(tb ? { tiebreaker: true } : {}) });
	}
}

/** The 20-tossup round used in S1, ending on time. */
function normalRound() {
	const L = new Log();
	L.start();
	L.ans(1, 'A', 'a1', true); L.bonus(1, 'A', 20, 'cc');            // A 30
	L.ans(2, 'B', 'b2', false); L.ans(2, 'A', 'a3', true); L.bonus(2, 'A', 30, 'cic'); // A 60
	L.ans(3, 'B', 'b1', true); L.bonus(3, 'B', 10, 'i');             // B 10
	L.dead(4);
	L.ans(5, 'A', 'a2', false); L.ans(5, 'B', 'b3', false);           // nobody
	L.ans(6, 'B', 'b4', true); L.bonus(6, 'B', 25, 'ci');            // B 32.5
	L.ans(7, 'A', 'a1', true); L.bonus(7, 'A', 20, 'ccci');          // A 85
	L.ans(8, 'B', 'b1', true); L.bonus(8, 'B', 20, 'cc');            // B 62.5
	L.ans(9, 'A', 'a4', true); L.bonus(9, 'A', 30, 'iii');           // A 95
	L.dead(10);
	L.ans(11, 'B', 'b2', true); L.bonus(11, 'B', 20, 'ic');          // B 82.5
	L.ans(12, 'A', 'a1', true); L.bonus(12, 'A', 30, 'ccc');         // A 135
	L.add({ type: 'note', text: 'Score announced after tossup 12' });
	L.ans(13, 'B', 'b3', false); L.ans(13, 'A', 'a2', false);
	L.ans(14, 'A', 'a3', true); L.bonus(14, 'A', 20, 'ci');          // A 155
	L.ans(15, 'B', 'b1', true); L.bonus(15, 'B', 30, 'cci');         // B 112.5
	L.dead(16);
	L.ans(17, 'B', 'b4', true); L.bonus(17, 'B', 10, 'c');           // B 132.5
	L.ans(18, 'A', 'a1', true); L.bonus(18, 'A', 20, 'ii');          // A 165
	L.ans(19, 'B', 'b2', true); L.bonus(19, 'B', 25, 'c');           // B 157.5
	L.ans(20, 'A', 'a4', true); L.bonus(20, 'A', 20, 'cc');          // A 195
	L.add({ type: 'round_ended', reason: 'Time called' });
	return L;
}

const ind = (r: ReturnType<typeof computeRound>, id: string) => r.players.find((p) => p.playerId === id)?.individualTotal ?? 0;

describe('S1 normal full round', () => {
	it('matches the hand calculation tossup by tossup', () => {
		const r = computeRound(normalRound().ev, R);
		// Hand calc: A 8 tossups (80) + bonuses 20+20+15+0+30+10+0+20 (115) = 195.
		// B 7 tossups (70) + bonuses 0+12.5+20+10+20+10+25 (97.5) = 167.5.
		expect(r.teams.A.roundScore).toBe(P(195));
		expect(r.teams.B.roundScore).toBe(P(167.5));
		expect(r.teams.A.tossupPoints).toBe(P(80));
		expect(r.teams.A.bonusPoints).toBe(P(115));
		expect(r.teams.B.bonusPoints).toBe(P(97.5));
		expect(r.winner).toBe('A');
		expect(r.lastRegularTossup).toBe(20);
		expect(r.status).toBe('ended');
		// Running score after tossup 12 (what the scorer announces): 135–82.5.
		expect(r.tossups.find((t) => t.number === 12)!.running).toEqual({ A: P(135), B: P(82.5) });
		// Individuals (tossups only): a1 40, a2 0, a3 20, a4 20 / b1 30, b2 20, b3 0, b4 20.
		expect([ind(r, 'a1'), ind(r, 'a2'), ind(r, 'a3'), ind(r, 'a4')]).toEqual([P(40), 0, P(20), P(20)]);
		expect([ind(r, 'b1'), ind(r, 'b2'), ind(r, 'b3'), ind(r, 'b4')]).toEqual([P(30), P(20), 0, P(20)]);
		// The only flag is the 12.5 from a 25-point, 2-part bonus with one part right.
		expect(r.flags.map((f) => f.kind)).toEqual(['fractional_bonus']);
		expect(r.tossups.every((t) => t.state === 'complete')).toBe(true);
	});
});

describe('S2 tie and tiebreaker', () => {
	const tied = () => {
		const L = new Log();
		L.start();
		L.ans(1, 'A', 'a1', true); L.bonus(1, 'A', 30, 'ccc');
		L.ans(2, 'B', 'b1', true); L.bonus(2, 'B', 30, 'ccc');
		L.ans(3, 'A', 'a2', true); L.bonus(3, 'A', 20, 'ii');
		L.ans(4, 'B', 'b2', true); L.bonus(4, 'B', 20, 'ii');
		return L; // 50–50
	};

	it('a tied round needs a tiebreaker; the first correct tiebreaker answer wins; tiebreaker points stay out of individual totals', () => {
		const L = tied();
		const r0 = computeRound(L.ev, R);
		expect(r0.tied).toBe(true);
		L.add({ type: 'tiebreaker_started' });
		L.ans(1, 'A', 'a3', false, true); L.ans(1, 'B', 'b3', false, true); // TB1 dead
		L.ans(2, 'B', 'b4', true, true);                                     // TB2 B wins
		L.add({ type: 'round_ended', reason: 'Time called' });
		const r = computeRound(L.ev, R);
		expect(r.winner).toBe('B');
		expect(r.decidedByTiebreaker).toBe(true);
		// Decision (Oct 21): tiebreaker points never count toward total points (the standings tiebreak).
		expect(r.teams.B.totalPoints).toBe(P(50));
		expect(r.teams.A.totalPoints).toBe(P(50));
		expect(ind(r, 'b4')).toBe(0); // rules doc: tiebreaker points not counted for the individual
		expect(r.flags).toEqual([]);
	});

	it('ending tied without a tiebreaker is flagged and counts as neither a win nor a loss', () => {
		const L = tied();
		L.add({ type: 'round_ended', reason: 'Time called' });
		const r = computeRound(L.ev, R);
		expect(r.winner).toBeNull();
		expect(r.flags.map((f) => f.kind)).toContain('tied_without_tiebreaker');
	});

	it('S2b: a correction after the tiebreaker that breaks the regulation tie must not let the tiebreaker overrule regulation', () => {
		// Regulation 50–50, B wins the tiebreaker. The head scorekeeper later finds A was owed
		// a 2-part 20 bonus part on tossup 3 (one part right, +10). Regulation is really 60–50 → A won.
		const L = tied();
		L.add({ type: 'tiebreaker_started' });
		L.ans(1, 'B', 'b4', true, true);
		L.add({ type: 'round_ended', reason: 'Time called' });
		L.add({ type: 'submitted', scoreA: P(50), scoreB: P(60) });
		const bonus3 = L.ev.find((e) => e.body.type === 'bonus' && e.body.tossup === 3)!.id;
		L.add({ type: 'correction', action: 'amend', target: bonus3, replacement: { type: 'bonus', tossup: 3, side: 'A', value: P(20), parts: ['correct', 'incorrect'] }, reason: 'paper sheet shows part 1 right' }, 'user:1');
		const r = computeRound(L.ev, R);
		expect(r.teams.A.totalPoints).toBe(P(60));
		expect(r.teams.B.totalPoints).toBe(P(50));
		// Regulation is no longer tied, so regulation decides: A wins, and the stale tiebreaker is flagged.
		expect(r.winner).toBe('A');
		expect(r.decidedByTiebreaker).toBe(false);
		expect(r.flags.some((f) => /tiebreak/i.test(f.kind))).toBe(true);
	});
});

describe('S3 wrong entry, then corrected', () => {
	it('amend + void carry through team, individual, and submitted-score checks', () => {
		const L = normalRound();
		L.add({ type: 'submitted', scoreA: P(195), scoreB: P(167.5) });
		L.add({ type: 'approved' }, 'user:1');
		// Tossup 7 was really b3's (team B), and its 20-point 4-part bonus (3 right) was B's.
		const t7 = L.ev.find((e) => e.body.type === 'tossup_answer' && e.body.tossup === 7)!.id;
		const b7 = L.ev.find((e) => e.body.type === 'bonus' && e.body.tossup === 7)!.id;
		L.add({ type: 'correction', action: 'amend', target: t7, replacement: { type: 'tossup_answer', tossup: 7, side: 'B', playerId: 'b3', correct: true }, reason: 'wrong team clicked' }, 'user:1');
		L.add({ type: 'correction', action: 'amend', target: b7, replacement: { type: 'bonus', tossup: 7, side: 'B', value: P(20), parts: ['correct', 'correct', 'correct', 'incorrect'] }, reason: 'wrong team clicked' }, 'user:1');
		// And tossup 19's bonus was entered but never read (time was called): void it.
		const b19 = L.ev.find((e) => e.body.type === 'bonus' && e.body.tossup === 19)!.id;
		L.add({ type: 'correction', action: 'void', target: b19, reason: 'bonus not read' }, 'user:1');
		const r = computeRound(L.ev, R);
		// Hand: A 195 − 25 = 170. B 167.5 + 25 − 25 = 167.5.
		expect(r.teams.A.roundScore).toBe(P(170));
		expect(r.teams.B.roundScore).toBe(P(167.5));
		expect(ind(r, 'a1')).toBe(P(30));
		expect(ind(r, 'b3')).toBe(P(10));
		// Approval no longer stands; the head scorekeeper sees why.
		expect(r.status).toBe('submitted');
		const kinds = r.flags.map((f) => f.kind);
		expect(kinds).toContain('edited_after_submission');
		expect(kinds).toContain('submitted_score_mismatch');
		expect(kinds).not.toContain('bonus_wrong_team');
		// Voided and amended events remain in the audit, struck through.
		expect(r.audit.find((a) => a.event.id === b19)!.active).toBe(false);
		expect(r.audit.find((a) => a.event.id === t7)!.active).toBe(false);
		// Running score after tossup 7 reflects the corrected entry (A 60, B 57.5).
		expect(r.tossups.find((t) => t.number === 7)!.running).toEqual({ A: P(60), B: P(57.5) });
	});

	it('undo by the room: undo, undo-the-undo, and undo after end round', () => {
		const L = new Log();
		L.start();
		const a = L.ans(1, 'A', 'a1', true);
		const b = L.bonus(1, 'A', 30, 'ccc');
		const u1 = L.add({ type: 'undo', target: b });
		expect(computeRound(L.ev, R).teams.A.roundScore).toBe(P(10));
		L.add({ type: 'undo', target: u1 }); // redo
		expect(computeRound(L.ev, R).teams.A.roundScore).toBe(P(40));
		const end = L.add({ type: 'round_ended', reason: 'Time called' });
		L.add({ type: 'undo', target: end });
		const r = computeRound(L.ev, R);
		expect(r.status).toBe('in_progress');
		expect(r.teams.A.roundScore).toBe(P(40));
		void a;
	});
});

describe('S7 standings hand calculation (engine level)', () => {
	// Four teams, double round robin. Hand results (see QA report):
	// B 4–2 (800), C 3–3 (900), A 3–3 (790), D 2–4 (700).
	const results: [number, string, number, string, number][] = [
		[1, 'A', 150, 'B', 120], [1, 'C', 200, 'D', 90],
		[2, 'A', 110, 'C', 130], [2, 'B', 160, 'D', 100],
		[3, 'A', 140, 'D', 130], [3, 'B', 100, 'C', 180],
		[4, 'A', 120, 'B', 130], [4, 'C', 90, 'D', 150],
		[5, 'A', 170, 'C', 160], [5, 'B', 140, 'D', 120],
		[6, 'A', 100, 'D', 110], [6, 'B', 150, 'C', 140]
	];
	it('ranks by wins, then total points; a non-counter never counts', () => {
		const teams = ['A', 'B', 'C', 'D', 'X'].map((id) => ({ id, name: `Team ${id}`, schoolId: id, classification: id === 'X' ? '7A' : '5A', sessionId: 's', poolId: null }));
		const matches = results.map(([rd, a, , b], i) => ({ id: `m${i}`, sessionId: 's', roundNo: rd, teamA: a, teamB: b, counts: true }));
		const outcomes: Record<string, ReturnType<typeof summarizeRound>> = {};
		results.forEach(([, , sa, , sb], i) => {
			outcomes[`m${i}`] = { status: 'approved', winner: sa > sb ? 'A' : 'B', totals: { A: P(sa), B: P(sb) }, roundScores: { A: P(sa), B: P(sb) }, lineups: { A: [], B: [] }, players: [], hasFractional: false };
		});
		// Non-counter: D crushes X 400–0. Must not change D's record or points.
		matches.push({ id: 'nc', sessionId: 's', roundNo: 6, teamA: 'D', teamB: 'X', counts: false });
		outcomes.nc = { status: 'approved', winner: 'A', totals: { A: P(400), B: 0 }, roundScores: { A: P(400), B: 0 }, lineups: { A: [], B: [] }, players: [], hasFractional: false };
		const st = computeStandings({ teams, matches, outcomes, rules: R, mode: 'final' });
		const g = st.classifications.find((c) => c.label === '5A')!;
		expect(g.rows.map((r) => [r.teamId, r.place, r.record.wins, r.record.losses, r.record.totalPoints / 100])).toEqual([
			['B', 1, 4, 2, 800],
			['C', 2, 3, 3, 900],
			['A', 3, 3, 3, 790],
			['D', 4, 2, 4, 700]
		]);
		expect(st.records.X.played).toBe(0);
		expect(st.flags.filter((f) => f.kind === 'team_tie')).toEqual([]);
	});

	it('head-to-head breaks a two-way tie on wins and points; a three-way circle is flagged, never broken silently', () => {
		const teams = ['E', 'F', 'G', 'K'].map((id) => ({ id, name: id, schoolId: id, classification: '6A', sessionId: 's', poolId: null }));
		const games: [string, number, string, number][] = [
			['E', 120, 'F', 100], ['E', 100, 'G', 130], ['F', 130, 'G', 110],
			['E', 90, 'F', 140], ['E', 150, 'G', 100], ['F', 90, 'G', 120]
		]; // all 2–2, all 460 points, 1–1 against each other
		const matches = games.map(([a, , b], i) => ({ id: `g${i}`, sessionId: 's', roundNo: i + 1, teamA: a, teamB: b, counts: true }));
		const outcomes: Record<string, ReturnType<typeof summarizeRound>> = {};
		games.forEach(([, sa, , sb], i) => (outcomes[`g${i}`] = { status: 'approved', winner: sa > sb ? 'A' : 'B', totals: { A: P(sa), B: P(sb) }, roundScores: { A: P(sa), B: P(sb) }, lineups: { A: [], B: [] }, players: [], hasFractional: false }));
		const st = computeStandings({ teams: teams.filter((t) => t.id !== 'K'), matches, outcomes, rules: R, mode: 'final' });
		const g = st.classifications[0];
		expect(g.rows.every((r) => r.place === 1 && r.tied)).toBe(true);
		expect(st.flags.some((f) => f.kind === 'team_tie')).toBe(true);

		// Two-way: drop G's last game result to make E and F 2–2 vs G... simpler: E and F only, E beat F twice.
		const two = computeStandings({
			teams: teams.filter((t) => t.id === 'E' || t.id === 'F'),
			matches: [
				{ id: 'h1', sessionId: 's', roundNo: 1, teamA: 'E', teamB: 'F', counts: true },
				{ id: 'h2', sessionId: 's', roundNo: 2, teamA: 'F', teamB: 'E', counts: true },
				{ id: 'h3', sessionId: 's', roundNo: 3, teamA: 'E', teamB: 'F', counts: true },
				{ id: 'h4', sessionId: 's', roundNo: 4, teamA: 'F', teamB: 'E', counts: true }
			],
			outcomes: {
				h1: { status: 'approved', winner: 'A', totals: { A: P(110), B: P(100) }, roundScores: { A: 0, B: 0 }, lineups: { A: [], B: [] }, players: [], hasFractional: false },
				h2: { status: 'approved', winner: 'A', totals: { A: P(200), B: P(100) }, roundScores: { A: 0, B: 0 }, lineups: { A: [], B: [] }, players: [], hasFractional: false },
				h3: { status: 'approved', winner: 'A', totals: { A: P(150), B: P(140) }, roundScores: { A: 0, B: 0 }, lineups: { A: [], B: [] }, players: [], hasFractional: false },
				h4: { status: 'approved', winner: 'A', totals: { A: P(130), B: P(140) }, roundScores: { A: 0, B: 0 }, lineups: { A: [], B: [] }, players: [], hasFractional: false }
			},
			rules: R,
			mode: 'final'
		});
		// E: 2–2, 110+100+150+140 = 500. F: 2–2, 100+200+140+130 = 570 → F first on points (h2h never reached).
		expect(two.classifications[0].rows.map((r) => [r.teamId, r.place])).toEqual([['F', 1], ['E', 2]]);
	});
});

describe('S8 one award division across two pools (Private split into pools that never meet)', () => {
	const outcomeOf = (sa: number, sb: number): ReturnType<typeof summarizeRound> => ({ status: 'approved', winner: sa > sb ? 'A' : 'B', totals: { A: P(sa), B: P(sb) }, roundScores: { A: P(sa), B: P(sb) }, lineups: { A: [], B: [] }, players: [], hasFractional: false });
	// Pool 1's best team: 3–0, 300 points. Pool 2's best team: 3–0, 350 points.
	const games: [string, number, string, number][] = [
		['P1a', 100, 'P1b', 90], ['P1a', 100, 'P1c', 80], ['P1a', 100, 'P1d', 70], ['P1b', 90, 'P1c', 80], ['P1b', 90, 'P1d', 70], ['P1c', 80, 'P1d', 60],
		['P2a', 100, 'P2b', 90], ['P2a', 120, 'P2c', 80], ['P2a', 130, 'P2d', 60], ['P2b', 90, 'P2c', 80], ['P2b', 90, 'P2d', 70], ['P2c', 80, 'P2d', 60]
	];
	const run = (sessionOf: (id: string) => string) => {
		const teams = ['P1a', 'P1b', 'P1c', 'P1d', 'P2a', 'P2b', 'P2c', 'P2d'].map((id) => ({ id, name: id, schoolId: id, classification: 'Private', sessionId: sessionOf(id), poolId: id.slice(0, 2) }));
		const matches = games.map(([a, , b], i) => ({ id: `p${i}`, sessionId: sessionOf(a), roundNo: (i % 6) + 1, teamA: a, teamB: b, counts: true }));
		const outcomes = Object.fromEntries(games.map(([, sa, , sb], i) => [`p${i}`, outcomeOf(sa, sb)]));
		return computeStandings({ teams, matches, outcomes, rules: R, mode: 'final' });
	};

	it('ranks the two pools together; pool 2\'s team is Private 1st, with a note that the pools did not meet', () => {
		const st = run(() => 's');
		const g = st.divisions.find((d) => d.label === 'Private')!;
		expect(g.rows.slice(0, 2).map((r) => [r.teamId, r.place, r.record.wins, r.record.losses, r.record.totalPoints / 100])).toEqual([
			['P2a', 1, 3, 0, 350],
			['P1a', 2, 3, 0, 300]
		]);
		expect(st.flags.filter((f) => f.kind === 'division_split_pools').map((f) => f.message)).toEqual(["Private: teams in different pools didn't all play each other."]);
		expect(st.flags.filter((f) => f.kind === 'team_tie')).toEqual([]);
		// Pools are unchanged: each still has its own table.
		expect(st.pools.map((p) => p.rows[0].teamId).sort()).toEqual(['P1a', 'P2a']);
	});

	it('a division whose teams are in two sessions is ranked together and flagged for the head scorekeeper', () => {
		const st = run((id) => (id.startsWith('P1') ? 'am' : 'pm'));
		const g = st.divisions.find((d) => d.label === 'Private')!;
		expect([g.sessionId, g.sessionIds, g.rows[0].teamId]).toEqual([null, ['am', 'pm'], 'P2a']);
		expect(st.flags.some((f) => f.kind === 'division_spans_sessions')).toBe(true);
	});
});
