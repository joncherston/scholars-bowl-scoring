// Optional check against a real plugin export kept outside the repo:
//   REAL_CSV=/path/to/export.csv npx vitest run registrations.real
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLASSIFICATIONS } from './events';
import { buildPreview, detectMapping, parseCsv, toRows } from './registrations';

const file = process.env.REAL_CSV;

describe.skipIf(!file)('real plugin export', () => {
	it('parses and previews without errors', () => {
		const { headers, records, errors } = parseCsv(fs.readFileSync(file!, 'utf8'));
		expect(errors).toEqual([]);
		const { mapping, pluginLayout } = detectMapping(headers);
		expect(pluginLayout).toBe(true);
		const rows = toRows(records, mapping, DEFAULT_CLASSIFICATIONS);
		const p = buildPreview(rows, [], [
			{ id: 1, name: 'Morning', classifications: ['Private', '1A', '2A', '3A'] },
			{ id: 2, name: 'Afternoon', classifications: ['4A', '5A', '6A', '7A'] }
		], `${new Date().getFullYear()}-01-01`);
		const summary = p.map((r) => `${r.include ? '+' : '-'} ${r.action.padEnd(9)} ${String(r.registrationId).padStart(3)} ${r.classification.padEnd(7)} s${r.sessionId ?? '?'} ${r.notes.join('; ')}`);
		console.log(summary.join('\n'));
		expect(p.filter((r) => r.include).length).toBeGreaterThan(0);
	});
});
