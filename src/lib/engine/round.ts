import { bonusShare, formatPoints, type Hundredths } from './points';
import type { RuleSettings } from './rules';
import {
	isScoringBody,
	other,
	type BonusPart,
	type EventBody,
	type Flag,
	type RoundStatus,
	type ScoreEvent,
	type ScoringBody,
	type Side
} from './types';

export interface AnswerLine {
	eventId: string;
	side: Side;
	playerId: string | null;
	correct: boolean;
	interrupt: boolean;
	power: boolean;
	points: Hundredths;
	amended: boolean;
}

export interface BonusLine {
	eventId: string;
	side: Side;
	value: Hundredths;
	parts: BonusPart[];
	partsCorrect: number;
	partsBounceback: number;
	points: Hundredths;
	bouncebackPoints: Hundredths;
	fractional: boolean;
	inexact: boolean;
	amended: boolean;
}

export type TossupState = 'open' | 'awaiting_bonus' | 'complete';

export interface TossupLine {
	number: number;
	tiebreaker: boolean;
	answers: AnswerLine[];
	bonuses: BonusLine[];
	dead: boolean;
	state: TossupState;
	correctSide: Side | null;
	/** Points this tossup added to each side's round score. */
	points: Record<Side, Hundredths>;
	/** Round score after this tossup. */
	running: Record<Side, Hundredths>;
}

export interface TeamTotals {
	tossupPoints: Hundredths;
	negPoints: Hundredths;
	bonusPoints: Hundredths;
	bouncebackPoints: Hundredths;
	tiebreakerPoints: Hundredths;
	/** Score for this round (what is announced and decides the winner). */
	roundScore: Hundredths;
	/** Contribution to standings total points (counting games only). */
	totalPoints: Hundredths;
	tossupsCorrect: number;
	powers: number;
	negs: number;
	bonusesHeard: number;
	bonusPartsCorrect: number;
	bonusPartsHeard: number;
}

export interface PlayerTotals {
	playerId: string;
	side: Side;
	tossupPoints: Hundredths;
	negPoints: Hundredths;
	bonusPoints: Hundredths;
	tiebreakerPoints: Hundredths;
	/** Points that count toward individual awards under the event's settings. */
	individualTotal: Hundredths;
	corrects: number;
	incorrects: number;
	powers: number;
	negs: number;
}

export interface AuditEntry {
	event: ScoreEvent;
	active: boolean;
	voidedBy: ScoreEvent | null;
}

export interface RoundResult {
	status: RoundStatus;
	lineups: Record<Side, string[]>;
	tossups: TossupLine[];
	teams: Record<Side, TeamTotals>;
	players: PlayerTotals[];
	winner: Side | null;
	/** Round scores are level and no tiebreaker has decided it. */
	tied: boolean;
	decidedByTiebreaker: boolean;
	tiebreakerActive: boolean;
	/** The tossup the scorer is on now. */
	currentTossup: { number: number; tiebreaker: boolean };
	lastRegularTossup: number;
	endReason: string | null;
	endNote: string | null;
	submitted: { scoreA: Hundredths; scoreB: Hundredths; seq: number } | null;
	flags: Flag[];
	audit: AuditEntry[];
	lastSeq: number;
}

interface Item {
	body: ScoringBody;
	sortSeq: number;
	eventId: string;
	amended: boolean;
}

const emptyTeam = (): TeamTotals => ({
	tossupPoints: 0,
	negPoints: 0,
	bonusPoints: 0,
	bouncebackPoints: 0,
	tiebreakerPoints: 0,
	roundScore: 0,
	totalPoints: 0,
	tossupsCorrect: 0,
	powers: 0,
	negs: 0,
	bonusesHeard: 0,
	bonusPartsCorrect: 0,
	bonusPartsHeard: 0
});

/** Bodies that undo/void/amend another event. */
function voidTargetOf(b: EventBody): string | null {
	if (b.type === 'undo') return b.target;
	if (b.type === 'correction' && (b.action === 'void' || b.action === 'amend')) return b.target;
	return null;
}

