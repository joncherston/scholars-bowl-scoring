/**
 * Independent QA scenarios through the server code paths (ingest → live standings →
 * awards → Excel), on a throwaway in-memory database with fictional teams.
 * Expected values are hand-calculated from the scripts below.
 */
import { computeRound, HIGH_SCHOOL_DEFAULTS, type EventBody, type Side } from '$lib/engine';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, schema, useMemoryDb } from '$lib/server/db';
import { createEvent, listRooms, listSessions } from '$lib/server/events';
import { ingestEvents, matchEvents, ROOM_TYPES, STAFF_TYPES, type IngestContext } from '$lib/server/ingest';
import { computeLive } from '$lib/server/live';
import { awardsData } from '$lib/server/reports';
import { addPlayerToTeam, createTeam, teamRoster } from '$lib/server/teams';
import { buildPreview, type ExistingTeam, type RegistrationRow } from '$lib/server/registrations';
import { GET as exportXlsx } from '../routes/(app)/events/[id]/reports/export.xlsx/+server';
import { actions as liveActions } from '../routes/(app)/events/[id]/live/+page.server';

const P = (pts: number) => Math.round(pts * 100);
const uuid = () => crypto.randomUUID();
const admin = { id: 1, email: 'qa@example.test', name: 'QA Admin', isAdmin: true, mustChangePassword: false };
const adminAuth = { kind: 'user' as const, user: admin, sessionId: 'qa' };

let eventId: number;
let sessionId: number;
const team: Record<string, number> = {};
const players: Record<string, string[]> = {};
let rooms: { id: number; name: string }[] = [];
const deviceSeq = new Map<number, number>();
/** Independent tally of individual tossup points from the scripts (player id → points). */
let tally: Map<string, number>;

function roomCtx(roomId: number, deviceId = `dev-${roomId}`): IngestContext {
	return { eventId, roomId, deviceId, actor: `room:${roomId}`, actorName: `Room ${roomId}`, source: 'live', allowed: ROOM_TYPES, enforceLease: true, lockSubmitted: true };
}
const staffCtx = (): IngestContext => ({ eventId, roomId: null, deviceId: null, actor: 'user:1', actorName: 'QA Admin', source: 'staff', allowed: STAFF_TYPES, enforceLease: false, lockSubmitted: false });

function send(matchId: number, roomId: number, body: EventBody, ctx = roomCtx(roomId)) {
	const n = (deviceSeq.get(matchId) ?? 0) + 1;
	deviceSeq.set(matchId, n);
	const [r] = ingestEvents(ctx, [{ id: uuid(), matchId, deviceSeq: n, body }]);
	return r;
}
const staff = (matchId: number, body: EventBody) => ingestEvents(staffCtx(), [{ id: uuid(), matchId, body }])[0];

function addMatch(roundNo: number, roomIdx: number, a: string, b: string, counts = true) {
	const [m] = getDb().insert(schema.matches).values({ sessionId, roundNo, roomId: rooms[roomIdx].id, teamAId: team[a], teamBId: team[b], counts }).returning().all();
	return m;
}

/**
 * Score a whole round that ends `sa`–`sb` (multiples of 10), with realistic noise:
 * missed tossups, dead tossups, and 1-part bonuses of 0/10/20/30.
 */
function play(m: { id: number; roomId: number; teamAId: number; teamBId: number }, a: string, b: string, sa: number, sb: number, opts: { lineupA?: string[]; lineupB?: string[]; submit?: boolean; tossupsOnly?: boolean } = {}) {
	const lineups: Record<Side, string[]> = { A: opts.lineupA ?? players[a].slice(0, 4), B: opts.lineupB ?? players[b].slice(0, 4) };
	send(m.id, m.roomId, { type: 'round_started', lineups });
	const plan = (target: number) => {
		if (opts.tossupsOnly) return Array.from({ length: target / 10 }, () => -1);
		const n = Math.max(1, Math.round(target / 25));
		let rest = target - 10 * n;
		const bonuses = Array.from({ length: n }, () => {
			const v = Math.min(30, rest);
			rest -= v;
			return v;
		});
		if (rest !== 0 || bonuses.some((v) => v < 0 && v !== -1)) throw new Error(`bad plan for ${target}`);
		return bonuses;
	};
	const qs: { side: Side; bonus: number }[] = [];
	const pa = plan(sa), pb = plan(sb);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		if (i < pa.length) qs.push({ side: 'A', bonus: pa[i] });
		if (i < pb.length) qs.push({ side: 'B', bonus: pb[i] });
	}
	let t = 0;
	const turn: Record<Side, number> = { A: m.id % 4, B: (m.id + 1) % 4 };
	for (const q of qs) {
		t++;
		if (t % 5 === 0) {
			send(m.id, m.roomId, { type: 'tossup_dead', tossup: t });
			t++;
		}
		const other: Side = q.side === 'A' ? 'B' : 'A';
		if (t % 3 === 0) send(m.id, m.roomId, { type: 'tossup_answer', tossup: t, side: other, playerId: lineups[other][0], correct: false });
		const p = lineups[q.side][turn[q.side]++ % lineups[q.side].length];
		send(m.id, m.roomId, { type: 'tossup_answer', tossup: t, side: q.side, playerId: p, correct: true });
		tally.set(p, (tally.get(p) ?? 0) + 10);
		if (q.bonus >= 0) send(m.id, m.roomId, { type: 'bonus', tossup: t, side: q.side, value: q.bonus === 0 ? P(20) : P(q.bonus), parts: [q.bonus === 0 ? 'incorrect' : 'correct'] });
	}
	send(m.id, m.roomId, { type: 'round_ended', reason: 'Time called' });
	if (opts.submit !== false) send(m.id, m.roomId, { type: 'submitted', scoreA: P(sa), scoreB: P(sb) });
}

