import { BONUS_COL, CUML_COL, FIRST_TU_ROW, NOTES_COL, PLAYER_COL, SHEET_TOSSUPS, SLOTS, TOTAL_COL, TU_COL } from './model';
import { CELLS, COL_WIDTHS, MERGES, ROW_HEIGHTS, type TemplateCell } from './template';
import type { Side } from '$lib/engine';

/** Static geometry of the classic scoresheet grid: merges, borders, what each cell is for, and the old formulas. */

/** Template rows (1–37) and columns (A–S). Columns T–X held hidden helper formulas on the old sheet. */
export const NR = ROW_HEIGHTS.length;
export const NC = COL_WIDTHS.length;
export const EXTRA_COLS = ['Y', 'Z', 'AA', 'AB', 'AC', 'AD'];
export const EXTRA_ROWS = 12;
export const ALL_ROWS = NR + EXTRA_ROWS;
export const ALL_COLS = NC + EXTRA_COLS.length;
export const EXTRA_COL_WIDTH = 64;
export const DEFAULT_ROW_HEIGHT = 17;
export const FINAL_ROW = FIRST_TU_ROW + SHEET_TOSSUPS;
export const GRIDLINE = '#d4d4d4';

export const colName = (c: number) => (c < NC ? String.fromCharCode(65 + c) : EXTRA_COLS[c - NC]);
export const address = (r: number, c: number) => `${colName(c)}${r + 1}`;
export const colWidth = (c: number) => (c < NC ? COL_WIDTHS[c] : EXTRA_COL_WIDTH);
export const rowHeight = (r: number) => (r < NR ? ROW_HEIGHTS[r] : DEFAULT_ROW_HEIGHT);
/** Width of the row-number column, and of the whole grid (a fixed table layout needs it). */
export const ROW_HEADER_WIDTH = 34;
export const GRID_WIDTH = ROW_HEADER_WIDTH + Array.from({ length: ALL_COLS }, (_, c) => colWidth(c)).reduce((a, b) => a + b, 0);

const mergeAt = new Map<string, (typeof MERGES)[number]>();
for (const m of MERGES) for (let r = m[0]; r <= m[1]; r++) for (let c = m[2]; c <= m[3]; c++) mergeAt.set(`${r},${c}`, m);

/** The merged area a cell belongs to (or just the cell). */
export function span(r: number, c: number) {
	const m = mergeAt.get(`${r},${c}`);
	return m ? { r0: m[0], r1: m[1], c0: m[2], c1: m[3] } : { r0: r, r1: r, c0: c, c1: c };
}

const tpl = (r: number, c: number): TemplateCell => CELLS[r]?.[c] ?? {};
const bd = (r: number, c: number, i: number) => tpl(r, c).bd?.[i] ?? 0;
const edge = (w: number) => (w ? `${w}px solid #000` : `1px solid ${GRIDLINE}`);

/**
 * A cell's four borders, combining its own with its neighbours' touching borders, so both cells on an
 * edge ask for the same border (HTML tables otherwise let the cell above or to the left win).
 */
function edges(r0: number, r1: number, c0: number, c1: number): [number, number, number, number] {
	let [l, t, rt, b] = [0, 0, 0, 0];
	for (let r = r0; r <= r1; r++) {
		l = Math.max(l, bd(r, c0, 0), bd(r, c0 - 1, 2));
		rt = Math.max(rt, bd(r, c1, 2), bd(r, c1 + 1, 0));
	}
	for (let c = c0; c <= c1; c++) {
		t = Math.max(t, bd(r0, c, 1), bd(r0 - 1, c, 3));
		b = Math.max(b, bd(r1, c, 3), bd(r1 + 1, c, 1));
	}
	return [l, t, rt, b];
}

export interface LayoutCell {
	r: number;
	c: number;
	rowspan: number;
	colspan: number;
	style: string;
	/** Text is turned to read bottom to top. */
	rotated: boolean;
	/** Horizontal alignment from the template ('g' = numbers right, text left). */
	align: 'g' | 'l' | 'c' | 'r';
}

function cellStyle(r: number, c: number, s: ReturnType<typeof span>): string {
	const t = tpl(r, c);
	const [l, tp, rt, b] = edges(s.r0, s.r1, s.c0, s.c1);
	const out = [`border-left:${edge(l)}`, `border-top:${edge(tp)}`, `border-right:${edge(rt)}`, `border-bottom:${edge(b)}`];
	if (t.b) out.push('font-weight:700');
	if (t.sz) out.push(`font-size:${t.sz}pt`);
	if (t.font) out.push(`font-family:'${t.font}',Arial,sans-serif`);
	out.push(`vertical-align:${{ t: 'top', m: 'middle', b: 'bottom' }[t.v ?? 'b']}`);
	if (t.h && t.h !== 'g') out.push(`text-align:${{ l: 'left', c: 'center', r: 'right' }[t.h]}`);
	if (t.wrap) out.push('white-space:normal');
	if (t.fill) out.push(`background:${t.fill}`);
	return out.join(';');
}

