import type { RuleSettings, Side } from '$lib/engine';
import type { RosterPlayer, ScorerMatch } from '$lib/scorer-types';
import { emptyRow, isTiebreakerRow, parseCell, SHEET_TOSSUPS, SLOTS, type SheetRow, type Slot } from './model';

/** A raw cell from an uploaded spreadsheet. */
export type RawCell = number | string | null;

/** One round tab of an uploaded scoresheet, read from the same cells as the old Excel file. */
export interface ParsedSheet {
	name: string;
	/** From the tab name ("Round (3)") or, failing that, cell B2. */
	round: number | null;
	moderator: string;
	room: string;
	/** Left team (B3) and right team (K3). */
	teams: [string, string];
	/** Player names in row 4: B–F and K–O. */
	players: [string[], string[]];
	/** Tossup rows 5–30: the five player cells and the bonus cell for each team, and the notes column. */
	rows: { cells: [RawCell[], RawCell[]]; bonus: [RawCell, RawCell]; note: string }[];
}

/** What applying an import does to the open tab. */
export interface ImportPlan {
	label: string;
	slots: Record<Side, Slot[]>;
	rows: SheetRow[];
	moderator: string;
	notes: string[];
}

/** Names compared loosely: case, punctuation and spacing don't matter. */
export const normName = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

const playerForms = (p: RosterPlayer) => [p.name, `${p.firstName} ${p.lastName}`, `${p.lastName} ${p.firstName}`].map(normName);

/** The team whose name matches exactly (ignoring case and punctuation), if any. */
export function exactTeam(name: string, match: ScorerMatch): Side | null {
	const n = normName(name);
	if (!n) return null;
	const hits = (['A', 'B'] as const).filter((s) => normName(match.teams[s].name) === n);
	return hits.length === 1 ? hits[0] : null;
}

/** The roster player whose name matches exactly (first last, last first, or the name on the roster). */
export function exactPlayer(name: string, roster: RosterPlayer[]): string | null {
	const n = normName(name);
	if (!n) return null;
	const hits = roster.filter((p) => playerForms(p).includes(n));
	return hits.length === 1 ? hits[0].id : null;
}

const words = (s: string) => new Set(normName(s).split(' ').filter(Boolean));
/** How alike two names are (0–1), to put the likeliest choice first when the names don't match. */
export function likeness(a: string, b: string): number {
	const x = words(a);
	const y = words(b);
	if (!x.size || !y.size) return 0;
	// A word counts as shared when it matches, one starts the other ("Chris"/"Christopher"), or it is an initial ("B."/"Blake").
	const close = (w: string, v: string) => w === v || (Math.min(w.length, v.length) > 2 && (v.startsWith(w) || w.startsWith(v))) || ((w.length === 1 || v.length === 1) && w[0] === v[0]);
	let shared = 0;
	for (const w of x) if ([...y].some((v) => close(w, v))) shared++;
	return Math.min(1, (2 * shared) / (x.size + y.size));
}

/** The sheet's player columns worth asking about: a name, or any entries. */
export function usedColumns(sheet: ParsedSheet, k: 0 | 1): number[] {
	return Array.from({ length: SLOTS }, (_, i) => i).filter((i) => sheet.players[k][i]?.trim() || sheet.rows.some((r) => r.cells[k][i] !== null && r.cells[k][i] !== ''));
}

export interface ImportChoices {
	/** Which of our teams the sheet's left (0) and right (1) teams are. */
	sides: [Side | null, Side | null];
	/** For each sheet team and player column: our player id, null for "count for the team", undefined if not chosen yet. */
	players: [(string | null | undefined)[], (string | null | undefined)[]];
}

/** Turn a sheet plus the scorer's name matches into rows for the open tab, listing any cells that can't be used. */
export function buildPlan(sheet: ParsedSheet, choices: ImportChoices, match: ScorerMatch, rules: RuleSettings): { plan: ImportPlan; problems: string[] } {
	const problems: string[] = [];
	const slots: Record<Side, Slot[]> = { A: [], B: [] };
	const rows = Array.from({ length: SHEET_TOSSUPS }, emptyRow);
	const colLetter = (k: 0 | 1, i: number) => String.fromCharCode((k === 0 ? 66 : 75) + i);
	for (const k of [0, 1] as const) {
		const side = choices.sides[k];
		if (!side) continue;
		const roster = match.teams[side].roster;
		slots[side] = Array.from({ length: SLOTS }, (_, i) => {
			const id = choices.players[k][i];
			return id ? { playerId: id, name: roster.find((p) => p.id === id)?.name ?? '' } : { playerId: null, name: '' };
		});
		sheet.rows.slice(0, SHEET_TOSSUPS).forEach((r, idx) => {
			const n = idx + 1;
			const tb = isTiebreakerRow(n, rules);
			r.cells[k].forEach((raw, i) => {
				if (i >= SLOTS || raw === null || raw === '') return;
				const parsed = parseCell(String(raw), 'player', rules, tb);
				if (parsed.ok) rows[idx][side].players[i] = parsed.value;
				else problems.push(`${colLetter(k, i)}${n + 4} ("${raw}") was skipped: ${parsed.message}`);
			});
			const raw = r.bonus[k];
			if (raw === null || raw === '') return;
			const parsed = parseCell(String(raw), 'bonus', rules, tb);
			if (parsed.ok) rows[idx][side].bonus = parsed.value;
			else problems.push(`${k === 0 ? 'G' : 'P'}${n + 4} ("${raw}") was skipped: ${parsed.message}`);
		});
	}
	return {
		plan: { label: `"${sheet.name}"`, slots, rows, moderator: sheet.moderator.trim(), notes: sheet.rows.slice(0, SHEET_TOSSUPS).map((r) => r.note) },
		problems
	};
}
