import { expect, test } from '@playwright/test';
import { adminContext, createPracticeEvent, postAction, q, roomLogin, waitFor } from './helpers';

test.describe('practice rooms', () => {
	test('a bye room marked as practice starts its own games, and nothing scored there counts', async ({ browser }) => {
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);

		// Add a bye room and mark it as a practice room.
		await postAction(admin.request, `/events/${eventId}/setup/rooms?/add`, {});
		const [room] = q<{ id: number; pin: string; name: string }>('SELECT id, pin, name FROM rooms WHERE event_id = ? ORDER BY id DESC LIMIT 1', eventId);
		const adminPage = await admin.newPage();
		await adminPage.goto(`/events/${eventId}/setup/rooms`);
		await adminPage.locator(`tr[data-room="${room.id}"]`).getByLabel('Practice / bye room').check();
		await expect(adminPage.getByText(`${room.name} is now a practice room`)).toBeVisible();
		await adminPage.screenshot({ path: 'test-results/practice-rooms-setup.png', fullPage: true });

		// A regular room with games can't be switched.
		const [busy] = q<{ id: number }>('SELECT r.id FROM rooms r JOIN matches m ON m.room_id = r.id WHERE r.event_id = ? LIMIT 1', eventId);
		await adminPage.locator(`tr[data-room="${busy.id}"]`).getByLabel('Practice / bye room').click();
		await expect(adminPage.getByText(/Move or delete/)).toBeVisible();

		// The room's computer starts a practice game.
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await roomLogin(page, room.pin);
		await expect(page.getByText('PRACTICE ROOM · scores here never count')).toBeVisible();
		await expect(page.getByRole('heading', { name: `Start a practice game in ${room.name}` })).toBeVisible();
		const teamA = page.getByLabel('Team A');
		const teamB = page.getByLabel('Team B');
		await teamA.selectOption({ index: 1 });
		await teamB.selectOption({ index: 2 });
		await page.screenshot({ path: 'test-results/practice-room-start.png', fullPage: true });
		await page.getByRole('button', { name: 'Start practice game' }).click();
		await expect(page.getByRole('heading', { name: /choose who is playing/ })).toBeVisible();
		await page.getByRole('button', { name: 'Start round' }).click();
		await page.keyboard.press('1');
		await page.keyboard.press('c');

		const [pm] = q<{ id: number; counts: number }>('SELECT id, counts FROM matches WHERE room_id = ?', room.id);
		expect(pm.counts).toBe(0);
		await waitFor(() => q('SELECT 1 FROM score_events WHERE match_id = ? AND type = ?', pm.id, 'tossup_answer').length > 0);

		// Staff see it under Practice rooms on the schedule, not in the schedule grid.
		await adminPage.goto(`/events/${eventId}/schedule`);
		await expect(adminPage.getByRole('heading', { name: 'Practice rooms' })).toBeVisible();
		await expect(adminPage.getByText('Scored (practice)')).toBeVisible();
		await expect(adminPage.locator('table.grid th', { hasText: room.name })).toHaveCount(0);
	});
});