function setup() {
	process.env.DISABLE_BACKUPS = '1';
	useMemoryDb();
	deviceSeq.clear();
	tally = new Map();
	eventId = createEvent(
		{
			name: 'QA Tournament',
			eventDate: '2026-10-28',
			isTest: true,
			classifications: ['Private', '1A', '2A', '3A', '4A', '5A', '6A', '7A'],
			sessions: [{ name: 'Afternoon', date: '2026-10-28', startTime: '12:15', classifications: ['5A', '6A', '7A'], roundCount: 6, roundTimes: [] }],
			roomNames: ['Room 214', 'Room 215', 'Room 216'],
			settings: structuredClone(HIGH_SCHOOL_DEFAULTS),
			settingsSource: 'QA'
		},
		'QA'
	);
	sessionId = listSessions(eventId)[0].id;
	rooms = listRooms(eventId).map((r) => ({ id: r.id, name: r.name }));
	for (const r of rooms) getDb().update(schema.rooms).set({ activeDeviceId: `dev-${r.id}` }).where(eq(schema.rooms.id, r.id)).run();
	const defs: [string, string][] = [
		['Alder', '5A'], ['Birch', '5A'], ['Cypress', '5A'], ['Dogwood', '5A'],
		['Elm', '6A'], ['Fir', '6A'], ['Ginkgo', '6A'],
		['Hawthorn', '7A']
	];
	getDb().transaction((tx) => {
		for (const [name, cls] of defs) {
			team[name] = createTeam(tx, eventId, { name: `${name} High School`, classification: cls, sessionId, source: 'manual' });
			players[name] = [];
			for (let i = 1; i <= 6; i++) players[name].push(addPlayerToTeam(tx, team[name], { firstName: `${name}${i}`, lastName: 'Test' }));
		}
	});
	getDb().update(schema.sessions).set({ scheduleStatus: 'published' }).where(eq(schema.sessions.id, sessionId)).run();
}

// 5A double round robin; hand results: Birch 4–2 (800), Cypress 3–3 (900), Alder 3–3 (790), Dogwood 2–4 (700).
const FIVE_A: [number, string, number, string, number][] = [
	[1, 'Alder', 150, 'Birch', 120], [1, 'Cypress', 200, 'Dogwood', 90],
	[2, 'Alder', 110, 'Cypress', 130], [2, 'Birch', 160, 'Dogwood', 100],
	[3, 'Alder', 140, 'Dogwood', 130], [3, 'Birch', 100, 'Cypress', 180],
	[4, 'Alder', 120, 'Birch', 130], [4, 'Cypress', 90, 'Dogwood', 150],
	[5, 'Alder', 170, 'Cypress', 160], [5, 'Birch', 140, 'Dogwood', 120],
	[6, 'Alder', 100, 'Dogwood', 110], [6, 'Birch', 150, 'Cypress', 140]
];
// 6A: three teams, one game a round; the bye team plays Hawthorn (7A, alone) in a non-counter.
const SIX_A: [number, string, number, string, number][] = [
	[1, 'Elm', 120, 'Fir', 100], [2, 'Elm', 100, 'Ginkgo', 130], [3, 'Fir', 130, 'Ginkgo', 110],
	[4, 'Elm', 90, 'Fir', 140], [5, 'Elm', 150, 'Ginkgo', 100], [6, 'Fir', 90, 'Ginkgo', 120]
];
const BYE: Record<number, string> = { 1: 'Ginkgo', 2: 'Fir', 3: 'Elm', 4: 'Ginkgo', 5: 'Fir', 6: 'Elm' };

beforeEach(setup);


