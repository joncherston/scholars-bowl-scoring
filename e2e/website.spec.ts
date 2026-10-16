import { expect, test } from '@playwright/test';
import http from 'node:http';
import { adminContext, q } from './helpers';

/** A stand-in for the registration website's API (plugin 1.0.7). */
function fakeWordPress(token: string) {
	const regs = [
		{ id: 301, school_name: 'Harbor Point Academy', contact_name: 'Kai Example', contact_email: 'kai@harbor.example', contact_phone: '5550101001', competing_students: 6, additional_students: 0, additional_adults: 0, coaches: 1, classification: 'Private', session_time: 'morning', registration_status: 'confirmed', payment_status: 'completed', is_test: false, registration_date: '2026-09-02 10:00:00', last_updated: null },
		{ id: 302, school_name: 'Granite Falls High School', contact_name: 'Lee Sample', contact_email: 'lee@granite.example', contact_phone: null, competing_students: 6, additional_students: 0, additional_adults: 0, coaches: 2, classification: '5a', session_time: 'afternoon', registration_status: 'pending', payment_status: 'pending', is_test: false, registration_date: '2026-09-05 10:00:00', last_updated: null },
		{ id: 303, school_name: 'Stripe Test School', contact_name: 'Test', contact_email: 'test@example.test', contact_phone: null, competing_students: 3, additional_students: 0, additional_adults: 0, coaches: 0, classification: 'Private', session_time: 'morning', registration_status: 'pending', payment_status: 'pending', is_test: true, registration_date: '2026-09-06 10:00:00', last_updated: null }
	];
	return http.createServer((req, res) => {
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (req.headers['x-sbr-token'] !== token) return send(401, { code: 'sbr_unauthorized' });
		const url = new URL(req.url!, 'http://x');
		if (url.pathname === '/wp-json/sbr/v1/events')
			return send(200, { events: [{ id: 9, name: 'Website Event 2026', slug: 'hs-2026', date: '2026-10-28', status: 'active', morning_classifications: ['Private'], afternoon_classifications: ['5A'] }] });
		if (url.pathname === '/wp-json/sbr/v1/registrations' && url.searchParams.get('event_id') === '9') return send(200, { event_id: 9, registrations: regs });
		send(404, {});
	});
}

test('pulls registrations from the website API into the same preview, skipping test-mode ones', async ({ browser }) => {
	const token = 'e2e-website-token-0123456789';
	const server = fakeWordPress(token);
	await new Promise<void>((r) => server.listen(4199, '127.0.0.1', r));
	try {
		const admin = await adminContext(browser);
		const page = await admin.newPage();

		// A wrong token is reported in plain language.
		await page.goto('/admin');
		await page.getByLabel('Website address').fill('http://127.0.0.1:4199');
		await page.getByLabel(/API token/).fill('wrong-token');
		await page.getByLabel('Use the website connection').check();
		await page.getByRole('button', { name: 'Save' }).first().click();
		await expect(page.getByText('Website connection saved.')).toBeVisible();
		await page.getByRole('button', { name: 'Test the connection' }).click();
		await expect(page.getByText(/rejected the API token/)).toBeVisible();

		await page.getByLabel(/API token/).fill(token);
		await page.getByRole('button', { name: 'Save' }).first().click();
		await expect(page.getByText('Website connection saved.')).toBeVisible();
		await page.getByRole('button', { name: 'Test the connection' }).click();
		await expect(page.getByText(/Connected\. The website has 1 event/)).toBeVisible();

		await page.goto('/events/new');
		await page.getByLabel('Event name').fill('E2E Website Event');
		await page.getByLabel('Date').fill('2026-10-28');
		await page.getByRole('button', { name: 'Create event' }).click();
		await page.waitForURL(/\/events\/\d+$/);
		const eventId = Number(/\/events\/(\d+)$/.exec(page.url())![1]);

		await page.goto(`/events/${eventId}/teams/import`);
		await expect(page.getByLabel('Website event')).toHaveValue('9');
		await page.getByRole('button', { name: 'Preview from the website' }).click();
		await expect(page.getByText('Website: Website Event 2026')).toBeVisible();
		await expect(page.locator('tr', { hasText: '#303 ·' }).getByText(/test mode/)).toBeVisible();
		await expect(page.getByText(/Will add\s+2/)).toBeVisible();
		await page.getByRole('button', { name: 'Apply approved changes' }).click();
		await expect(page.getByText('Import complete: 2 new team(s), 0 updated, 0 withdrawn')).toBeVisible();

		const teams = q<{ name: string; classification: string; source: string; registration_id: number }>('SELECT name, classification, source, registration_id FROM teams WHERE event_id = ? ORDER BY registration_id', eventId);
		expect(teams).toEqual([
			{ name: 'Harbor Point Academy', classification: 'Private', source: 'api', registration_id: 301 },
			{ name: 'Granite Falls High School', classification: '5A', source: 'api', registration_id: 302 }
		]);
		await admin.close();
	} finally {
		server.close();
	}
});
