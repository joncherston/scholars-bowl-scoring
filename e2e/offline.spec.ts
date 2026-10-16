import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { adminContext, createPracticeEvent, firstRoomGame, roomLogin, score, storedEvents, waitFor } from './helpers';

async function correctWithBonus(page: Page, playerKey: string, parts: string[]) {
	await page.keyboard.press(playerKey);
	await page.keyboard.press('c');
	await expect(page.locator('.action .bonus')).toBeVisible();
	const chip = page.locator('.chips').first().getByRole('button', { name: '20', exact: true });
	if (!(await chip.evaluate((el) => el.classList.contains('on')))) await chip.click();
	await page.locator('.chips').nth(1).getByRole('button', { name: String(parts.length), exact: true }).click();
	for (const p of parts) await page.keyboard.press(p);
	await page.keyboard.press('Enter');
	await expect(page.locator('.action .bonus')).toHaveCount(0);
}

test.describe('offline scoring', () => {
	test('keeps scoring offline, survives a reload with no connection, and syncs when back', async ({ browser }) => {
		const admin = await adminContext(browser);
		const g = firstRoomGame(await createPracticeEvent(admin.request));
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		page.on('dialog', (d) => d.accept());
		await roomLogin(page, g.pin);
		await page.getByRole('button', { name: 'Start round' }).click();
		await correctWithBonus(page, '1', ['1']);
		await waitFor(() => storedEvents(g.match.id).length === 3);
		await expect(page.getByText('All changes saved')).toBeVisible();
		// The page must be able to reload offline, so the service worker has to be in control.
		await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15000 });

		await ctx.setOffline(true);
		await correctWithBonus(page, '7', ['1', '2']);
		await page.keyboard.press('d');
		// A: 10 + 20 (one-part bonus right); B: 10 + 20 (two parts of 20, both right).
		await expect(score(page, g.teamA)).toHaveText('30');
		await expect(score(page, g.teamB)).toHaveText('30');
		await expect(page.getByText(/Offline — 3 actions waiting/)).toBeVisible({ timeout: 20000 });
		await expect(page.getByRole('alert').filter({ hasText: 'saved on this computer but not yet on the server' })).toBeVisible({ timeout: 20000 });

		// Rescue file: every action this device recorded, with a checksum.
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('alert').getByRole('button', { name: 'Download unsaved results' }).click()
		]);
		const file = JSON.parse(fs.readFileSync((await download.path())!, 'utf8'));
		expect(file).toMatchObject({ format: 'sb-scorer-rescue', version: 1, unsent: 3 });
		expect(file.events).toHaveLength(6);
		expect(crypto.createHash('sha256').update(JSON.stringify(file.events)).digest('hex')).toBe(file.sha256);

		// Reload with no connection: the page comes back from the service worker with the score intact.
		await page.reload();
		await expect(score(page, g.teamB)).toHaveText('30');
		await expect(page.getByText(/Offline — 3 actions waiting/)).toBeVisible({ timeout: 20000 });
		expect(storedEvents(g.match.id)).toHaveLength(3);

		// Back online: the queued actions go up in order, once each.
		await ctx.setOffline(false);
		await expect(page.getByText('All changes saved')).toBeVisible({ timeout: 20000 });
		const evs = storedEvents(g.match.id);
		expect(evs.map((e) => e.type)).toEqual(['round_started', 'tossup_answer', 'bonus', 'tossup_answer', 'bonus', 'tossup_dead']);
		expect(evs.map((e) => e.device_seq)).toEqual([1, 2, 3, 4, 5, 6]);
		await ctx.close();
		await admin.close();
	});

	test("recovers a lost computer's actions from its results file", async ({ browser }) => {
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);
		const g = firstRoomGame(eventId);

		// Computer 1 scores, loses its connection, saves a results file, and is then lost.
		const c1 = await browser.newContext();
		const p1 = await c1.newPage();
		await roomLogin(p1, g.pin);
		await p1.getByRole('button', { name: 'Start round' }).click();
		await waitFor(() => storedEvents(g.match.id).length === 1);
		await c1.setOffline(true);
		await correctWithBonus(p1, '1', ['1', '2']);
		await correctWithBonus(p1, '7', ['1']);
		const [dl] = await Promise.all([p1.waitForEvent('download'), p1.getByRole('button', { name: 'Download unsaved results' }).first().click()]);
		const filePath = test.info().outputPath('rescue.json');
		await dl.saveAs(filePath);
		// The computer is lost: it never reconnects (closing a test browser would briefly lift "offline").
		await c1.route('**/*', (r) => r.abort());
		await c1.close();
		expect(storedEvents(g.match.id)).toHaveLength(1);

		// Computer 2 takes over the room; the server only has the start of the round.
		const c2 = await browser.newContext();
		const p2 = await c2.newPage();
		await p2.goto('/room');
		await p2.getByLabel('Room PIN').fill(g.pin);
		await p2.getByRole('button', { name: 'Start scoring' }).click();
		await expect(p2.getByRole('heading', { name: /is open on another computer/ })).toBeVisible();
		await p2.getByRole('button', { name: /score .* on this computer/ }).click();
		await p2.waitForURL('**/scorer');
		await expect(score(p2, g.teamA)).toHaveText('0');

		// The head scorekeeper imports the file; only the missing actions are added.
		const staff = await admin.newPage();
		await staff.goto(`/events/${eventId}/live/import`);
		await staff.getByLabel('Results file (.json)').setInputFiles(filePath);
		await staff.getByRole('button', { name: 'Preview' }).click();
		await expect(staff.getByText(/1 already on the server/)).toBeVisible();
		await expect(staff.getByText('4 new', { exact: true })).toBeVisible();
		await staff.getByRole('button', { name: 'Import 4 new action(s)' }).click();
		await expect(staff.getByText(/Imported 4 new action/)).toBeVisible();
		const evs = storedEvents(g.match.id);
		expect(evs.filter((e) => e.source === 'file_import')).toHaveLength(4);
		expect(evs.map((e) => e.type)).toEqual(['round_started', 'device_takeover', 'tossup_answer', 'bonus', 'tossup_answer', 'bonus']);

		// Importing the same file again changes nothing.
		await staff.goto(`/events/${eventId}/live/import`);
		await staff.getByLabel('Results file (.json)').setInputFiles(filePath);
		await staff.getByRole('button', { name: 'Preview' }).click();
		await expect(staff.getByRole('button', { name: 'Import 0 new action(s)' })).toBeDisabled();

		// Computer 2 picks up the imported actions and keeps scoring from there.
		await p2.reload();
		await expect(score(p2, g.teamA)).toHaveText('30');
		await expect(score(p2, g.teamB)).toHaveText('30');
		await waitFor(() => true);
		await c2.close();
		await admin.close();
	});
});
