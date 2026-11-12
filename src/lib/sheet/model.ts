import { isScoringBody, type EventBody, type FlagKind, type RoundResult, type RuleSettings, type ScoreEvent, type ScoringBody, type Side } from '$lib/engine';
import { parsePoints, type Hundredths } from '$lib/engine/points';
import type { ScorerMatch } from '$lib/scorer-types';

/**
 * The classic room scoresheet (one Excel tab per round) as a view of a round's event log.
 * Each tossup row is a set of cells; editing a row replaces that row's events (undo the old
 * ones, record the new ones), so the log stays the single source of truth for both screens.
 */

/** Tossup rows on the sheet (1–25 plus one more, used for the tiebreaker). */
export const SHEET_TOSSUPS = 26;
/** Player columns per team (B–F and K–O). */
export const SLOTS = 5;
/** 0-based grid positions on the template. */
export const FIRST_TU_ROW = 4;
export const PLAYER_COL: Record<Side, number> = { A: 1, B: 10 };
export const BONUS_COL: Record<Side, number> = { A: 6, B: 15 };
export const TOTAL_COL: Record<Side, number> = { A: 7, B: 16 };
export const CUML_COL: Record<Side, number> = { A: 8, B: 17 };
export const TU_COL = 9;
export const NOTES_COL = 18;
export const SIDES = ['A', 'B'] as const;

/** One player column: the player credited for entries in it, or an empty column (team answers). */
export interface Slot {
	playerId: string | null;
	name: string;
}

export interface RowCells {
	/** Points in hundredths, null when the cell is blank. */
	players: (Hundredths | null)[];
	bonus: Hundredths | null;
}
export type SheetRow = Record<Side, RowCells>;

export const emptyRow = (): SheetRow => ({
	A: { players: Array(SLOTS).fill(null), bonus: null },
	B: { players: Array(SLOTS).fill(null), bonus: null }
});

/** Sheet row n (1-based): regular tossup n, or a tiebreaker once past the round's last tossup. */
export function rowTossup(n: number, rules: RuleSettings): { tossup: number; tiebreaker: boolean } {
	const max = rules.round.maxTossups;
	return n <= max ? { tossup: n, tiebreaker: false } : { tossup: n - max, tiebreaker: true };
}
const rowOf = (t: { number: number; tiebreaker: boolean }, rules: RuleSettings) => (t.tiebreaker ? rules.round.maxTossups + t.number : t.number);
export const isTiebreakerRow = (n: number, rules: RuleSettings) => rowTossup(n, rules).tiebreaker;

/** Player columns for one team: the round's lineup in order (or the team's usual lineup before it starts), then anyone else credited this round. */
export function sheetSlots(match: ScorerMatch, result: RoundResult | null, side: Side): Slot[] {
	const roster = match.teams[side].roster;
	const started = !!result && result.status !== 'not_started';
	const ids = [...(started ? result.lineups[side] : match.teams[side].defaultLineup)];
	for (const t of result?.tossups ?? []) for (const a of t.answers) if (a.side === side && a.playerId && !ids.includes(a.playerId)) ids.push(a.playerId);
	const slots: Slot[] = ids.slice(0, SLOTS).map((id) => ({ playerId: id, name: roster.find((p) => p.id === id)?.name ?? 'Unknown player' }));
	while (slots.length < SLOTS) slots.push({ playerId: null, name: '' });
	return slots;
}

/** Where an answer with no player goes: the first column with no player in it. */
const teamSlot = (slots: Slot[]) => slots.findIndex((s) => !s.playerId);

