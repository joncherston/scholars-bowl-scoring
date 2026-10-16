import { describe, expect, it } from 'vitest';
import { DEFAULT_CLASSIFICATIONS } from './events';
import { buildPreview } from './registrations';
import { normalizeSiteUrl, toRegistrationRows, wpEvents, wpRegistrations, WpError, type WpSettings } from './wordpress';

const settings: WpSettings = { url: 'https://site.example', token: 't0ken', enabled: true };
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const sample = [
	{ id: 44, school_name: 'Riverbend Christian A', contact_name: 'Jordan Sample', contact_email: 'JS@Riverbend.example', contact_phone: '5550100102', competing_students: 7, coaches: 2, classification: '1a', session_time: 'morning', registration_status: 'confirmed', is_test: false, registration_date: '2026-09-29 17:38:59' },
	{ id: 47, school_name: 'Lakeview  High School', contact_name: null, contact_email: null, contact_phone: null, competing_students: 6, coaches: 1, classification: '4A', session_time: 'afternoon', registration_status: 'cancelled', is_test: false, registration_date: '2026-09-18 15:51:29' },
	{ id: 18, school_name: 'Live Test 4', contact_name: 'Test Admin', contact_email: 'admin@example.test', contact_phone: null, competing_students: 3, coaches: 0, classification: 'Private', session_time: 'morning', registration_status: 'pending', is_test: true, registration_date: '2026-10-09 17:45:05' }
];

describe('website API client', () => {
	it('accepts https addresses and local http only', () => {
		expect(normalizeSiteUrl('https://suscholarsbowl.com/')).toBe('https://suscholarsbowl.com');
		expect(normalizeSiteUrl('http://localhost:8089')).toBe('http://localhost:8089');
		expect(normalizeSiteUrl('http://suscholarsbowl.com')).toBeNull();
		expect(normalizeSiteUrl('not a url')).toBeNull();
	});

	it('sends the token and reads events', async () => {
		let seen: Request | null = null;
		const f = (async (url: string, init: RequestInit) => {
			seen = new Request(url, init);
			return new Response(JSON.stringify({ events: [{ id: 2, name: 'HS 2026', slug: 's', date: '2026-10-28', status: 'active', morning_classifications: [], afternoon_classifications: [] }] }));
		}) as unknown as typeof fetch;
		const evs = await wpEvents(settings, f);
		expect(evs[0].name).toBe('HS 2026');
		expect(seen!.url).toBe('https://site.example/wp-json/sbr/v1/events');
		expect(seen!.headers.get('X-SBR-Token')).toBe('t0ken');
	});

	it('explains common failures in plain language', async () => {
		await expect(wpEvents(settings, reply(401, {}))).rejects.toThrow(/rejected the API token/);
		await expect(wpEvents(settings, reply(404, {}))).rejects.toThrow(/1\.0\.7/);
		await expect(wpEvents(settings, (async () => { throw new Error('down'); }) as unknown as typeof fetch)).rejects.toBeInstanceOf(WpError);
	});

	it('maps registrations into the importer format and flags test-mode ones', async () => {
		const { rows } = await wpRegistrations(settings, 2, DEFAULT_CLASSIFICATIONS, reply(200, { registrations: sample }));
		expect(rows[0]).toMatchObject({ registrationId: 44, classification: '1A', contactEmail: 'js@riverbend.example', session: 'morning', status: 'confirmed' });
		expect(rows[1].schoolName).toBe('Lakeview High School');
		const preview = buildPreview(toRegistrationRows(sample, DEFAULT_CLASSIFICATIONS), [], [{ id: 1, name: 'Morning', classifications: ['Private', '1A'] }, { id: 2, name: 'Afternoon', classifications: ['4A'] }], null);
		expect(preview.find((p) => p.registrationId === 44)!.include).toBe(true);
		expect(preview.find((p) => p.registrationId === 47)!.action).toBe('skip');
		const test = preview.find((p) => p.registrationId === 18)!;
		expect(test.include).toBe(false);
		expect(test.notes.join(' ')).toMatch(/test mode/);
	});
});