describe('SV1 a full afternoon: standings, awards, and Excel match the hand calculation', () => {
	it('team standings per classification and in the Public 4A–7A award division', async () => {
		playDayFixed();
		const live = computeLive(eventId);
		const name = (id: string) => live.teams.find((t) => t.id === id)!.name.replace(' High School', '');
		const five = live.final.classifications.find((c) => c.label === '5A')!;
		expect(five.rows.map((r) => [name(r.teamId), r.place, r.record.wins, r.record.losses, r.record.totalPoints / 100])).toEqual([
			['Birch', 1, 4, 2, 800],
			['Cypress', 2, 3, 3, 900],
			['Alder', 3, 3, 3, 790],
			['Dogwood', 4, 2, 4, 700]
		]);
		// 6A: all 2–2 with 460 each and 1–1 head to head → three-way tie flagged for a decision.
		const six = live.final.classifications.find((c) => c.label === '6A')!;
		expect(six.rows.map((r) => [name(r.teamId), r.place, r.record.wins, r.record.totalPoints / 100]).sort()).toEqual([
			['Elm', 1, 2, 460], ['Fir', 1, 2, 460], ['Ginkgo', 1, 2, 460]
		].sort());
		// 7A: Hawthorn played only non-counters: 0–0, 0 points.
		const seven = live.final.classifications.find((c) => c.label === '7A')!;
		expect(seven.rows[0].record).toMatchObject({ played: 0, wins: 0, totalPoints: 0 });
		// Awards (decision Oct 21): one Public 4A–7A division across 5A, 6A, and 7A. Hand calculation:
		const div = live.final.divisions.find((d) => d.label === 'Public 4A–7A')!;
		expect(div.rows.map((r) => [name(r.teamId), r.place, r.record.wins, r.record.losses, r.record.totalPoints / 100])).toEqual([
			['Birch', 1, 4, 2, 800],
			['Cypress', 2, 3, 3, 900],
			['Alder', 3, 3, 3, 790],
			['Dogwood', 4, 2, 4, 700],
			['Elm', 5, 2, 2, 460],
			['Fir', 5, 2, 2, 460],
			['Ginkgo', 5, 2, 2, 460],
			['Hawthorn', 8, 0, 0, 0]
		]);
		// The tie at 5th is not at an award place, so there is no team tie to resolve; unequal games is a note.
		// Elm, Fir and Ginkgo (all 6A) are tied for the 6A class award (1st and 2nd per class, confirmed Oct 29 2026).
		expect(live.flags.filter((f) => f.tie?.kind === 'team').map((f) => f.message)).toEqual([expect.stringMatching(/3 6A teams tied for the 6A place 1/)]);
		expect(live.flags.some((f) => f.kind === 'unequal_games' && f.level === 'info')).toBe(true);
		// Every round's server-computed score equals what the scorer submitted.
		expect(live.flags.filter((f) => f.kind === 'submitted_score_mismatch')).toEqual([]);
		expect(live.matches.every((m) => m.result.status === 'approved')).toBe(true);
	});

	it('individual leaderboard equals an independent tally of the scripts (non-counters excluded)', () => {
		playDayFixed();
		const live = computeLive(eventId);
		for (const g of live.final.individuals) {
			for (const r of g.rows) expect([r.playerId, r.total]).toEqual([r.playerId, P(tally.get(r.playerId) ?? 0)]);
		}
		// Hawthorn players scored only in exhibitions → 0 everywhere.
		const haw = live.final.individuals.flatMap((g) => g.rows).filter((r) => players.Hawthorn.includes(r.playerId));
		expect(haw.every((r) => r.total === 0)).toBe(true);
		// Alder's subs (players 5, 6) are credited only for round 4.
		const alderSubs = live.final.individuals.flatMap((g) => g.rows).filter((r) => r.playerId === players.Alder[4] || r.playerId === players.Alder[5]);
		expect(alderSubs.every((r) => r.games === 1)).toBe(true);
	});

	it('finalize is blocked by award-place ties (the 6A class tie and individual ties) until resolved', async () => {
		playDayFixed();
		const ties = computeLive(eventId).flags.filter((f) => f.tie);
		expect(ties.filter((f) => f.tie!.kind === 'team')).toHaveLength(1);
		expect(JSON.stringify(await callAction('finalize', { sessionId: String(sessionId) }))).toMatch(/Resolve the ties/);
		for (const f of ties) await callAction('resolveTie', { kind: f.tie!.kind, groupKey: f.tie!.groupKey, ordered: f.tie!.ids.join(','), note: 'QA: sudden-death question' });
		expect(JSON.stringify(await callAction('finalize', { sessionId: String(sessionId) }))).toMatch(/Session finalized/);
	});

	it('awards sheet and Excel export show the same numbers', async () => {
		playDayFixed();
		const aw = awardsData(eventId);
		// Awards by division, not per classification.
		expect(aw.sessions[0].divisions.map((d) => d.label)).toEqual(['Public 4A–7A']);
		const div = aw.sessions[0].divisions[0];
		expect(div.places).toEqual([expect.objectContaining({ place: 1, team: 'Birch High School', record: '4–2', points: '800' })]);
		const wb = await xlsx();
		const ws = wb.worksheets.find((w) => w.name === 'Afternoon Public 4A–7A')!;
		const rows = ws.getSheetValues().slice(2).map((r) => (r as unknown[]).filter((v) => v !== undefined));
		expect(rows.map((r) => [r[0], r[1], r[2], r.at(-4), r.at(-3), r.at(-2)])).toEqual([
			[1, 'Birch High School', '5A', 4, 2, 800],
			[2, 'Cypress High School', '5A', 3, 3, 900],
			[3, 'Alder High School', '5A', 3, 3, 790],
			[4, 'Dogwood High School', '5A', 2, 4, 700],
			[5, 'Elm High School', '6A', 2, 2, 460],
			[5, 'Fir High School', '6A', 2, 2, 460],
			[5, 'Ginkgo High School', '6A', 2, 2, 460],
			[8, 'Hawthorn High School', '7A', 0, 0, 0]
		]);
		// Each team's points equal the sum of the scores shown in its counting games' round cells.
		for (const r of rows) {
			const sum = r.filter((c) => typeof c === 'string' && /^[WLT] /.test(c)).reduce((a: number, c) => a + Number(/^[WLT] (\d+(?:\.\d+)?)–/.exec(c as string)![1]), 0);
			expect([r[1], sum]).toEqual([r[1], r.at(-2)]);
		}
		const games = wb.worksheets.find((w) => w.name === 'Games')!;
		expect(games.rowCount - 1).toBe(FIVE_A.length + SIX_A.length + 6);
	});
});