/** The cells of every tossup row, read from the round. */
export function sheetRows(result: RoundResult | null, slots: Record<Side, Slot[]>, rules: RuleSettings): SheetRow[] {
	const rows = Array.from({ length: SHEET_TOSSUPS }, emptyRow);
	for (const t of result?.tossups ?? []) {
		const n = rowOf(t, rules);
		if (n < 1 || n > SHEET_TOSSUPS) continue;
		const row = rows[n - 1];
		for (const a of t.answers) {
			const i = a.playerId ? slots[a.side].findIndex((s) => s.playerId === a.playerId) : teamSlot(slots[a.side]);
			if (i < 0) continue;
			row[a.side].players[i] = (row[a.side].players[i] ?? 0) + a.points;
		}
		for (const b of t.bonuses) row[b.side].bonus = (row[b.side].bonus ?? 0) + b.points;
	}
	return rows;
}

const MODERATOR = /^Moderator: ([\s\S]*)$/;
const ROW_NOTE = /^Notes for tossup (\d+): ([\s\S]*)$/;
export const moderatorNote = (name: string): EventBody => ({ type: 'note', text: `Moderator: ${name.trim()}` });
export const rowNote = (n: number, text: string): EventBody => ({ type: 'note', text: `Notes for tossup ${n}: ${text.trim()}` });

/** The moderator's name and the per-row notes typed on the sheet (the latest of each wins). */
export function sheetNotes(result: RoundResult | null): { moderator: string; notes: string[] } {
	const out = { moderator: '', notes: Array<string>(SHEET_TOSSUPS).fill('') };
	for (const a of result?.audit ?? []) {
		const b = a.event.body;
		if (!a.active || b.type !== 'note') continue;
		const m = MODERATOR.exec(b.text);
		if (m) out.moderator = m[1];
		const r = ROW_NOTE.exec(b.text);
		if (r && Number(r[1]) >= 1 && Number(r[1]) <= SHEET_TOSSUPS) out.notes[Number(r[1]) - 1] = r[2];
	}
	return out;
}

export type ParsedCell = { ok: true; value: Hundredths | null } | { ok: false; message: string };

/** What may be typed in a player's column under the event's settings. */
export function playerValues(rules: RuleSettings): Hundredths[] {
	return [rules.tossupPoints, ...(rules.power.enabled ? [rules.power.points] : []), ...(rules.neg.enabled ? [-rules.neg.points] : []), 0];
}

const pts = (h: Hundredths) => String(h / 100);

/** Check a value typed in a player or bonus cell. */
export function parseCell(text: string, kind: 'player' | 'bonus', rules: RuleSettings, tiebreakerRow: boolean): ParsedCell {
	const t = text.trim().replace(/^\+/, '');
	if (!t) return { ok: true, value: null };
	const v = parsePoints(t);
	if (kind === 'bonus') {
		if (tiebreakerRow) return { ok: false, message: 'No bonus is played on the tiebreaker row. Enter only the tossup.' };
		if (v === null || v < 0 || v > 10000) return { ok: false, message: 'Type the bonus points the team earned, for example 20, 10 or 12.5.' };
		return { ok: true, value: v };
	}
	const allowed = playerValues(rules);
	if (v === null || !allowed.includes(v)) {
		const parts = [`${pts(rules.tossupPoints)} for a correct answer`];
		if (rules.power.enabled) parts.push(`${pts(rules.power.points)} for a power`);
		if (rules.neg.enabled) parts.push(`${pts(-rules.neg.points)} for a wrong interrupt`);
		parts.push('0 for a wrong answer');
		return { ok: false, message: `In a player's column, type ${parts.join(', ')}.` };
	}
	return { ok: true, value: v };
}

/** The scoring events a row stands for: wrong answers first, then correct answers, then bonuses. */
export function rowBodies(n: number, row: SheetRow, slots: Record<Side, Slot[]>, rules: RuleSettings): ScoringBody[] {
	const { tossup, tiebreaker } = rowTossup(n, rules);
	const tb = tiebreaker ? { tiebreaker: true } : {};
	const wrong: ScoringBody[] = [];
	const right: ScoringBody[] = [];
	const bonuses: ScoringBody[] = [];
	for (const side of SIDES) {
		row[side].players.forEach((v, i) => {
			if (v === null) return;
			const playerId = slots[side][i]?.playerId ?? null;
			if (v > 0) {
				const power = rules.power.enabled && v === rules.power.points && v !== rules.tossupPoints;
				right.push({ type: 'tossup_answer', tossup, ...tb, side, playerId, correct: true, ...(power ? { power: true } : {}) });
			} else wrong.push({ type: 'tossup_answer', tossup, ...tb, side, playerId, correct: false, ...(v < 0 ? { interrupt: true } : {}) });
		});
		const bonus = row[side].bonus;
		if (bonus !== null && !tiebreaker) bonuses.push({ type: 'bonus', tossup, side, value: bonus, parts: [bonus > 0 ? 'correct' : 'incorrect'] });
	}
	return [...wrong, ...right, ...bonuses];
}

