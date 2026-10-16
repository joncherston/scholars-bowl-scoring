import { expect, test } from '@playwright/test';
import { adminContext, createPracticeEvent, firstRoomGame, q, roomLogin, roster, score, storedEvents, waitFor } from './helpers';

test.describe('room scorer', () => {
	test('scores a full round by keyboard, then submits and locks it', async ({ browser }) => {
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);
		const g = firstRoomGame(eventId);
		const rosterA = roster(g.match.team_a_id);
		const rosterB = roster(g.match.team_b_id);

		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await roomLogin(page, g.pin);

		// Lineup: defaults are the first four players on each roster.
		await expect(page.getByRole('heading', { name: /choose who is playing/ })).toBeVisible();
		await page.getByRole('button', { name: 'Start round' }).click();
		await expect(page.getByText('Who buzzed?')).toBeVisible();

		// Tossup 1: A's first player correct; bonus 20 points, 2 parts, 1 right = 10.
		await page.keyboard.press('1');
		await page.keyboard.press('c');
		await expect(page.getByRole('heading', { name: `Bonus for ${g.teamA}` })).toBeVisible();
		await page.locator('.chips').first().getByRole('button', { name: '20', exact: true }).click();
		await page.keyboard.press('=');
		await page.keyboard.press('1');
		await expect(page.locator('.preview')).toContainText('10');
		await page.keyboard.press('Enter');
		await expect(score(page, g.teamA)).toHaveText('20');

		// Tossup 2: B wrong, then A's second player correct; bonus value carries over (20), 2 of 2 right.
		await page.keyboard.press('7');
		await page.keyboard.press('x');
		await expect(page.getByRole('heading', { name: `${g.teamA}'s turn` })).toBeVisible();
		// B's players are locked out after their miss.
		await expect(page.locator('button.player', { hasText: rosterB[0].name })).toBeDisabled();
		await page.keyboard.press('2');
		await page.keyboard.press('c');
		await page.keyboard.press('1');
		await page.keyboard.press('2');
		await page.keyboard.press('Enter');
		await expect(score(page, g.teamA)).toHaveText('50');

		// Tossup 3: B correct with the mouse; bonus via chips; then undo the bonus and redo it.
		await page.locator('button.player', { hasText: rosterB[1].name }).click();
		await page.getByRole('button', { name: /Correct/ }).click();
		await page.locator('.chips').first().getByRole('button', { name: '30', exact: true }).click();
		await page.locator('.chips').nth(1).getByRole('button', { name: '3', exact: true }).click();
		await page.getByRole('button', { name: /Part 1:/ }).click();
		await page.getByRole('button', { name: /Save bonus/ }).click();
		await expect(score(page, g.teamB)).toHaveText('20');
		await expect(page.getByRole('button', { name: /Undo: Tossup 3 bonus/ })).toBeVisible();
		await page.keyboard.press('u');
		await expect(score(page, g.teamB)).toHaveText('10');
		await expect(page.getByRole('heading', { name: `Bonus for ${g.teamB}` })).toBeVisible();
		await page.locator('.chips').first().getByRole('button', { name: '30', exact: true }).click();
		await page.locator('.chips').nth(1).getByRole('button', { name: '3', exact: true }).click();
		await page.keyboard.press('1');
		await page.keyboard.press('2');
		await page.keyboard.press('Enter');
		await expect(score(page, g.teamB)).toHaveText('30');

		// Tossups 4-12 dead; the score-announcement prompt appears after tossup 12.
		for (let i = 4; i <= 12; i++) {
			await expect(page.getByText(`Tossup ${i}`, { exact: true })).toBeVisible();
			await page.keyboard.press('d');
		}
		await expect(page.getByRole('heading', { name: 'Announce the score' })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(page.getByText('Tossup 13', { exact: true })).toBeVisible();

		// End the round, review, confirm with the moderator, submit.
		await page.keyboard.press('e');
		await page.getByRole('button', { name: 'End round and review' }).click();
		await expect(page.getByRole('heading', { name: /Review and submit/ })).toBeVisible();
		const submit = page.getByRole('button', { name: 'Submit round' });
		await expect(submit).toBeDisabled();
		await page.getByLabel(/I confirmed the final score/).check();
		await submit.click();
		await expect(page.getByText('Waiting for the head scorekeeper to approve')).toBeVisible();
		await expect(page.getByText('All changes saved')).toBeVisible();

		// The server has exactly what happened, in order, with contiguous device numbering.
		const evs = await waitFor(() => {
			const e = storedEvents(g.match.id);
			return e.some((x) => x.type === 'submitted') && e;
		});
		expect(evs.map((e) => e.device_seq)).toEqual(evs.map((_, i) => i + 1));
		const types = evs.map((e) => e.type);
		expect(types.filter((t) => t === 'undo')).toHaveLength(1);
		expect(types.filter((t) => t === 'tossup_dead')).toHaveLength(9);
		const submitted = JSON.parse(evs.find((e) => e.type === 'submitted')!.body);
		expect(submitted).toMatchObject({ scoreA: 5000, scoreB: 3000 });
		expect(evs.some((e) => e.type === 'note' && JSON.parse(e.body).text.includes('tossup 12'))).toBe(true);

		// The round is locked for the room: a direct API attempt is rejected.
		const res = await page.request.post('/api/scorer/events', {
			data: { events: [{ id: crypto.randomUUID(), matchId: g.match.id, body: { type: 'tossup_dead', tossup: 14 } }] }
		});
		expect((await res.json()).results[0]).toMatchObject({ status: 'rejected', reason: 'round_submitted' });

		// The projector link shows the final score.
		const state = await (await page.request.get('/api/scorer/state')).json();
		const proj = await ctx.newPage();
		await proj.goto(`/projector/${state.room.projectorToken}`);
		await expect(score(proj, g.teamA)).toHaveText('50');
		await expect(proj.getByText('Final')).toBeVisible();
		expect(rosterA.length).toBeGreaterThanOrEqual(4);
		await ctx.close();
		await admin.close();
	});

	test('shows the next game after submitting and defaults lineups to the previous round', async ({ browser }) => {
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);
		const g = firstRoomGame(eventId);
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await roomLogin(page, g.pin);
		// Play team A with a non-default lineup: drop their first player.
		const rosterA = roster(g.match.team_a_id);
		await page.getByLabel(rosterA[0].name, { exact: true }).uncheck();
		await page.getByRole('button', { name: 'Start round' }).click();
		await page.keyboard.press('d');
		await page.keyboard.press('e');
		// A 0-0 round is tied: the end dialog offers a tiebreaker instead of ending.
		await expect(page.getByRole('heading', { name: /The score is tied/ })).toBeVisible();
		await page.getByRole('button', { name: 'Start tiebreaker' }).click();
		await expect(page.getByText('Tiebreaker 1', { exact: true })).toBeVisible();
		await page.keyboard.press('7');
		await page.keyboard.press('c');
		await expect(page.getByRole('heading', { name: new RegExp(`Tiebreaker won by ${g.teamB}`) })).toBeVisible();
		await page.keyboard.press('e');
		await page.getByRole('button', { name: 'End round and review' }).click();
		await page.getByLabel(/I confirmed the final score/).check();
		await page.getByRole('button', { name: 'Submit round' }).click();
		await expect(page.getByText('Waiting for the head scorekeeper to approve')).toBeVisible();
		await expect(score(page, g.teamB)).toHaveText('10');

		// Team A's next game (in whatever room) defaults to the lineup it just used.
		const [nextGame] = q<{ id: number; pin: string; team_a_id: number }>(
			`SELECT m.id, r.pin, m.team_a_id FROM matches m JOIN rooms r ON r.id = m.room_id
			 WHERE m.session_id = ? AND m.round_no > 1 AND (m.team_a_id = ? OR m.team_b_id = ?) ORDER BY m.round_no LIMIT 1`,
			g.match.session_id,
			g.match.team_a_id,
			g.match.team_a_id
		);
		const other = await browser.newContext();
		const op = await other.newPage();
		await roomLogin(op, nextGame.pin);
		const st = await (await op.request.get('/api/scorer/state')).json();
		const m = st.matches.find((x: { id: number }) => x.id === nextGame.id);
		const side = nextGame.team_a_id === g.match.team_a_id ? 'A' : 'B';
		expect(m.teams[side].defaultLineup).toEqual(rosterA.slice(1, 4).map((p) => p.id));
		await other.close();
		await ctx.close();
		await admin.close();
	});
});
