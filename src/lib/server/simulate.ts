import { computeRound, type EventBody, type RuleSettings, type ScoreEvent, type Side } from '$lib/engine';
import { asc, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { publish } from './bus';
import { getDb, schema } from './db';
import { getEvent } from './events';
import { ingestEvents, matchEvents, ROOM_TYPES, rulesForMatch, STAFF_TYPES } from './ingest';
import { rng } from './practice';
import { teamRoster } from './teams';

/**
 * Plausible scoring script for one game, used to auto-play practice events.
 * Includes wrong answers, dead tossups, partial bonuses, occasional undos,
 * the tossup-12 announcement, and a tiebreaker when the score ends level.
 */
export function scriptGame(lineups: Record<Side, string[]>, rules: RuleSettings, seed: number): EventBody[] {
	const rand = rng(seed);
	const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
	const strength = { A: 0.35 + rand() * 0.4, B: 0.35 + rand() * 0.4 };
	const out: EventBody[] = [{ type: 'round_started', lineups }];
	const player = (s: Side) => (lineups[s].length ? pick(lineups[s]) : null);
	const tossups = rand() < 0.3 ? rules.round.maxTossups : 16 + Math.floor(rand() * (rules.round.maxTossups - 15));
	for (let n = 1; n <= tossups; n++) {
		if (rand() < 0.12) {
			out.push({ type: 'tossup_dead', tossup: n });
		} else {
			const first: Side = rand() < strength.A / (strength.A + strength.B) ? 'A' : 'B';
			const second: Side = first === 'A' ? 'B' : 'A';
			let winner: Side | null = null;
			if (rand() < 0.72) winner = first;
			else {
				out.push({ type: 'tossup_answer', tossup: n, side: first, playerId: player(first), correct: false });
				if (rand() < 0.55) winner = second;
				else out.push({ type: 'tossup_answer', tossup: n, side: second, playerId: player(second), correct: false });
			}
			if (winner) {
				out.push({ type: 'tossup_answer', tossup: n, side: winner, playerId: player(winner), correct: true });
				const value = pick(rules.bonus.quickValues);
				const parts = 1 + Math.floor(rand() * 3);
				out.push({ type: 'bonus', tossup: n, side: winner, value, parts: Array.from({ length: parts }, () => (rand() < strength[winner!] + 0.2 ? 'correct' : 'incorrect')) });
			}
		}
		if (n === rules.round.announceAfterTossup) out.push({ type: 'note', text: `Score announced after tossup ${n}` });
	}
	return out;
}

interface SimRun {
	eventId: number;
	sessionId: number;
	running: boolean;
	round: number;
	rounds: number;
	done: number;
	total: number;
	startedBy: string;
	timer: ReturnType<typeof setTimeout> | null;
	error: string | null;
}

const runs = new Map<number, SimRun>();

export function simulationStatus(sessionId: number) {
	const r = runs.get(sessionId);
	return r ? { running: r.running, round: r.round, rounds: r.rounds, done: r.done, total: r.total, error: r.error } : null;
}

export function stopSimulation(sessionId: number) {
	const r = runs.get(sessionId);
	if (r) {
		r.running = false;
		if (r.timer) clearTimeout(r.timer);
		publish({ type: 'session', eventId: r.eventId, sessionId });
	}
}

/** Play every unstarted game in a practice session, round by round, one action per room every `stepMs`. */
export function startSimulation(eventId: number, sessionId: number, opts: { stepMs: number; approve: boolean; startedBy: string; approverId: number }) {
	const event = getEvent(eventId);
	if (!event.isTest) throw new Error('Simulation only runs on practice / test events.');
	if (runs.get(sessionId)?.running) return;
	const db = getDb();
	const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()!;
	const matches = db.select().from(schema.matches).where(eq(schema.matches.sessionId, sessionId)).orderBy(asc(schema.matches.roundNo)).all();
	const run: SimRun = { eventId, sessionId, running: true, round: 0, rounds: session.roundCount, done: 0, total: matches.length, startedBy: opts.startedBy, timer: null, error: null };
	runs.set(sessionId, run);

	const room = (m: (typeof matches)[number]) => ({
		eventId,
		roomId: m.roomId,
		deviceId: 'simulation',
		actor: `room:${m.roomId}`,
		actorName: 'Simulation',
		source: 'simulation' as const,
		allowed: ROOM_TYPES,
		enforceLease: false,
		lockSubmitted: true
	});
	const send = (m: (typeof matches)[number], body: EventBody) => ingestEvents(room(m), [{ id: crypto.randomUUID(), matchId: m.id, body }]);

	const playRound = (roundNo: number) => {
		if (!run.running) return;
		if (roundNo > session.roundCount) {
			run.running = false;
			publish({ type: 'session', eventId, sessionId });
			return;
		}
		run.round = roundNo;
		const these = matches.filter((m) => m.roundNo === roundNo && matchEvents(m.id).length === 0);
		const scripts = new Map(
			these.map((m) => {
				const rules = rulesForMatch(m, eventId).settings;
				const lineup = (teamId: number) => teamRoster(teamId).slice(0, rules.roster.activePlayers).map((p) => p.id);
				return [m.id, { m, rules, queue: scriptGame({ A: lineup(m.teamAId), B: lineup(m.teamBId) }, rules, m.id * 104729), finished: false }];
			})
		);
		const finish = (s: { m: (typeof matches)[number]; rules: RuleSettings; finished: boolean }) => {
			let res = computeRound(matchEvents(s.m.id), s.rules);
			// Settle ties with sudden-death tossups.
			if (res.tied) {
				send(s.m, { type: 'tiebreaker_started' });
				for (let n = 1; res.tied && n < 10; n++) {
					const side: Side = (s.m.id + n) % 2 ? 'A' : 'B';
					const lineup = res.lineups[side];
					send(s.m, { type: 'tossup_answer', tossup: n, tiebreaker: true, side, playerId: lineup[0] ?? null, correct: n > 1 || s.m.id % 3 !== 0 });
					res = computeRound(matchEvents(s.m.id), s.rules);
				}
			}
			send(s.m, { type: 'round_ended', reason: res.lastRegularTossup >= s.rules.round.maxTossups ? 'All tossups read' : 'Time called' });
			res = computeRound(matchEvents(s.m.id), s.rules);
			send(s.m, { type: 'submitted', scoreA: res.teams.A.roundScore, scoreB: res.teams.B.roundScore });
			if (opts.approve)
				ingestEvents(
					{ eventId, roomId: null, deviceId: null, actor: `user:${opts.approverId}`, actorName: `${opts.startedBy} (simulation)`, source: 'simulation', allowed: STAFF_TYPES, enforceLease: false, lockSubmitted: false },
					[{ id: crypto.randomUUID(), matchId: s.m.id, body: { type: 'approved' } }]
				);
			s.finished = true;
			run.done++;
		};
		const step = () => {
			if (!run.running) return;
			try {
				let remaining = 0;
				for (const s of scripts.values()) {
					if (s.finished) continue;
					const body = s.queue.shift();
					if (body) send(s.m, body);
					else finish(s);
					if (!s.finished) remaining++;
				}
				if (remaining === 0) {
					run.timer = setTimeout(() => playRound(roundNo + 1), opts.stepMs ? 1500 : 0);
					return;
				}
				run.timer = setTimeout(step, opts.stepMs);
			} catch (e) {
				run.error = e instanceof Error ? e.message : String(e);
				run.running = false;
			}
		};
		step();
	};
	run.timer = setTimeout(() => playRound(1), 0);
}

export type { ScoreEvent };