describe('SV3 a wrong entry found after approval, corrected by the head scorekeeper', () => {
	it('flows through the round, standings, awards, and Excel', async () => {
		const ids = playDayFixed();
		const r2 = ids['2:Alder']; // Alder 110 – Cypress 130
		const log = matchEvents(r2);
		// The first tossup Cypress answered was really Alder's (wrong team clicked), with its bonus.
		const ans = log.find((e) => e.body.type === 'tossup_answer' && e.body.side === 'B' && e.body.correct)!;
		const t = (ans.body as { tossup: number }).tossup;
		const bon = log.find((e) => e.body.type === 'bonus' && e.body.tossup === t)!;
		const bonusPts = (bon.body as { value: number; parts: string[] }).parts[0] === 'correct' ? (bon.body as { value: number }).value / 100 : 0;
		expect(bonusPts).toBe(30); // plan(130) → first bonus is 30
		expect(staff(r2, { type: 'correction', action: 'amend', target: ans.id, replacement: { ...(ans.body as Extract<EventBody, { type: 'tossup_answer' }>), side: 'A', playerId: players.Alder[0] }, reason: 'wrong team clicked' }).status).toBe('accepted');
		expect(staff(r2, { type: 'correction', action: 'amend', target: bon.id, replacement: { ...(bon.body as Extract<EventBody, { type: 'bonus' }>), side: 'A' }, reason: 'wrong team clicked' }).status).toBe('accepted');

		// Before re-approval: the round drops out of final standings, and finalize is blocked.
		let live = computeLive(eventId);
		const m = live.matches.find((x) => x.id === r2)!;
		expect([m.result.teams.A.roundScore, m.result.teams.B.roundScore]).toEqual([P(150), P(90)]);
		expect(m.result.winner).toBe('A');
		expect(m.result.status).toBe('submitted');
		expect(live.final.pendingMatchIds).toContain(String(r2));

		staff(r2, { type: 'approved' });
		live = computeLive(eventId);
		const name = (id: string) => live.teams.find((t) => t.id === id)!.name.replace(' High School', '');
		// Hand: Alder 4–2 (790 + 40 = 830), Birch 4–2 (800), Cypress 2–4 (900 − 40 = 860), Dogwood 2–4 (700).
		// Alder and Birch tie on wins; Alder has more points → Alder 1st. Cypress over Dogwood on points.
		const div = live.final.divisions.find((d) => d.label === 'Public 4A–7A')!;
		expect(div.rows.map((r) => [name(r.teamId), r.place, r.record.wins, r.record.losses, r.record.totalPoints / 100])).toEqual([
			['Alder', 1, 4, 2, 830],
			['Birch', 2, 4, 2, 800],
			['Cypress', 3, 2, 4, 860],
			['Dogwood', 4, 2, 4, 700],
			['Elm', 5, 2, 2, 460],
			['Fir', 5, 2, 2, 460],
			['Ginkgo', 5, 2, 2, 460],
			['Hawthorn', 8, 0, 0, 0]
		]);
		const aw = awardsData(eventId).sessions[0].divisions.find((c) => c.label === 'Public 4A–7A')!;
		expect(aw.places[0].team).toBe('Alder High School');
		const wb = await xlsx();
		const ws = wb.worksheets.find((w) => w.name === 'Afternoon Public 4A–7A')!;
		expect((ws.getRow(2).values as unknown[])[2]).toBe('Alder High School');
		// Individual: Alder player 1 gains 10, the Cypress player who had been credited loses 10.
		const rows = live.final.individuals.flatMap((g) => g.rows);
		const cypressPlayer = (ans.body as { playerId: string }).playerId;
		expect(rows.find((r) => r.playerId === players.Alder[0])!.total).toBe(P((tally.get(players.Alder[0]) ?? 0) + 10));
		expect(rows.find((r) => r.playerId === cypressPlayer)!.total).toBe(P((tally.get(cypressPlayer) ?? 0) - 10));
	});
});

