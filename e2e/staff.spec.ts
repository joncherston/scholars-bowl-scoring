import { expect, test } from '@playwright/test';
import { adminContext, BASE, createPracticeEvent, firstRoomGame, postAction, q, roomLogin, score, storedEvents, waitFor } from './helpers';

test.describe('head scorekeeper', () => {
	test('approves, corrects with reasons, resolves ties, finalizes, and prints', async ({ browser }) => {
		test.setTimeout(240_000);
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);
		const [session] = q<{ id: number; name: string }>('SELECT id, name FROM sessions WHERE event_id = ? ORDER BY sort_order LIMIT 1', eventId);
		const matchIds = q<{ id: number }>('SELECT id FROM matches WHERE session_id = ? ORDER BY round_no, room_id', session.id).map((m) => m.id);

		// Play the whole session instantly, without approving.
		const sim = await postAction(admin.request, `/events/${eventId}/live?/simulate`, { sessionId: String(session.id), stepMs: '0' });
		expect(sim.status()).toBeLessThan(400);
		await waitFor(() => q('SELECT DISTINCT match_id FROM score_events WHERE type = ? AND match_id IN (SELECT id FROM matches WHERE session_id = ?)', 'submitted', session.id).length === matchIds.length, 60_000);

		const page = await admin.newPage();
		page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Coach sheet shows otherwise (e2e)') : d.accept()));
		await page.goto(`/events/${eventId}/live?session=${session.id}`);
		await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(matchIds.length);
		await expect(page.getByRole('button', { name: 'Finalize session' })).toBeDisabled();

		// One round: approve, then a correction withdraws the approval until re-approved.
		const first = matchIds[0];
		await page.goto(`/events/${eventId}/live/match/${first}`);
		await page.getByRole('button', { name: 'Approve', exact: true }).click();
		await expect(page.getByText('Approved.')).toBeVisible();
		const firstAnswer = page.locator('tbody tr', { hasText: /Tossup \d+: .* correct/ }).first();
		// The confirm offers to void the bonus that answer earned; the dialog handler accepts it.
		await firstAnswer.getByRole('button', { name: 'Void…' }).click();
		await expect(page.getByText('Entry and its bonus voided.')).toBeVisible();
		await expect(page.getByText(/bonus recorded before a correct tossup answer/)).toHaveCount(0);
		await expect(page.locator('tr.voided').first()).toContainText('Coach sheet shows otherwise (e2e)');
		await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
		await expect(page.getByText(/changed after it was submitted/).first()).toBeVisible();

		// Add a missing entry (a dead tossup) with a reason.
		await page.getByRole('button', { name: 'Add a missing entry' }).click();
		const dlg = page.locator('dialog[open]');
		await dlg.getByLabel('Entry').selectOption('tossup_dead');
		await dlg.getByLabel('Tossup number').fill('30');
		await dlg.getByLabel('Reason (required)').fill('Moderator read a tossup the scorer missed (e2e)');
		await dlg.getByRole('button', { name: 'Add entry' }).click();
		await expect(page.getByText('Entry added.')).toBeVisible();
		await page.getByRole('button', { name: 'Approve', exact: true }).click();
		await expect(page.getByText('Approved.')).toBeVisible();
		const corrections = storedEvents(first).filter((e) => e.type === 'correction');
		expect(corrections.map((c) => JSON.parse(c.body).action)).toEqual(['void', 'void', 'add']);
		expect(corrections.every((c) => c.actor.startsWith('user:'))).toBe(true);

		// The audit printout shows the voided entry and the reason.
		await page.goto(`/events/${eventId}/reports/round/${first}`);
		await expect(page.getByText('Coach sheet shows otherwise (e2e)').first()).toBeVisible();

		// Approve everything else from the dashboard grid.
		await page.goto(`/events/${eventId}/live?session=${session.id}`);
		for (let left = matchIds.length - 1; left > 0; left--) {
			await page.getByRole('button', { name: 'Approve' }).first().click();
			await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(left - 1);
		}

		// Ties at award places must be decided (and recorded) before finalizing.
		const resolveButtons = page.getByRole('button', { name: 'Resolve tie' });
		for (let left = await resolveButtons.count(); left > 0; left--) {
			await resolveButtons.first().click();
			await page.locator('dialog[open]').getByLabel('How was it decided?').fill('Sudden-death question at the awards table (e2e)');
			await page.locator('dialog[open]').getByRole('button', { name: 'Record decision' }).click();
			await expect(page.getByText('Tie resolution recorded.')).toBeVisible();
			await expect(resolveButtons).toHaveCount(left - 1);
		}
		await page.getByRole('button', { name: 'Finalize session' }).click();
		await expect(page.getByText('Session finalized. Results are locked for awards.')).toBeVisible();

		// Awards are final now; PDF and Excel come out.
		await page.goto(`/events/${eventId}/reports/awards?session=${session.id}`);
		await expect(page.getByText(/PROVISIONAL/)).toHaveCount(0);
		await expect(page.getByText('Overall division winners')).toBeVisible();
		const pdf = await admin.request.get(`/events/${eventId}/reports/pdf?path=${encodeURIComponent(`/events/${eventId}/reports/awards?session=${session.id}`)}&name=awards`);
		expect(pdf.headers()['content-type']).toBe('application/pdf');
		expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
		const xlsx = await admin.request.get(`/events/${eventId}/reports/export.xlsx`);
		expect(xlsx.status()).toBe(200);
		expect((await xlsx.body()).subarray(0, 2).toString()).toBe('PK');
		await admin.close();
	});
});