/** Every rendered cell, row by row (cells hidden under a merge are left out). */
export const LAYOUT: LayoutCell[][] = Array.from({ length: ALL_ROWS }, (_, r) => {
	const row: LayoutCell[] = [];
	for (let c = 0; c < ALL_COLS; c++) {
		if (r >= NR || c >= NC) {
			row.push({ r, c, rowspan: 1, colspan: 1, style: `border:1px solid ${GRIDLINE};vertical-align:bottom`, rotated: false, align: 'g' });
			continue;
		}
		const s = span(r, c);
		if (s.r0 !== r || s.c0 !== c) continue;
		const t = tpl(r, c);
		row.push({ r, c, rowspan: s.r1 - s.r0 + 1, colspan: s.c1 - s.c0 + 1, style: cellStyle(r, c, s), rotated: !!t.rot, align: t.h ?? 'g' });
	}
	return row;
});

/** Top offset of each frozen row (rows 1–4 stay put while the sheet scrolls), below the column letters. */
export const HEADER_HEIGHT = 20;
export const FROZEN_ROWS = 4;
export const frozenTop = (r: number) => HEADER_HEIGHT + ROW_HEIGHTS.slice(0, r).reduce((a, b) => a + b, 0);

export type CellRole =
	| { kind: 'moderator' }
	| { kind: 'note'; n: number }
	| { kind: 'player'; side: Side; slot: number; n: number }
	| { kind: 'bonus'; side: Side; n: number }
	| { kind: 'header'; side: Side; slot: number }
	| { kind: 'auto' }
	| { kind: 'calc' }
	| { kind: 'fixed' };

const sideCol = (c: number, base: Record<Side, number>, width = 1): { side: Side; i: number } | null => {
	for (const side of ['A', 'B'] as const) if (c >= base[side] && c < base[side] + width) return { side, i: c - base[side] };
	return null;
};

/** What a cell is for: something the scorer types, something filled from the schedule, or a calculation. */
export function roleOf(r: number, c: number): CellRole {
	if (r >= NR || c >= NC) return { kind: 'fixed' };
	const s = span(r, c);
	[r, c] = [s.r0, s.c0];
	if (r === 1 && c === 8) return { kind: 'moderator' };
	if ((r === 0 && c === 1) || (r === 1 && c === 1) || (r === 1 && c === 14) || (r === 2 && (c === 1 || c === 10))) return { kind: 'auto' };
	if (r === 3) {
		const p = sideCol(c, PLAYER_COL, SLOTS);
		return p ? { kind: 'header', side: p.side, slot: p.i } : { kind: 'fixed' };
	}
	if (r >= FIRST_TU_ROW && r < FINAL_ROW) {
		const n = r - FIRST_TU_ROW + 1;
		if (c === NOTES_COL) return { kind: 'note', n };
		const p = sideCol(c, PLAYER_COL, SLOTS);
		if (p) return { kind: 'player', side: p.side, slot: p.i, n };
		const b = sideCol(c, BONUS_COL);
		if (b) return { kind: 'bonus', side: b.side, n };
		return c === 0 || c === TU_COL ? { kind: 'fixed' } : { kind: 'calc' };
	}
	return formulaOf(r, c) ? { kind: 'calc' } : { kind: 'fixed' };
}

/** The formula the old sheet had in a calculated cell, shown in the formula bar. */
export function formulaOf(r: number, c: number): string | null {
	const s = span(r, c);
	[r, c] = [s.r0, s.c0];
	const R = r + 1;
	if (r >= FIRST_TU_ROW && r < FINAL_ROW) {
		if (c === TOTAL_COL.A) return `=SUM(B${R}:G${R})`;
		if (c === CUML_COL.A) return `=IF(SUM(B${R}:F${R})<>0,T${R},"")`;
		if (c === TOTAL_COL.B) return `=SUM(K${R}:P${R})`;
		if (c === CUML_COL.B) return `=IF(SUM(K${R}:O${R})<>0,U${R},"")`;
		return null;
	}
	if (r === FINAL_ROW) return c === 1 ? '=(B36+G36)' : c === 10 ? '=(K36+P36)' : null;
	const L = colName(c);
	const range = `${L}5:${L}30`;
	const fifth = (f: string) => (c === 5 ? `=IF(W5=1,${f},"")` : c === 14 ? `=IF(W6=1,${f},"")` : `=${f}`);
	if (r >= FINAL_ROW + 1 && r <= FINAL_ROW + 4 && ((c >= 1 && c <= 5) || (c >= 10 && c <= 14))) {
		const k = r - FINAL_ROW - 1;
		return fifth(k === 3 ? `SUM(${range})` : `COUNTIF(${range},"=${['15', '10', '-5'][k]}")`);
	}
	if (r === FINAL_ROW + 5) return c === 1 ? '=SUM(B35:F35)' : c === 6 ? '=SUM(G5:G30)' : c === 10 ? '=SUM(K35:O35)' : c === 15 ? '=SUM(P5:P30)' : null;
	if (r === FINAL_ROW + 6) {
		if (c === 1) return '=IF(26-COUNTBLANK(G5:G30)=0,0,G36/(26-COUNTBLANK(G5:G30)))';
		if (c === 10) return '=IF(26-COUNTBLANK(P5:P30)=0,0,P36/(26-COUNTBLANK(P5:P30)))';
	}
	return null;
}