describe('SV4 a team that leaves mid-event', () => {
	it('Dogwood plays rounds 1–3 and goes home; its remaining games are recorded as forfeits', async () => {
		// Rounds 1–3 played and approved; Dogwood leaves; rounds 4–6 for everyone else are played.
		const ids: number[] = [];
		const dogwoodLater: number[] = [];
		for (const [rd, a, sa, b, sb] of FIVE_A) {
			const room = FIVE_A.filter((x) => x[0] === rd).findIndex((x) => x[1] === a);
			const m = addMatch(rd, room, a, b);
			if (rd >= 4 && (a === 'Dogwood' || b === 'Dogwood')) {
				dogwoodLater.push(m.id);
				continue;
			}
			play(m, a, b, sa, sb);
			staff(m.id, { type: 'approved' });
			ids.push(m.id);
		}
		getDb().update(schema.teams).set({ withdrawn: true }).where(eq(schema.teams.id, team.Dogwood)).run();
		// The dashboard lists Dogwood's unplayed games; one button forfeits them all.
		let live = computeLive(eventId, { sessionIds: [sessionId] });
		expect(live.withdrawn.map((w) => [w.name, w.games.map((g) => g.matchId)])).toEqual([['Dogwood High School', dogwoodLater]]);
		expect(JSON.stringify(await callAction('forfeitAll', { teamId: String(team.Dogwood), reason: 'Went home after round 3' }))).toMatch(/Recorded 3 forfeits/);
		live = computeLive(eventId);
		expect(live.withdrawn).toEqual([]);
		for (const id of dogwoodLater) {
			const r = live.matches.find((m) => m.id === id)!.result;
			expect([r.status, r.teams.A.totalPoints, r.teams.B.totalPoints]).toEqual(['forfeit', 0, 0]);
		}
		const name = (id: string) => live.teams.find((t) => t.id === id)?.name.replace(' High School', '');
		// Rules doc: a team not present within 5 minutes forfeits. Hand calculation: Cypress (R4), Birch (R5),
		// and Alder (R6) each get a forfeit win with no points for either team.
		const div = live.final.divisions.find((d) => d.label === 'Public 4A–7A')!;
		expect(div.rows.slice(0, 4).map((r) => [name(r.teamId), r.place, r.record.wins, r.record.losses, r.record.totalPoints / 100])).toEqual([
			['Cypress', 1, 4, 2, 810],
			['Alder', 2, 4, 2, 690],
			['Birch', 3, 4, 2, 660],
			['Dogwood', 4, 0, 6, 320]
		]);
		// The other division teams have played no games and sit below.
		expect(div.rows.slice(4).every((r) => r.place > 4 && r.record.played === 0)).toBe(true);
		expect(dogwoodLater.length).toBe(3);
		// Forfeits are final, so the session can be finalized (after any individual tie at an award place is decided).
		for (const f of live.flags.filter((x) => x.tie)) await callAction('resolveTie', { kind: f.tie!.kind, groupKey: f.tie!.groupKey, ordered: f.tie!.ids.join(','), note: 'QA: sudden-death question' });
		expect(JSON.stringify(await callAction('finalize', { sessionId: String(sessionId) }))).toMatch(/Session finalized/);
		// Excel: W/L forfeit cells, and "forfeit" in the Games sheet's status column.
		const wb = await xlsx();
		const ws = wb.worksheets.find((w) => w.name === 'Afternoon Public 4A–7A')!;
		const cypress = (ws.getSheetValues() as unknown[][]).find((r) => r?.[2] === 'Cypress High School')!;
		expect(cypress[4 + 3]).toBe('W forfeit vs Dogwood High School');
		const dogwood = (ws.getSheetValues() as unknown[][]).find((r) => r?.[2] === 'Dogwood High School')!;
		expect(dogwood[4 + 5]).toBe('L forfeit vs Alder High School');
		const games = wb.worksheets.find((w) => w.name === 'Games')!;
		expect((games.getSheetValues() as unknown[][]).filter((r) => r?.[7] === 'forfeit')).toHaveLength(3);
	});
});