test.describe('device takeover', () => {
	test('a second computer takes over; the first stops and its late actions are kept but rejected', async ({ browser }) => {
		const admin = await adminContext(browser);
		const g = firstRoomGame(await createPracticeEvent(admin.request));
		const c1 = await browser.newContext();
		const p1 = await c1.newPage();
		await roomLogin(p1, g.pin);
		await p1.getByRole('button', { name: 'Start round' }).click();
		await waitFor(() => storedEvents(g.match.id).length === 1);

		const c2 = await browser.newContext();
		const p2 = await c2.newPage();
		await p2.goto('/room');
		await p2.getByLabel('Room PIN').fill(g.pin);
		await p2.getByRole('button', { name: /with the new screen/ }).click();
		await expect(p2.getByRole('heading', { name: new RegExp(`${g.roomName} is open on another computer`) })).toBeVisible();
		await p2.getByRole('button', { name: /on this computer/ }).click();
		await p2.waitForURL('**/scorer');
		await expect(p2.getByText('Who buzzed?')).toBeVisible();

		await p1.keyboard.press('d');
		await expect(p1.getByRole('heading', { name: 'This room is now being scored on another computer' })).toBeVisible({ timeout: 20_000 });
		await waitFor(() => q("SELECT id FROM rejected_events WHERE match_id = ? AND reason = 'device_replaced'", g.match.id).length === 1);
		expect(storedEvents(g.match.id).map((e) => e.type)).toEqual(['round_started', 'device_takeover']);

		// The new computer carries on normally.
		await p2.keyboard.press('d');
		await waitFor(() => storedEvents(g.match.id).length === 3);
		await c1.close();
		await c2.close();
		await admin.close();
	});
});

