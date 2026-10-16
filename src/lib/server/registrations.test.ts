import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLASSIFICATIONS } from './events';
import { buildPreview, detectMapping, normalizeDate, parseCsv, schoolNameFromTeam, toRows, type ExistingTeam, type SessionInfo } from './registrations';

const csv = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/plugin-export-sample.csv'), 'utf8');
const sessions: SessionInfo[] = [
	{ id: 1, name: 'Morning', classifications: ['Private', '1A', '2A', '3A'] },
	{ id: 2, name: 'Afternoon', classifications: ['4A', '5A', '6A', '7A'] }
];

const load = () => {
	const { headers, records, errors } = parseCsv(csv);
	const { mapping, pluginLayout } = detectMapping(headers);
	return { rows: toRows(records, mapping, DEFAULT_CLASSIFICATIONS), mapping, pluginLayout, errors };
};

describe('plugin CSV import', () => {
	it('detects the plugin export layout and maps Grade Level to classification', () => {
		const { mapping, pluginLayout, errors, rows } = load();
		expect(errors).toEqual([]);
		expect(pluginLayout).toBe(true);
		expect(mapping.classification).toBe('Grade Level');
		expect(rows).toHaveLength(11);
	});

	it('prefers the explicit Classification column added in plugin 1.0.7', () => {
		const lines = csv.trim().split('\n');
		const withCol = [lines[0] + ',Classification', ...lines.slice(1).map((l) => l + ',3A')].join('\n');
		const { headers, records } = parseCsv(withCol);
		const { mapping } = detectMapping(headers);
		expect(mapping.classification).toBe('Classification');
		expect(toRows(records, mapping, DEFAULT_CLASSIFICATIONS)[0].classification).toBe('3A');
	});

	it('normalizes names, classifications, and dates', () => {
		const { rows } = load();
		const cedar = rows.find((r) => r.registrationId === 58)!;
		expect(cedar.schoolName).toBe('Cedar Hollow School');
		expect(rows.find((r) => r.registrationId === 56)!.classification).toBe('6A');
		expect(cedar.registeredAt).toBe('2026-09-22 13:01:38');
		expect(cedar.contactEmail).toBe('morgan@cedarhollow.example');
		expect(normalizeDate('10/5/2026 9:30')).toBe('2026-10-05 09:30:00');
		// A zero date means "not recorded", so the year cutoff must not skip the row.
		expect(normalizeDate('0000-00-00 00:00:00')).toBeNull();
	});

	it('handles a byte-order mark and Windows line endings', () => {
		const { headers, records } = parseCsv('﻿' + csv.replace(/\n/g, '\r\n'));
		expect(detectMapping(headers).pluginLayout).toBe(true);
		expect(records.length).toBe(11);
	});

	it('skips earlier years by date cutoff and cancelled registrations', () => {
		const { rows } = load();
		const p = buildPreview(rows, [], sessions, '2026-01-01');
		const byId = (id: number) => p.find((r) => r.registrationId === id)!;
		expect(byId(40).action).toBe('skip');
		expect(byId(38).action).toBe('skip');
		expect(byId(54).action).toBe('skip');
		expect(byId(54).notes[0]).toMatch(/Cancelled/);
		const included = p.filter((r) => r.include).map((r) => r.registrationId);
		expect(included.sort()).toEqual([55, 56, 57, 58, 59, 60, 61]);
	});

	it('assigns sessions by classification and flags a missing classification', () => {
		const { rows } = load();
		const p = buildPreview(rows, [], sessions, '2026-01-01');
		expect(p.find((r) => r.registrationId === 57)!.sessionId).toBe(2);
		expect(p.find((r) => r.registrationId === 61)!.sessionId).toBe(1);
		const oak = p.find((r) => r.registrationId === 55)!;
		expect(oak.classification).toBe('');
		expect(oak.notes.join(' ')).toMatch(/No classification/);
	});

	it('keeps A and B teams from one school as separate teams of the same school', () => {
		const { rows } = load();
		const p = buildPreview(rows, [], sessions, '2026-01-01');
		const a = p.find((r) => r.registrationId === 59)!;
		const b = p.find((r) => r.registrationId === 60)!;
		expect(a.include && b.include).toBe(true);
		expect(schoolNameFromTeam(a.schoolName)).toBe('Riverbend Christian');
		expect(schoolNameFromTeam(b.schoolName)).toBe('Riverbend Christian');
		expect(schoolNameFromTeam('Lakeview High School')).toBe('Lakeview High School');
	});

	it('flags duplicate registrations for one team and selects the confirmed one', () => {
		const { rows } = load();
		const p = buildPreview(rows, [], sessions, null);
		const confirmed = p.find((r) => r.registrationId === 40)!;
		const pending = p.find((r) => r.registrationId === 39)!;
		expect(confirmed.include).toBe(true);
		expect(pending.include).toBe(false);
		expect(pending.notes.join(' ')).toMatch(/duplicate of registration 40/);
	});

	it('is idempotent: re-importing matches on registration ID and reports changes only', () => {
		const { rows } = load();
		const existing: ExistingTeam[] = [
			{
				id: 7,
				registrationId: 61,
				name: 'Pinecrest',
				registrationName: 'Pinecrest Academy',
				classification: 'Private',
				sessionId: 1,
				registrationStatus: 'confirmed',
				contactName: 'Avery Testperson',
				contactEmail: 'avery@pinecrest.example',
				contactPhone: '5550100101',
				competingStudents: 8,
				coaches: 1,
				withdrawn: false
			},
			{
				id: 8,
				registrationId: 57,
				name: 'Lakeview High School',
				registrationName: 'Lakeview High School',
				classification: '4A',
				sessionId: 2,
				registrationStatus: 'pending',
				contactName: 'Casey Placeholder',
				contactEmail: 'casey@lakeview.example',
				contactPhone: '555-010-0104',
				competingStudents: 5,
				coaches: 1,
				withdrawn: false
			},
			{
				id: 9,
				registrationId: 54,
				name: 'Maple Grove High School',
				registrationName: 'Maple Grove High School',
				classification: '5A',
				sessionId: 2,
				registrationStatus: 'confirmed',
				contactName: null,
				contactEmail: null,
				contactPhone: null,
				competingStudents: 6,
				coaches: 1,
				withdrawn: false
			}
		];
		const p = buildPreview(rows, existing, sessions, '2026-01-01');
		const pine = p.find((r) => r.registrationId === 61)!;
		expect(pine.action).toBe('unchanged');
		expect(pine.include).toBe(false);
		const lake = p.find((r) => r.registrationId === 57)!;
		expect(lake.action).toBe('update');
		expect(lake.changes).toEqual([{ field: 'Competing students', from: '5', to: '6' }]);
		const maple = p.find((r) => r.registrationId === 54)!;
		expect(maple.action).toBe('withdraw');
		expect(maple.existingTeamId).toBe(9);
	});

	it('guesses a mapping for other layouts', () => {
		const { mapping, pluginLayout } = detectMapping(['Team', 'Class', 'Coach Email', 'Session', 'Registration Date']);
		expect(pluginLayout).toBe(false);
		expect(mapping).toMatchObject({ schoolName: 'Team', classification: 'Class', contactEmail: 'Coach Email', session: 'Session' });
	});
});

describe('plugin 1.0.6 export quirk', () => {
	it('skips the WordPress admin page HTML that comes before the CSV rows', () => {
		const withHtml = `<!DOCTYPE html>\n<html class="wp-toolbar"><head><title>Registrations</title></head><body><div id="wpwrap">…</div>\n${csv}`;
		const { headers, records, errors } = parseCsv(withHtml);
		expect(errors).toEqual([]);
		expect(detectMapping(headers).pluginLayout).toBe(true);
		expect(records).toHaveLength(11);
	});
});