describe('SV5 late registration, walk-ins, and re-importing the website export', () => {
	const row = (over: Partial<RegistrationRow>): RegistrationRow => ({
		rowNumber: 2, registrationId: null, schoolName: 'X', classification: '5A', session: 'afternoon', status: 'confirmed', registeredAt: '2026-10-01 10:00:00',
		contactName: null, contactEmail: null, contactPhone: null, competingStudents: 6, coaches: 1, ...over
	});
	const ex = (over: Partial<ExistingTeam>): ExistingTeam => ({
		id: 1, registrationId: null, name: 'X', registrationName: null, classification: '5A', sessionId: 1, registrationStatus: 'confirmed',
		contactName: null, contactEmail: null, contactPhone: null, competingStudents: 6, coaches: 1, withdrawn: false, ...over
	});
	const sessions = [{ id: 1, name: 'Afternoon', classifications: ['5A', '6A', '7A'] }];

	it('a walk-in added by hand is not duplicated when it later shows up in the export', () => {
		const p = buildPreview([row({ registrationId: 77, schoolName: 'Walkin  High School' })], [ex({ id: 9, name: 'Walkin High School' })], sessions, '2026-01-01');
		expect(p[0].include).toBe(false);
		expect(p[0].notes.join(' ')).toMatch(/already in this event/);
	});

	it('a late registration after the first import comes in as one new team', () => {
		const p = buildPreview([row({ registrationId: 10, schoolName: 'A HS' }), row({ registrationId: 11, schoolName: 'Late HS', registeredAt: '2026-10-27 21:00:00' })], [ex({ id: 1, registrationId: 10, name: 'A HS' })], sessions, '2026-01-01');
		expect(p.map((r) => [r.schoolName, r.action, r.include])).toEqual([['A HS', 'unchanged', false], ['Late HS', 'new', true]]);
	});

	it('a no-show marked withdrawn at check-in is NOT silently reinstated by a re-import', () => {
		const p = buildPreview([row({ registrationId: 10, schoolName: 'Noshow HS' })], [ex({ id: 1, registrationId: 10, name: 'Noshow HS', withdrawn: true })], sessions, '2026-01-01');
		// Hand expectation: the website still says "confirmed" (a no-show doesn't cancel online),
		// so the re-import should leave the team withdrawn unless someone deliberately ticks it.
		expect(p[0].include).toBe(false);
	});
});