const bodyKey = (b: ScoringBody) =>
	JSON.stringify(
		b.type === 'bonus'
			? [b.type, b.tossup, b.side, b.value, b.parts]
			: b.type === 'tossup_dead'
				? [b.type, b.tossup, !!b.tiebreaker]
				: [b.type, b.tossup, !!b.tiebreaker, b.side, b.playerId ?? null, b.correct, !!b.interrupt, !!b.power]
	);

/** This row's active scoring events from the room, and whether a staff correction touches it. */
export function rowEvents(result: RoundResult | null, n: number, rules: RuleSettings): { room: ScoreEvent[]; locked: boolean } {
	const { tossup, tiebreaker } = rowTossup(n, rules);
	const inRow = (b: ScoringBody) => b.tossup === tossup && (b.type === 'bonus' ? !tiebreaker : !!b.tiebreaker === tiebreaker);
	const byId = new Map((result?.audit ?? []).map((a) => [a.event.id, a.event]));
	const room: ScoreEvent[] = [];
	let locked = false;
	for (const a of result?.audit ?? []) {
		const b = a.event.body;
		if (!a.active) continue;
		if (isScoringBody(b) && inRow(b)) {
			if (a.event.actor.startsWith('room:')) room.push(a.event);
			else locked = true;
		} else if (b.type === 'correction') {
			if ((b.action === 'add' || b.action === 'amend') && inRow(b.replacement)) locked = true;
			if (b.action === 'void' || b.action === 'amend') {
				const t = byId.get(b.target)?.body;
				if (t && isScoringBody(t) && inRow(t)) locked = true;
			}
		}
	}
	return { room, locked };
}

/**
 * Events that make row n read `row`: nothing if it already does, just the additions if the row only
 * gained entries at its end, otherwise undo the row's current events and record it again, so answers
 * within a tossup stay in order.
 * Returns null when a staff correction touches the row (only the head scorekeeper may change it).
 */
export function rowChanges(result: RoundResult | null, n: number, row: SheetRow, slots: Record<Side, Slot[]>, rules: RuleSettings): EventBody[] | null {
	const { room, locked } = rowEvents(result, n, rules);
	if (locked) return null;
	const want = rowBodies(n, row, slots, rules);
	const have = room.map((e) => e.body as ScoringBody);
	// Only adding to the end of the row (a bonus after its tossup, say): just record the additions.
	if (have.length <= want.length && have.every((b, i) => bodyKey(b) === bodyKey(want[i]))) return want.slice(have.length);
	return [...room.map((e): EventBody => ({ type: 'undo', target: e.id })), ...want];
}

export type TuState = 'played' | 'skipped' | 'next';

export interface SheetTotals {
	/** Question total (H, Q): the row's points for each team. */
	rowTotal: Record<Side, Hundredths[]>;
	/** Cumulative score (I, R), shown only on rows where the team earned tossup points. */
	cumulative: Record<Side, (Hundredths | null)[]>;
	/** Per player column: No. of 15s, 10s, -5s and tossup points (null hides a fifth column nobody used). */
	count15: Record<Side, (number | null)[]>;
	count10: Record<Side, (number | null)[]>;
	countNeg5: Record<Side, (number | null)[]>;
	tuPoints: Record<Side, (Hundredths | null)[]>;
	subtotal: Record<Side, Hundredths>;
	bonusTotal: Record<Side, Hundredths>;
	/** Bonus conversion: bonus points per bonus entered. */
	bonusConv: Record<Side, number>;
	/** The round's score from the scoring engine (what gets submitted). */
	final: Record<Side, Hundredths>;
	/** Rows the old sheet would outline in red. */
	errorRows: boolean[];
	/** TU number highlighting: played, skipped (red), or still to come (yellow). */
	tuState: TuState[];
}

