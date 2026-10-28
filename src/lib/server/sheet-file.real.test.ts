import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readScoresheetFile } from './sheet-file';

// Checks the .xls reader against a real scoresheet kept outside the repository:
// REAL_XLS="path/to/Scholar's Bowl Morning Scoresheet.xls" npx vitest run sheet-file.real
describe.skipIf(!process.env.REAL_XLS)('real .xls scoresheet', () => {
	it('reads every round tab', async () => {
		const sheets = await readScoresheetFile(new Uint8Array(readFileSync(process.env.REAL_XLS!)));
		expect(sheets.length).toBeGreaterThan(0);
		expect(sheets.map((s) => s.round)).toEqual(sheets.map((_, i) => i + 1));
		for (const s of sheets) expect(s.rows).toHaveLength(26);
		console.log(JSON.stringify(sheets.slice(0, 3).map(({ rows, ...rest }) => ({ ...rest, filled: rows.filter((r) => r.cells.flat().some((v) => v !== null)).length })), null, 1));
	});
});