function validScoringBody(b: ScoringBody): boolean {
	if (!Number.isInteger(b.tossup) || b.tossup < 1) return false;
	if (b.type === 'tossup_answer') return b.side === 'A' || b.side === 'B';
	if (b.type === 'bonus')
		return (
			(b.side === 'A' || b.side === 'B') &&
			Number.isInteger(b.value) &&
			b.value >= 0 &&
			Array.isArray(b.parts) &&
			b.parts.length >= 1 &&
			b.parts.every((p) => p === 'correct' || p === 'incorrect' || p === 'bounceback')
		);
	return true;
}

/**
 * The scoring function. Every score, standing, and leaderboard in the app is
 * derived from a round's event log through this function. It is pure and
 * tolerant: anomalies are reported as flags, never thrown.
 */
export function computeRound(events: readonly ScoreEvent[], rules: RuleSettings): RoundResult {
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	const byId = new Map(sorted.map((e) => [e.id, e]));
	const flags: Flag[] = [];

	// 1. Resolve undo / void / amend in log order. Undoing an undo restores its target.
	const voidedBy = new Map<string, string>();
	const voidEvent = (targetId: string, by: ScoreEvent) => {
		const target = byId.get(targetId);
		if (!target || target.seq > by.seq) {
			flags.push({ kind: 'unknown_target', message: `Event refers to an unknown earlier event`, eventId: by.id });
			return;
		}
		if (voidedBy.has(targetId)) {
			flags.push({ kind: 'already_voided', message: `Event was already undone or voided`, eventId: by.id });
			return;
		}
		voidedBy.set(targetId, by.id);
		const inner = voidTargetOf(target.body);
		if (inner && voidedBy.get(inner) === target.id) voidedBy.delete(inner);
	};
	for (const e of sorted) {
		const t = voidTargetOf(e.body);
		if (t) voidEvent(t, e);
	}
	const active = (e: ScoreEvent) => !voidedBy.has(e.id);

	// 2. Walk active events: lifecycle state, lineups, and effective scoring items.
	const lineups: Record<Side, string[]> = { A: [], B: [] };
	const everInLineup: Record<Side, Set<string>> = { A: new Set(), B: new Set() };
	let started = false;
	let tiebreakerActive = false;
	let ended: { reason: string; note: string | null } | null = null;
	let submitted: RoundResult['submitted'] = null;
	let approvedSeq: number | null = null;
	/** Latest scoring change or correction; an approval older than this no longer stands. */
	let lastChangeSeq = -Infinity;
	let lastChangeAfterSubmit = false;
	const items: Item[] = [];

	for (const e of sorted) {
		if (!active(e)) continue;
		const b = e.body;
		if (isScoringBody(b)) {
			if (!validScoringBody(b)) {
				flags.push({ kind: 'invalid_event', message: 'Malformed scoring event ignored', eventId: e.id });
				continue;
			}
			items.push({ body: b, sortSeq: e.seq, eventId: e.id, amended: false });
			lastChangeSeq = e.seq;
			if (submitted && e.seq > submitted.seq) lastChangeAfterSubmit = true;
			continue;
		}
		switch (b.type) {
			case 'round_started':
				started = true;
				for (const s of ['A', 'B'] as const) {
					lineups[s] = [...(b.lineups?.[s] ?? [])];
					lineups[s].forEach((p) => everInLineup[s].add(p));
				}
				break;
			case 'lineup_set':
				lineups[b.side] = [...b.players];
				b.players.forEach((p) => everInLineup[b.side].add(p));
				break;
			case 'tiebreaker_started':
				tiebreakerActive = true;
				break;
			case 'round_ended':
				ended = { reason: b.reason, note: b.note ?? null };
				break;
			case 'submitted':
				submitted = { scoreA: b.scoreA, scoreB: b.scoreB, seq: e.seq };
				break;
			case 'approved':
				approvedSeq = e.seq;
				break;
			case 'unapproved':
				approvedSeq = null;
				break;
			case 'correction': {
				lastChangeSeq = e.seq;
				if (submitted) lastChangeAfterSubmit = true;
				if (b.action === 'amend' || b.action === 'add') {
					if (!validScoringBody(b.replacement)) {
						flags.push({ kind: 'invalid_event', message: 'Malformed correction ignored', eventId: e.id });
						break;
					}
					const target = b.action === 'amend' ? byId.get(b.target) : undefined;
					items.push({
						body: b.replacement,
						sortSeq: target ? target.seq : e.seq,
						eventId: e.id,
						amended: true
					});
				}
				break;
			}
		}
	}

	// 3. Group items into tossups: regular tossups in number order, then tiebreakers.
	const groups = new Map<string, { number: number; tiebreaker: boolean; items: Item[] }>();
	for (const it of items) {
		const tb = it.body.type !== 'bonus' && !!it.body.tiebreaker;
		const key = `${tb ? 'T' : 'R'}${it.body.tossup}`;
		let g = groups.get(key);
		if (!g) groups.set(key, (g = { number: it.body.tossup, tiebreaker: tb, items: [] }));
		g.items.push(it);
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.tiebreaker !== b.tiebreaker ? (a.tiebreaker ? 1 : -1) : a.number - b.number
	);

	const teams: Record<Side, TeamTotals> = { A: emptyTeam(), B: emptyTeam() };
	const players = new Map<string, PlayerTotals>();
	const player = (side: Side, id: string): PlayerTotals => {
		const key = `${side}:${id}`;
		let p = players.get(key);
		if (!p) {
			p = {
				playerId: id,
				side,
				tossupPoints: 0,
				negPoints: 0,
				bonusPoints: 0,
				tiebreakerPoints: 0,
				individualTotal: 0,
				corrects: 0,
				incorrects: 0,
				powers: 0,
				negs: 0
			};
			players.set(key, p);
		}
		return p;
	};

	const tossups: TossupLine[] = [];
	const running: Record<Side, Hundredths> = { A: 0, B: 0 };
	const tbInRound = rules.tiebreaker.countsInRoundScore;

	for (const g of ordered) {
		g.items.sort((a, b) => a.sortSeq - b.sortSeq);
		const line: TossupLine = {
			number: g.number,
			tiebreaker: g.tiebreaker,
			answers: [],
			bonuses: [],
			dead: false,
			state: 'open',
			correctSide: null,
			points: { A: 0, B: 0 },
			running: { A: 0, B: 0 }
		};
		const where = { tossup: g.number, tiebreaker: g.tiebreaker };
		const label = `${g.tiebreaker ? 'Tiebreaker ' : 'Tossup '}${g.number}`;
		const sidesAnswered = new Set<Side>();
		let correctAnswer: AnswerLine | null = null;

		for (const it of g.items) {
			const b = it.body;
			if (b.type === 'tossup_dead') {
				line.dead = true;
				continue;
			}
			if (b.type === 'tossup_answer') {
				if (correctAnswer) {
					flags.push({
						kind: b.correct ? 'multiple_correct' : 'answer_after_correct',
						message: `${label}: answer recorded after a correct answer`,
						eventId: it.eventId,
						...where
					});
				}
				if (sidesAnswered.has(b.side))
					flags.push({ kind: 'same_side_twice', message: `${label}: team ${b.side} answered twice`, eventId: it.eventId, ...where });
				sidesAnswered.add(b.side);

				const interrupt = !!b.interrupt;
				const power = b.correct && !!b.power && rules.power.enabled;
				let pts = 0;
				if (b.correct) pts = power ? rules.power.points : rules.tossupPoints;
				else if (rules.neg.enabled && (interrupt || !rules.neg.onlyOnInterrupt)) pts = -rules.neg.points;

				const a: AnswerLine = {
					eventId: it.eventId,
					side: b.side,
					playerId: b.playerId ?? null,
					correct: b.correct,
					interrupt,
					power,
					points: pts,
					amended: it.amended
				};
				line.answers.push(a);
				if (b.correct && !correctAnswer) {
					correctAnswer = a;
					line.correctSide = b.side;
				}

				const team = teams[b.side];
				if (g.tiebreaker) {
					team.tiebreakerPoints += pts;
					if (tbInRound) line.points[b.side] += pts;
				} else {
					if (b.correct) {
						team.tossupPoints += pts;
						team.tossupsCorrect++;
						if (power) team.powers++;
					} else {
						team.negPoints += pts;
						if (pts < 0) team.negs++;
					}
					line.points[b.side] += pts;
				}

				if (b.playerId) {
					if (!everInLineup[b.side].has(b.playerId) && everInLineup[b.side].size > 0)
						flags.push({ kind: 'player_not_in_lineup', message: `${label}: player is not in team ${b.side}'s lineup`, eventId: it.eventId, ...where });
					const p = player(b.side, b.playerId);
					if (b.correct) p.corrects++;
					else p.incorrects++;
					if (power) p.powers++;
					if (pts < 0) p.negs++;
					if (g.tiebreaker) p.tiebreakerPoints += pts;
					else if (b.correct) p.tossupPoints += pts;
					else p.negPoints += pts;
				} else if (b.correct) {
					flags.push({ kind: 'unattributed_answer', message: `${label}: correct answer not credited to a player`, eventId: it.eventId, ...where });
				}
				continue;
			}
			// bonus
			if (g.tiebreaker)
				flags.push({ kind: 'bonus_in_tiebreaker', message: `${label}: bonus recorded on a tiebreaker`, eventId: it.eventId, ...where });
			if (!correctAnswer)
				flags.push({ kind: 'bonus_without_correct', message: `${label}: bonus recorded before a correct tossup answer`, eventId: it.eventId, ...where });
			else if (b.side !== correctAnswer.side)
				flags.push({ kind: 'bonus_wrong_team', message: `${label}: bonus credited to the team that did not answer the tossup`, eventId: it.eventId, ...where });
			if (line.bonuses.length === 1)
				flags.push({ kind: 'multiple_bonuses', message: `${label}: more than one bonus recorded`, eventId: it.eventId, ...where });

			const n = b.parts.length;
			const won = b.parts.filter((p) => p === 'correct').length;
			const bounced = b.parts.filter((p) => p === 'bounceback').length;
			if (bounced > 0 && !rules.bonus.bounceback)
				flags.push({ kind: 'bounceback_disabled', message: `${label}: bounceback recorded but bouncebacks are off`, eventId: it.eventId, ...where });
			const share = bonusShare(b.value, n, won, rules.bonus.rounding);
			const bb = bonusShare(b.value, n, bounced, rules.bonus.rounding);
			for (const [s, k] of [
				[share, won],
				[bb, bounced]
			] as const) {
				if (s.fractional)
					flags.push({
						kind: 'fractional_bonus',
						message: `${label}: bonus share is fractional (${formatPoints(b.value)} × ${k}/${n}); recorded as ${formatPoints(s.points)}`,
						eventId: it.eventId,
						...where
					});
				if (s.inexact)
					flags.push({ kind: 'inexact_bonus', message: `${label}: bonus share cannot be exact in hundredths; rounded to ${formatPoints(s.points)}`, eventId: it.eventId, ...where });
			}
			line.bonuses.push({
				eventId: it.eventId,
				side: b.side,
				value: b.value,
				parts: [...b.parts],
				partsCorrect: won,
				partsBounceback: bounced,
				points: share.points,
				bouncebackPoints: bb.points,
				fractional: share.fractional || bb.fractional,
				inexact: share.inexact || bb.inexact,
				amended: it.amended
			});
			const team = teams[b.side];
			team.bonusPoints += share.points;
			team.bonusesHeard++;
			team.bonusPartsCorrect += won;
			team.bonusPartsHeard += n;
			teams[other(b.side)].bouncebackPoints += bb.points;
			line.points[b.side] += share.points;
			line.points[other(b.side)] += bb.points;
			if (correctAnswer?.playerId && correctAnswer.side === b.side)
				player(b.side, correctAnswer.playerId).bonusPoints += share.points;
		}

		if (line.dead && line.correctSide)
			flags.push({ kind: 'dead_with_correct', message: `${label}: marked dead but has a correct answer`, ...where });

		if (line.dead) line.state = 'complete';
		else if (line.correctSide) line.state = g.tiebreaker || line.bonuses.length > 0 ? 'complete' : 'awaiting_bonus';
		else if (line.answers.length >= 2) line.state = 'complete';
		else line.state = 'open';

		running.A += line.points.A;
		running.B += line.points.B;
		line.running = { ...running };
		tossups.push(line);
	}

	// 4. Team and player totals.
	for (const s of ['A', 'B'] as const) {
		const t = teams[s];
		const base = t.tossupPoints + t.negPoints + t.bonusPoints + t.bouncebackPoints;
		t.roundScore = base + (tbInRound ? t.tiebreakerPoints : 0);
		t.totalPoints = base + (rules.tiebreaker.countsInTotalPoints ? t.tiebreakerPoints : 0);
	}
	for (const p of players.values()) {
		p.individualTotal =
			p.tossupPoints +
			p.negPoints +
			(rules.individual.includeBonus ? p.bonusPoints : 0) +
			(rules.individual.includeTiebreaker ? p.tiebreakerPoints : 0);
	}

	// 5. Winner: the first correct tiebreaker answer wins; otherwise the higher round score.
	const tbWin = tossups.find((t) => t.tiebreaker && t.correctSide)?.correctSide ?? null;
	let winner: Side | null = tbWin;
	if (!winner && teams.A.roundScore !== teams.B.roundScore)
		winner = teams.A.roundScore > teams.B.roundScore ? 'A' : 'B';
	const tied = winner === null;

	// 6. Status and round-level flags.
	const approved = approvedSeq !== null && lastChangeSeq < approvedSeq;
	let status: RoundStatus = 'not_started';
	if (started || items.length > 0) status = 'in_progress';
	if (ended) status = 'ended';
	if (submitted) status = 'submitted';
	if (submitted && approved) status = 'approved';

	const regular = tossups.filter((t) => !t.tiebreaker);
	const lastRegularTossup = regular.length ? Math.max(...regular.map((t) => t.number)) : 0;
	const finished = status === 'ended' || status === 'submitted' || status === 'approved';

	if (finished && tied)
		flags.push({ kind: 'tied_without_tiebreaker', message: 'Round ended tied with no tiebreaker winner' });
	if (submitted && lastChangeAfterSubmit)
		flags.push({ kind: 'edited_after_submission', message: 'Round was changed after it was submitted' });
	if (submitted && (submitted.scoreA !== teams.A.roundScore || submitted.scoreB !== teams.B.roundScore))
		flags.push({
			kind: 'submitted_score_mismatch',
			message: `Submitted score ${formatPoints(submitted.scoreA)}–${formatPoints(submitted.scoreB)} differs from current ${formatPoints(teams.A.roundScore)}–${formatPoints(teams.B.roundScore)}`
		});
	if (finished && rules.round.minTossups && lastRegularTossup < rules.round.minTossups)
		flags.push({ kind: 'below_min_tossups', message: `Only ${lastRegularTossup} tossups played (minimum ${rules.round.minTossups})` });
	if (lastRegularTossup > rules.round.maxTossups)
		flags.push({ kind: 'over_max_tossups', message: `Tossup ${lastRegularTossup} is past the limit of ${rules.round.maxTossups}` });

	// 7. Where the scorer is now.
	const tbLines = tossups.filter((t) => t.tiebreaker);
	let currentTossup: RoundResult['currentTossup'];
	if (tiebreakerActive || tbLines.length) {
		const last = tbLines[tbLines.length - 1];
		currentTossup = !last
			? { number: 1, tiebreaker: true }
			: last.state === 'complete'
				? { number: last.number + 1, tiebreaker: true }
				: { number: last.number, tiebreaker: true };
	} else {
		const last = regular[regular.length - 1];
		currentTossup =
			last && last.state !== 'complete'
				? { number: last.number, tiebreaker: false }
				: { number: lastRegularTossup + 1, tiebreaker: false };
	}

	const audit: AuditEntry[] = sorted.map((e) => {
		const v = voidedBy.get(e.id);
		return { event: e, active: !v, voidedBy: v ? (byId.get(v) ?? null) : null };
	});

	return {
		status,
		lineups,
		tossups,
		teams,
		players: [...players.values()],
		winner,
		tied,
		decidedByTiebreaker: tbWin !== null,
		tiebreakerActive: tiebreakerActive || tbLines.length > 0,
		currentTossup,
		lastRegularTossup,
		endReason: ended?.reason ?? null,
		endNote: ended?.note ?? null,
		submitted,
		flags,
		audit,
		lastSeq: sorted.length ? sorted[sorted.length - 1].seq : 0
	};
}
