import ExcelJS from 'exceljs';
import { SHEET_TOSSUPS, SLOTS } from '$lib/sheet/model';
import type { ParsedSheet, RawCell } from '$lib/sheet/import';
import { readXls } from './xls';

/** Reads an uploaded room scoresheet (.xls or .xlsx) into its round tabs. */

type Getter = (row: number, col: number) => RawCell;

function xlsxValue(v: ExcelJS.CellValue): RawCell {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number' || typeof v === 'string') return v;
	if (typeof v === 'boolean' || v instanceof Date) return String(v);
	if (typeof v === 'object') {
		if ('result' in v) return xlsxValue((v as { result?: ExcelJS.CellValue }).result ?? null);
		if ('formula' in v || 'sharedFormula' in v) return null;
		if ('richText' in v) return v.richText.map((t) => t.text).join('');
		if ('text' in v) return String(v.text);
	}
	return null;
}

const text = (v: RawCell) => (v === null ? '' : String(v).trim());
const ROUND_TAB = /round\s*\(?\s*(\d{1,2})\s*\)?/i;

/** The cells the old scoresheet used, read from one tab (0-based rows and columns, as on the template). */
function parseTab(name: string, get: Getter): ParsedSheet | null {
	// Only tabs laid out like the scoresheet: "Players" in A4 or "TU Number" in J3.
	if (!/players/i.test(text(get(3, 0))) && !/tu\s*number/i.test(text(get(2, 9)))) return null;
	const b2 = Number(text(get(1, 1)));
	const tab = ROUND_TAB.exec(name);
	const rows: ParsedSheet['rows'] = [];
	for (let n = 0; n < SHEET_TOSSUPS; n++) {
		const r = 4 + n;
		const cells = (c0: number) => Array.from({ length: SLOTS }, (_, i) => clean(get(r, c0 + i)));
		rows.push({ cells: [cells(1), cells(10)], bonus: [clean(get(r, 6)), clean(get(r, 15))], note: text(get(r, 18)) });
	}
	return {
		name,
		round: tab ? Number(tab[1]) : Number.isInteger(b2) && b2 > 0 ? b2 : null,
		moderator: text(get(1, 8)),
		room: text(get(1, 14)),
		teams: [text(get(2, 1)), text(get(2, 10))],
		players: [Array.from({ length: SLOTS }, (_, i) => text(get(3, 1 + i))), Array.from({ length: SLOTS }, (_, i) => text(get(3, 10 + i)))],
		rows
	};
}

/** Blank strings are blank cells; numbers typed as text stay text so the import can check them. */
function clean(v: RawCell): RawCell {
	if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
	return v;
}

export async function readScoresheetFile(buf: Uint8Array): Promise<ParsedSheet[]> {
	const tabs: { name: string; get: Getter }[] = [];
	if (buf[0] === 0xd0 && buf[1] === 0xcf) {
		for (const s of readXls(buf)) tabs.push({ name: s.name, get: (r, c) => { const v = s.cells.get(`${r},${c}`) ?? null; return typeof v === 'boolean' ? String(v) : v; } });
	} else if (buf[0] === 0x50 && buf[1] === 0x4b) {
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.load(buf as unknown as ArrayBuffer);
		for (const ws of wb.worksheets) tabs.push({ name: ws.name, get: (r, c) => xlsxValue(ws.getRow(r + 1).getCell(c + 1).value) });
	} else throw new Error('This is not an Excel file. Choose the .xls or .xlsx scoresheet.');
	return tabs.flatMap((t) => parseTab(t.name, t.get) ?? []);
}
