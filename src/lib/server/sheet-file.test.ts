import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readScoresheetFile } from './sheet-file';

// scoresheet-sample.xls is an Excel 97–2003 file in the old room scoresheet layout with fictional
// names, written with Python's xlwt: tabs "Round (1)" and "Round (2)", shared strings, whole and
// decimal numbers, a number typed as text ("12.5"), and a formula in column H.
const sample = () => new Uint8Array(readFileSync(new URL('./fixtures/scoresheet-sample.xls', import.meta.url)));

describe('reading an uploaded scoresheet', () => {
	it('reads the round tabs of an .xls file', async () => {
		const sheets = await readScoresheetFile(sample());
		expect(sheets.map((s) => [s.name, s.round])).toEqual([
			['Round (1)', 1],
			['Round (2)', 2]
		]);
		const r2 = sheets[1];
		expect(r2.moderator).toBe('Mrs. Example');
		expect(r2.room).toBe('Room 3');
		expect(r2.teams).toEqual(['Fox Run HS', 'Riverbend Christian B']);
		expect(r2.players[0]).toEqual(['Finley Fairbanks', 'B. Fairbanks', 'Logan Hollister', 'Pemberton, Morgan', '']);
		expect(r2.rows[0].cells[0]).toEqual([null, 10, null, null, null]);
		expect(r2.rows[0].bonus).toEqual([20, null]);
		expect(r2.rows[2].cells[1]).toEqual([null, null, 0, null, null]);
		expect(r2.rows[3].bonus[0]).toBe('12.5');
		expect(r2.rows[1].note).toBe('Answer: Lincoln');
		expect(r2.rows).toHaveLength(26);
	});

	it('reads an .xlsx file, using calculated results of formulas', async () => {
		const wb = new ExcelJS.Workbook();
		const ws = wb.addWorksheet('Round (4)');
		ws.getCell('A4').value = 'Players';
		ws.getCell('J3').value = 'TU Number';
		ws.getCell('I2').value = 'Dr. Example';
		ws.getCell('B3').value = { richText: [{ text: 'Cedar ' }, { text: 'Hollow' }] };
		ws.getCell('K3').value = 'Riverbend Christian A';
		ws.getCell('B4').value = 'Casey Vandermeer';
		ws.getCell('B5').value = 10;
		ws.getCell('G5').value = { formula: '10+10', result: 20 };
		ws.getCell('K6').value = '  ';
		wb.addWorksheet('Notes').getCell('A1').value = 'not a scoresheet';
		const buf = new Uint8Array(await wb.xlsx.writeBuffer());
		const sheets = await readScoresheetFile(buf);
		expect(sheets).toHaveLength(1);
		expect(sheets[0]).toMatchObject({ name: 'Round (4)', round: 4, moderator: 'Dr. Example', teams: ['Cedar Hollow', 'Riverbend Christian A'] });
		expect(sheets[0].rows[0].cells[0][0]).toBe(10);
		expect(sheets[0].rows[0].bonus[0]).toBe(20);
		expect(sheets[0].rows[1].cells[1][0]).toBeNull();
	});

	it('refuses a file that is not an Excel workbook', async () => {
		await expect(readScoresheetFile(new TextEncoder().encode('Team,Player\nA,B'))).rejects.toThrow(/not an Excel file/);
	});
});