test.describe('access control', () => {
	test('anonymous visitors, room scorers, and check-in staff only reach what they should', async ({ browser, request }) => {
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);
		const g = firstRoomGame(eventId);

		// Anonymous
		expect((await request.get('/api/scorer/state')).status()).toBe(401);
		const anon = await browser.newContext();
		const ap = await anon.newPage();
		await ap.goto(`/events/${eventId}/live`);
		await expect(ap).toHaveURL(/\/login\?next=/);
		expect((await request.get(`/results/${eventId}`)).status()).toBe(404); // practice events are never public
		await ap.goto('/room');
		await ap.getByLabel('Room PIN').fill('000000');
		await ap.getByRole('button', { name: /with the new screen/ }).click();
		await expect(ap.getByText(/That PIN does not match a room/)).toBeVisible();

		// A room scorer cannot open staff pages.
		await roomLogin(ap, g.pin);
		await ap.goto(`/events/${eventId}/live`);
		await expect(ap).toHaveURL(/\/login\?next=/);
		await anon.close();

		// Check-in staff: temporary password, forced change, then check-in only.
		const email = `checkin-${eventId}@example.test`;
		expect((await postAction(admin.request, `/events/${eventId}/setup/staff?/add`, { name: 'Casey Checkin', email, role: 'checkin' })).status()).toBeLessThan(400);
		expect((await postAction(admin.request, `/events/${eventId}/setup/staff?/password`, { email, password: 'temporary-pass-1' })).status()).toBeLessThan(400);
		const staff = await browser.newContext({ baseURL: BASE });
		const sp = await staff.newPage();
		await sp.goto('/login');
		await sp.getByLabel('Email').fill(email);
		await sp.getByLabel('Password').fill('temporary-pass-1');
		await sp.getByRole('button', { name: 'Sign in' }).click();
		// A temporary password forces a change before anything else.
		await expect(sp).toHaveURL(/\/account\?required=1/);
		await sp.goto(`/events/${eventId}/checkin`);
		await expect(sp).toHaveURL(/\/account\?required=1/);
		await sp.getByLabel('Current password').fill('temporary-pass-1');
		await sp.getByLabel(/^New password/).fill('my-own-password-1');
		await sp.getByLabel('Confirm new password').fill('my-own-password-1');
		await sp.getByRole('button', { name: 'Change password' }).click();
		await expect(sp.getByText('Password changed.')).toBeVisible();
		const checkin = await sp.goto(`/events/${eventId}/checkin`);
		expect(checkin?.status()).toBe(200);
		expect((await sp.goto(`/events/${eventId}/live`))?.status()).toBe(403);
		expect((await sp.goto(`/events/${eventId}/setup/settings`))?.status()).toBe(403);
		expect((await sp.goto('/admin'))?.status()).toBe(403);
		await expect(sp.getByRole('link', { name: 'Live' })).toHaveCount(0);
		await staff.close();
		await admin.close();
	});
});

test.describe('return to room', () => {
	test('the head scorekeeper sends a round back; the scorer fixes it and resubmits', async ({ browser }) => {
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);
		const g = firstRoomGame(eventId);

		const room = await browser.newContext();
		const rp = await room.newPage();
		await roomLogin(rp, g.pin);
		await rp.getByRole('button', { name: 'Start round' }).click();
		await rp.keyboard.press('1');
		await rp.keyboard.press('c');
		await rp.locator('.chips').first().getByRole('button', { name: '10', exact: true }).click();
		await rp.keyboard.press('Enter');
		await rp.keyboard.press('e');
		await rp.getByRole('button', { name: 'End round and review' }).click();
		await rp.getByLabel(/I confirmed the final score/).check();
		await rp.getByRole('button', { name: 'Submit round' }).click();
		await expect(rp.getByText('Waiting for the head scorekeeper to approve')).toBeVisible();

		const staff = await admin.newPage();
		staff.on('dialog', (d) => d.accept('Coach says tossup 2 was answered (e2e)'));
		await staff.goto(`/events/${eventId}/live/match/${g.match.id}`);
		await staff.getByRole('button', { name: 'Return to room for editing' }).click();
		await expect(staff.getByRole('status').filter({ hasText: 'Returned to the room' })).toBeVisible();

		// Within a heartbeat the scorer sees the review screen again (no reload needed),
		// goes back to scoring, adds the missing tossup, and resubmits.
		await expect(rp.getByRole('heading', { name: /Review and submit/ })).toBeVisible({ timeout: 25_000 });
		await rp.getByRole('button', { name: 'Back to scoring' }).click();
		await expect(rp.getByText('Tossup 2', { exact: true })).toBeVisible();
		await rp.keyboard.press('7');
		await rp.keyboard.press('c');
		await rp.locator('.chips').first().getByRole('button', { name: '10', exact: true }).click();
		await rp.keyboard.press('1');
		await rp.keyboard.press('Enter');
		await expect(score(rp, g.teamB)).toHaveText('20');
		await rp.keyboard.press('e');
		await rp.getByRole('button', { name: 'End round and review' }).click();
		await rp.getByLabel(/I confirmed the final score/).check();
		await rp.getByRole('button', { name: 'Submit round' }).click();
		await expect(rp.getByText('Waiting for the head scorekeeper to approve')).toBeVisible();
		await waitFor(() => storedEvents(g.match.id).filter((e) => e.type === 'submitted').length === 2);
		const last = storedEvents(g.match.id).filter((e) => e.type === 'submitted').at(-1)!;
		expect(JSON.parse(last.body)).toMatchObject({ scoreA: 1000, scoreB: 2000 });
		await room.close();
		await admin.close();
	});
});
