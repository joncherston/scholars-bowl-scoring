import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { adminContext, q } from './helpers';

const FIXTURE = 'src/lib/server/fixtures/plugin-export-sample.csv';

test('imports the website registration CSV with a preview, then re-imports a newer export safely', async ({ browser }) => {
	const admin = await adminContext(browser);
	const page = await admin.newPage();

	// A new event from the default template.
	await page.goto('/events/new');
	await page.getByLabel('Event name').fill('E2E Import Event');
	await page.getByLabel('Date').fill('2026-10-28');
	await page.getByLabel(/Number of rooms/).fill('4');
	await page.getByRole('button', { name: 'Create event' }).click();
	await page.waitForURL(/\/events\/\d+$/);
	const eventId = Number(/\/events\/(\d+)$/.exec(page.url())![1]);
	await expect(page.getByText('8 to confirm before event')).toBeVisible();

	// Upload the export; nothing changes until the preview is approved.
	await page.goto(`/events/${eventId}/teams/import`);
	await page.getByLabel('CSV file').setInputFiles(FIXTURE);
	await page.getByRole('button', { name: 'Preview' }).click();
	await expect(page.getByText('Website export detected')).toBeVisible();
	const apply = page.getByRole('button', { name: 'Apply approved changes' });
	// Oak Ridge has no classification in the file, so applying is blocked until one is chosen.
	await expect(page.getByText(/Choose a classification for Oak Ridge Academy/)).toBeVisible();
	await expect(apply).toBeDisabled();
	await page.locator('tr', { hasText: '#55 ·' }).getByLabel('Classification').selectOption('Private');
	await expect(page.getByText(/Will add\s+7/)).toBeVisible();
	expect(q('SELECT id FROM teams WHERE event_id = ?', eventId)).toHaveLength(0);
	await apply.click();
	await expect(page.getByText('Import complete: 7 new team(s), 0 updated, 0 withdrawn')).toBeVisible();

	const teams = q<{ name: string; classification: string; session: string; school: string }>(
		`SELECT t.name, t.classification, s.name AS session, sc.name AS school FROM teams t
		 JOIN sessions s ON s.id = t.session_id JOIN schools sc ON sc.id = t.school_id WHERE t.event_id = ? ORDER BY t.name`,
		eventId
	);
	expect(teams.map((t) => t.name)).toEqual([
		'Cedar Hollow School',
		'Lakeview High School',
		'Oak Ridge Academy',
		'Pinecrest Academy',
		'Riverbend Christian A',
		'Riverbend Christian B',
		'Summit High School'
	]);
	// Two teams from one school share the school record; sessions follow classification.
	expect(teams.filter((t) => t.school === 'Riverbend Christian')).toHaveLength(2);
	expect(teams.find((t) => t.name === 'Summit High School')).toMatchObject({ classification: '6A', session: 'Afternoon' });

	// A newer export: one registration confirmed, one cancelled, one count changed.
	const newer = fs
		.readFileSync(FIXTURE, 'utf8')
		.replace('"Riverbend Christian B","Jordan Sample",jsample@riverbend.example,5550100102,None,7,0,4,0,1A,morning,154.00,25.00,129.00,completed,0.000000,pending', '"Riverbend Christian B","Jordan Sample",jsample@riverbend.example,5550100102,None,7,0,4,0,1A,morning,154.00,25.00,129.00,completed,0.000000,confirmed')
		.replace(',0.000000,0.000000,pending,"2026-09-18 15:51:29"', ',0.000000,0.000000,cancelled,"2026-09-18 15:51:29"')
		.replace('riley@summit.example,5550100105,None,6,', 'riley@summit.example,5550100105,None,8,');
	await page.goto(`/events/${eventId}/teams/import`);
	await page.getByLabel('CSV file').setInputFiles({ name: 'newer.csv', mimeType: 'text/csv', buffer: Buffer.from(newer) });
	await page.getByRole('button', { name: 'Preview' }).click();
	await expect(page.locator('tr', { hasText: 'Riverbend Christian B' }).getByText('Changed', { exact: true })).toBeVisible();
	await expect(page.locator('tr', { hasText: 'Lakeview High School' }).getByText('Withdraw', { exact: true })).toBeVisible();
	await expect(page.locator('tr', { hasText: 'Summit High School' }).getByText(/Competing students/)).toBeVisible();
	await expect(page.getByText(/Will add\s+0, update\s+2, withdraw\s+1/)).toBeVisible();
	await page.getByRole('button', { name: 'Apply approved changes' }).click();
	await expect(page.getByText('Import complete: 0 new team(s), 2 updated, 1 withdrawn')).toBeVisible();

	expect(q('SELECT id FROM teams WHERE event_id = ?', eventId)).toHaveLength(7);
	expect(q<{ withdrawn: number }>("SELECT withdrawn FROM teams WHERE event_id = ? AND name = 'Lakeview High School'", eventId)[0].withdrawn).toBe(1);
	expect(q<{ competing_students: number }>("SELECT competing_students FROM teams WHERE event_id = ? AND name = 'Summit High School'", eventId)[0].competing_students).toBe(8);

	// The Teams page reflects it.
	await page.goto(`/events/${eventId}/teams`);
	await expect(page.locator('tr', { hasText: 'Lakeview High School' }).getByText('Withdrawn')).toBeVisible();
	await admin.close();
});

test('check-in enforces the six-player roster limit', async ({ browser }) => {
	const admin = await adminContext(browser);
	const page = await admin.newPage();
	const [team] = q<{ id: number; event_id: number; name: string }>("SELECT id, event_id, name FROM teams WHERE name = 'Pinecrest Academy' ORDER BY id DESC LIMIT 1");
	const [s] = q<{ session_id: number }>('SELECT session_id FROM teams WHERE id = ?', team.id);
	await page.goto(`/events/${team.event_id}/checkin?session=${s.session_id}`);
	await page.getByRole('button', { name: /Pinecrest Academy/ }).click();
	await page.getByRole('button', { name: 'Mark arrived' }).click();
	await expect(page.getByText('✓ Checked in')).toBeVisible();
	for (let i = 1; i <= 6; i++) {
		await page.getByLabel('First name').last().fill(`Test${i}`);
		await page.getByLabel('Last name').last().fill('Player');
		await page.getByRole('button', { name: 'Add player' }).click();
		await expect(page.getByText(`${i} of 6`)).toBeVisible();
	}
	await expect(page.getByRole('button', { name: 'Add player' })).toHaveCount(0);
	await expect(page.getByText(/maximum of 6 players/)).toBeVisible();
	expect(q('SELECT id FROM roster_entries WHERE team_id = ? AND removed = 0', team.id)).toHaveLength(6);

	// The Teams tab lists the players and links straight to that team at check-in.
	await page.goto(`/events/${team.event_id}/teams`);
	// Names stay hidden until the team (or its player count) is clicked.
	await expect(page.getByText('Test1 Player')).toHaveCount(0);
	await page.getByRole('button', { name: '6 players' }).click();
	await expect(page.getByText('Test1 Player')).toBeVisible();
	await expect(page.getByText('Test6 Player')).toBeVisible();
	await page.getByRole('link', { name: 'Edit players' }).click();
	await expect(page.getByRole('heading', { name: 'Pinecrest Academy' })).toBeVisible();
	await expect(page.getByText('6 of 6')).toBeVisible();
	await admin.close();
});