const ROW_FLAGS = new Set<FlagKind>(['multiple_correct', 'answer_after_correct', 'same_side_twice', 'bonus_without_correct', 'bonus_wrong_team', 'multiple_bonuses', 'dead_with_correct']);

/** The calculated cells, following the formulas of the old sheet. */
export function sheetTotals(rows: SheetRow[], slots: Record<Side, Slot[]>, result: RoundResult | null, rules: RuleSettings): SheetTotals {
	const per = <T>(f: (side: Side) => T): Record<Side, T> => ({ A: f('A'), B: f('B') });
	const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
	const rowTotal = per((s) => rows.map((r) => sum(r[s].players) + (r[s].bonus ?? 0)));
	const cumulative = per((s) => {
		let run = 0;
		return rows.map((r, i) => {
			run += rowTotal[s][i];
			return sum(r[s].players) !== 0 ? run : null;
		});
	});
	const column = (s: Side, i: number) => rows.map((r) => r[s].players[i]);
	const used = (s: Side, i: number) => i < SLOTS - 1 || !!slots[s][i].playerId || column(s, i).some((v) => v !== null);
	const countOf = (target: Hundredths) => per((s) => Array.from({ length: SLOTS }, (_, i) => (used(s, i) ? column(s, i).filter((v) => v === target).length : null)));
	const tuPoints = per((s) => Array.from({ length: SLOTS }, (_, i) => (used(s, i) ? sum(column(s, i)) : null)));
	const subtotal = per((s) => sum(tuPoints[s]));
	const bonusTotal = per((s) => sum(rows.map((r) => r[s].bonus)));
	const bonusConv = per((s) => {
		const heard = rows.filter((r) => r[s].bonus !== null).length;
		return heard ? bonusTotal[s] / 100 / heard : 0;
	});

	const flagged = new Set((result?.flags ?? []).filter((f) => ROW_FLAGS.has(f.kind) && f.tossup !== undefined).map((f) => rowOf({ number: f.tossup!, tiebreaker: !!f.tiebreaker }, rules)));
	const tbIgnored = !!result?.flags.some((f) => f.kind === 'tiebreaker_not_needed');
	const errorRows = rows.map((r, i) => {
		const n = i + 1;
		const a = r.A.players.filter((v) => v !== null);
		const b = r.B.players.filter((v) => v !== null);
		const sa = sum(a);
		const sb = sum(b);
		const hasAny = a.length + b.length > 0 || r.A.bonus !== null || r.B.bonus !== null;
		return (
			a.length > 1 ||
			b.length > 1 ||
			(sa > 0 && sb > 0) ||
			sa + sb < -500 ||
			(sa <= 0 && r.A.bonus !== null) ||
			(sb <= 0 && r.B.bonus !== null) ||
			flagged.has(n) ||
			(hasAny && isTiebreakerRow(n, rules) && tbIgnored)
		);
	});
	const filled = rows.map((r) => SIDES.some((s) => r[s].players.some((v) => v !== null) || r[s].bonus !== null));
	const tuState = filled.map((f, i): TuState => (f ? 'played' : filled.slice(i + 1).some(Boolean) ? 'skipped' : 'next'));
	return {
		rowTotal,
		cumulative,
		count15: countOf(1500),
		count10: countOf(1000),
		countNeg5: countOf(-500),
		tuPoints,
		subtotal,
		bonusTotal,
		bonusConv,
		final: per((s) => result?.teams[s].roundScore ?? subtotal[s] + bonusTotal[s]),
		errorRows,
		tuState
	};
}