describe('SV6 two people at once, refreshes, and double submits', () => {
	it('a resent batch after a lost response is not double counted', () => {
		const m = addMatch(1, 0, 'Alder', 'Birch');
		const ctx = roomCtx(m.roomId);
		const evs = [
			{ id: uuid(), matchId: m.id, deviceSeq: 1, body: { type: 'round_started', lineups: { A: players.Alder.slice(0, 4), B: players.Birch.slice(0, 4) } } as EventBody },
			{ id: uuid(), matchId: m.id, deviceSeq: 2, body: { type: 'tossup_answer', tossup: 1, side: 'A', playerId: players.Alder[0], correct: true } as EventBody }
		];
		ingestEvents(ctx, evs);
		expect(ingestEvents(ctx, evs).map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
		expect(computeRound(matchEvents(m.id), HIGH_SCHOOL_DEFAULTS).teams.A.roundScore).toBe(P(10));
	});

	it('double-clicking Submit stores one submission', () => {
		const m = addMatch(1, 0, 'Alder', 'Birch');
		play(m, 'Alder', 'Birch', 100, 80, { submit: false });
		const ctx = roomCtx(m.roomId);
		const sub = (): { id: string; matchId: number; body: EventBody } => ({ id: uuid(), matchId: m.id, body: { type: 'submitted', scoreA: P(100), scoreB: P(80) } });
		const res = ingestEvents(ctx, [sub(), sub()]);
		expect(res.map((r) => r.status)).toEqual(['accepted', 'rejected']);
		expect(matchEvents(m.id).filter((e) => e.body.type === 'submitted')).toHaveLength(1);
	});

	it('a second computer signed into the same room cannot score until it takes over; then the first is locked out', () => {
		const m = addMatch(1, 0, 'Alder', 'Birch');
		send(m.id, m.roomId, { type: 'round_started', lineups: { A: players.Alder.slice(0, 4), B: players.Birch.slice(0, 4) } });
		const intruder = roomCtx(m.roomId, 'dev-second');
		expect(ingestEvents(intruder, [{ id: uuid(), matchId: m.id, body: { type: 'tossup_dead', tossup: 1 } }])[0].reason).toBe('device_replaced');
		getDb().update(schema.rooms).set({ activeDeviceId: 'dev-second' }).where(eq(schema.rooms.id, m.roomId)).run(); // takeover
		expect(ingestEvents(intruder, [{ id: uuid(), matchId: m.id, body: { type: 'tossup_dead', tossup: 1 } }])[0].status).toBe('accepted');
		expect(send(m.id, m.roomId, { type: 'tossup_dead', tossup: 2 }).reason).toBe('device_replaced');
	});

	it('a staff correction while the room is still scoring does not get undone by the room', () => {
		const m = addMatch(1, 0, 'Alder', 'Birch');
		send(m.id, m.roomId, { type: 'round_started', lineups: { A: players.Alder.slice(0, 4), B: players.Birch.slice(0, 4) } });
		const a = send(m.id, m.roomId, { type: 'tossup_answer', tossup: 1, side: 'A', playerId: players.Alder[0], correct: true });
		const fix = staff(m.id, { type: 'correction', action: 'void', target: matchEvents(m.id).find((e) => e.seq === a.seq)!.id, reason: 'moderator ruled it wrong' });
		expect(fix.status).toBe('accepted');
		const fixId = matchEvents(m.id).find((e) => e.seq === fix.seq)!.id;
		const r = ingestEvents(roomCtx(m.roomId), [{ id: uuid(), matchId: m.id, body: { type: 'undo', target: fixId } }])[0];
		expect(r.reason).toBe('not_allowed');
		expect(computeRound(matchEvents(m.id), HIGH_SCHOOL_DEFAULTS).teams.A.roundScore).toBe(0);
	});

	it('offline actions that reach the server after Submit are rejected and kept for the audit', () => {
		const m = addMatch(1, 0, 'Alder', 'Birch');
		play(m, 'Alder', 'Birch', 100, 80);
		const late = send(m.id, m.roomId, { type: 'tossup_dead', tossup: 24 });
		expect(late.reason).toBe('round_submitted');
		expect(getDb().select().from(schema.rejectedEvents).all().length).toBe(1);
	});
});

describe('SV9 tiebreaker points never count toward total points (decision Oct 21)', () => {
	it('a 50–50 round won in a tiebreaker: the win, 50 total points (not 60), and no individual credit', async () => {
		const m = addMatch(1, 0, 'Alder', 'Birch');
		play(m, 'Alder', 'Birch', 50, 50, { submit: false });
		const answerer = players.Birch[3];
		send(m.id, m.roomId, { type: 'tiebreaker_started' });
		send(m.id, m.roomId, { type: 'tossup_answer', tossup: 1, tiebreaker: true, side: 'B', playerId: answerer, correct: true });
		send(m.id, m.roomId, { type: 'submitted', scoreA: P(50), scoreB: P(60) });
		staff(m.id, { type: 'approved' });
		const live = computeLive(eventId);
		const r = live.matches.find((x) => x.id === m.id)!.result;
		expect([r.status, r.winner, r.decidedByTiebreaker]).toEqual(['approved', 'B', true]);
		expect(live.final.records[String(team.Birch)]).toMatchObject({ wins: 1, losses: 0, totalPoints: P(50) });
		expect(live.final.records[String(team.Alder)]).toMatchObject({ wins: 0, losses: 1, totalPoints: P(50) });
		const ind = live.final.individuals.flatMap((g) => g.rows).find((x) => x.playerId === answerer)!;
		expect(ind.total).toBe(P(tally.get(answerer) ?? 0));
		// Reports show the regulation score and who won in the tiebreaker.
		const wb = await xlsx();
		const ws = wb.worksheets.find((w) => w.name === 'Afternoon Public 4A–7A')!;
		const birch = (ws.getSheetValues() as unknown[][]).find((x) => x?.[2] === 'Birch High School')!;
		expect(birch[4]).toBe('W 50–50 vs Alder High School (won in tiebreaker)');
	});
});

// ---------- helpers that need the module state ----------

function playDayFixed() {
	const ids: Record<string, number> = {};
	const [extra] = getDb().insert(schema.rooms).values({ eventId, name: 'Room 110', sortOrder: 9, pin: '999111', projectorToken: 'qa-proj-110' }).returning().all();
	getDb().update(schema.rooms).set({ activeDeviceId: `dev-${extra.id}` }).where(eq(schema.rooms.id, extra.id)).run();
	getDb().insert(schema.sessionRooms).values({ sessionId, roomId: extra.id }).run();
	rooms.push({ id: extra.id, name: extra.name });
	for (const [rd, a, sa, b, sb] of FIVE_A) {
		const room = FIVE_A.filter((x) => x[0] === rd).findIndex((x) => x[1] === a);
		const m = addMatch(rd, room, a, b);
		ids[`${rd}:${a}`] = m.id;
		play(m, a, b, sa, sb, a === 'Alder' && rd === 4 ? { lineupA: [players.Alder[0], players.Alder[1], players.Alder[4], players.Alder[5]] } : {});
	}
	for (const [rd, a, sa, b, sb] of SIX_A) {
		const m = addMatch(rd, 2, a, b);
		ids[`${rd}:${a}`] = m.id;
		play(m, a, b, sa, sb);
	}
	for (let rd = 1; rd <= 6; rd++) {
		const m = addMatch(rd, rooms.length - 1, BYE[rd], 'Hawthorn', false);
		ids[`nc${rd}`] = m.id;
		const before = new Map(tally);
		play(m, BYE[rd], 'Hawthorn', 60, 300);
		tally = before;
	}
	for (const id of Object.values(ids)) staff(id, { type: 'approved' });
	return ids;
}
void teamRoster;

async function callAction(name: 'finalize' | 'resolveTie' | 'forfeitAll', form: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.set(k, v);
	const request = new Request('http://localhost/x', { method: 'POST', body: fd });
	try {
		return await (liveActions[name] as (e: unknown) => Promise<unknown>)({ request, locals: { auth: adminAuth }, params: { id: String(eventId) } });
	} catch (e) {
		return e;
	}
}

async function xlsx() {
	const res = await (exportXlsx as (e: unknown) => Promise<Response>)({ params: { id: String(eventId) }, locals: { auth: adminAuth } });
	const wb = new ExcelJS.Workbook();
	await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
	return wb;
}

describe('SV8 replay of a real day: 2024 morning 1A/2A/3A pool (tossup points from the 2024 sheet)', () => {
	it('pooled play, one Public 1A–3A award division, and a 3-player team', async () => {
		const ids: Record<string, number> = {};
		getDb().transaction((tx) => {
			for (const [name, cls] of [['Wadley', '1A'], ['Ranburne', '2A'], ['Dadeville', '3A']] as const) {
				ids[name] = createTeam(tx, eventId, { name: `${name} QA`, classification: cls, sessionId, source: 'manual' });
				team[name] = ids[name];
				players[name] = [];
				const n = name === 'Dadeville' ? 3 : 5;
				for (let i = 1; i <= n; i++) players[name].push(addPlayerToTeam(tx, ids[name], { firstName: `${name}${i}`, lastName: 'Test' }));
			}
		});
		getDb().update(schema.sessions).set({ classifications: ['1A', '2A', '3A'] }).where(eq(schema.sessions.id, sessionId)).run();
		const { savePools } = await import('$lib/server/schedule');
		savePools(sessionId, { '1A': '1A–3A', '2A': '1A–3A', '3A': '1A–3A' });
		// From the 2024 sheet: Ranburne 4–0 (480), Wadley 2–2 (220), Dadeville 0–4 (170).
		const games: [number, string, number, string, number][] = [
			[1, 'Wadley', 30, 'Ranburne', 160], [2, 'Wadley', 80, 'Dadeville', 60], [3, 'Ranburne', 110, 'Dadeville', 60],
			[4, 'Wadley', 30, 'Ranburne', 110], [5, 'Wadley', 80, 'Dadeville', 10], [6, 'Ranburne', 100, 'Dadeville', 40]
		];
		for (const [rd, a, sa, b, sb] of games) {
			const m = addMatch(rd, 0, a, b);
			play(m, a, b, sa, sb, { tossupsOnly: true, lineupA: players[a].slice(0, 4), lineupB: players[b].slice(0, 4) });
			staff(m.id, { type: 'approved' });
		}
		const live = computeLive(eventId);
		const pool = live.final.pools.find((p) => p.label === '1A–3A')!;
		const nm = (id: string) => live.teams.find((t) => t.id === id)!.name.replace(' QA', '');
		expect(pool.rows.map((r) => [nm(r.teamId), r.place, `${r.record.wins}-${r.record.losses}`, r.record.totalPoints / 100])).toEqual([
			['Ranburne', 1, '4-0', 480], ['Wadley', 2, '2-2', 220], ['Dadeville', 3, '0-4', 170]
		]);
		// Awards (decision Oct 21): one Public 1A–3A division for the three schools, not three sole-team firsts.
		const div = live.final.divisions.find((d) => d.label === 'Public 1A–3A')!;
		expect(div.rows.map((r) => [nm(r.teamId), r.place, `${r.record.wins}-${r.record.losses}`, r.record.totalPoints / 100])).toEqual([
			['Ranburne', 1, '4-0', 480], ['Wadley', 2, '2-2', 220], ['Dadeville', 3, '0-4', 170]
		]);
		const aw = awardsData(eventId).sessions[0].divisions.find((c) => c.label === 'Public 1A–3A')!;
		expect([aw.soleTeam, aw.places.map((p) => [p.place, p.team.replace(' QA', '')])]).toEqual([false, [[1, 'Ranburne']]]);
		// Individuals: sum of each team's individual totals equals its tossup points.
		const rows = live.final.individuals.flatMap((g) => g.rows);
		for (const n of ['Wadley', 'Ranburne', 'Dadeville'])
			expect(rows.filter((r) => r.teamId === String(ids[n])).reduce((a, r) => a + r.total, 0)).toBe(P({ Wadley: 220, Ranburne: 480, Dadeville: 170 }[n]!));
	});
});
