import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { adminContext, createPracticeEvent, firstRoomGame, roomLogin, roster, score, storedEvents, waitFor } from './helpers';

/** A cell of the classic scoresheet by its Excel address (merged areas by their top-left cell). */
const cell = (page: Page, addr: string) => {
	const m = /^([A-Z])(\d+)$/.exec(addr)!;
	return page.locator(`[data-cell="${Number(m[2]) - 1}-${m[1].charCodeAt(0) - 65}"]`);
};
async function typeIn(page: Page, addr: string, text: string, key = 'Enter') {
	await cell(page, addr).click();
	await page.keyboard.type(text);
	await page.keyboard.press(key);
}

test.describe('classic spreadsheet scoring', () => {
	test('scores a round in the spreadsheet, shows it on the new screen, and submits', async ({ browser }) => {
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);
		const g = firstRoomGame(eventId);
		const rosterA = roster(g.match.team_a_id);

		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await roomLogin(page, g.pin, 'sheet');

		// Filled in from the schedule: round, room, schools and players.
		await expect(cell(page, 'B2')).toHaveText('1');
		await expect(cell(page, 'O2')).toHaveText(g.roomName);
		await expect(cell(page, 'B3')).toHaveText(g.teamA);
		await expect(cell(page, 'K3')).toHaveText(g.teamB);
		await expect(cell(page, 'B4')).toContainText(rosterA[0].name);
		await expect(page.getByRole('tab', { name: 'Round (1)' }).first()).toHaveAttribute('aria-selected', 'true');

		await typeIn(page, 'I2', 'Dr. Example');
		await typeIn(page, 'B5', '10', 'Tab');
		await typeIn(page, 'G5', '20');
		await typeIn(page, 'L6', '10', 'Tab');
		await typeIn(page, 'P6', '15');
		await expect(cell(page, 'H5')).toHaveText('30');
		await expect(cell(page, 'R6')).toHaveText('25');
		await expect(cell(page, 'B31')).toHaveText('30');
		await expect(cell(page, 'K31')).toHaveText('25');
		await expect(cell(page, 'B33')).toHaveText('1');

		// A value the old sheet would not take in a player's column is refused.
		await typeIn(page, 'C7', '20');
		await expect(page.getByText("In a player's column, type 10 for a correct answer, 0 for a wrong answer.")).toBeVisible();
		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect(cell(page, 'C7')).toHaveText('');

		// Ctrl+Z takes back the last entry.
		await typeIn(page, 'C7', '10');
		await expect(cell(page, 'B31')).toHaveText('40');
		await page.keyboard.press('Control+z');
		await expect(cell(page, 'B31')).toHaveText('30');

		await waitFor(() => storedEvents(g.match.id).some((e) => e.type === 'bonus' && JSON.parse(e.body).value === 1500));
		const types = storedEvents(g.match.id).map((e) => e.type);
		expect(types.slice(0, 2)).toEqual(['note', 'round_started']);
		expect(types.filter((t) => t === 'bonus')).toHaveLength(2);

		// The new screen shows the same round, and the computer remembers the choice.
		await page.getByRole('button', { name: 'Menu ▾' }).click();
		await page.getByRole('menuitem', { name: 'Switch to the new scoring screen' }).click();
		await page.waitForURL('**/scorer');
		await expect(score(page, g.teamA)).toHaveText('30');
		await expect(score(page, g.teamB)).toHaveText('25');
		await page.getByRole('button', { name: 'Menu' }).click();
		await page.getByRole('menuitem', { name: 'Switch to the spreadsheet' }).click();
		await page.waitForURL('**/sheet');
		await page.goto('/room');
		await page.waitForURL('**/sheet');

		await page.getByRole('button', { name: 'Submit round' }).click();
		await expect(page.getByRole('dialog')).toContainText(`${g.teamA} 30, ${g.teamB} 25`);
		await page.getByLabel('I confirmed the final score with the moderator').check();
		await page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
		await expect(page.getByText('Submitted — waiting for approval')).toBeVisible();
		const sub = await waitFor(() => storedEvents(g.match.id).find((e) => e.type === 'submitted'));
		expect(JSON.parse(sub.body)).toEqual({ type: 'submitted', scoreA: 3000, scoreB: 2500 });

		await cell(page, 'B8').click();
		await page.keyboard.press('1');
		await expect(page.getByText(/was submitted\. Changes are now made by the head scorekeeper/)).toBeVisible();
		await ctx.close();
		await admin.close();
	});

	test('imports a round from an Excel scoresheet, asking about names that do not match', async ({ browser }) => {
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);
		const g = firstRoomGame(eventId);
		const rosterA = roster(g.match.team_a_id);
		const rosterB = roster(g.match.team_b_id);

		// The room's own Excel file: the teams the other way round, one school and one player spelled differently.
		const wb = new ExcelJS.Workbook();
		const ws = wb.addWorksheet('Round (1)');
		const put = (addr: string, v: string | number) => (ws.getCell(addr).value = v);
		put('A4', 'Players');
		put('J3', 'TU Number');
		put('I2', 'Mr. Example');
		put('B3', g.teamB);
		put('K3', `${g.teamA.toUpperCase()} HIGH`);
		put('B4', rosterB[0].name);
		const [first, ...rest] = rosterB[1].name.split(' ');
		put('C4', `${first[0]}. ${rest.join(' ')}`);
		put('K4', rosterA[0].name.toLowerCase());
		put('C5', 10);
		put('G5', 20);
		put('K6', 10);
		put('P6', 12.5);
		put('B7', 0);
		put('K7', 10);
		put('P7', 30);
		const buffer = Buffer.from(await wb.xlsx.writeBuffer());

		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await roomLogin(page, g.pin, 'sheet');
		await page.getByRole('button', { name: 'Import scores' }).click();
		await page.getByLabel('Scoresheet file').setInputFiles({ name: 'Room scoresheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });

		const dialog = page.getByRole('dialog');
		await expect(dialog.getByLabel(`School for ${g.teamB}`)).toHaveValue('B');
		await expect(dialog.getByLabel(`School for ${g.teamA.toUpperCase()} HIGH`)).toHaveValue('A');
		await expect(dialog.getByLabel(`Player for ${rosterB[0].name}`)).toHaveValue(rosterB[0].id);
		await expect(dialog.getByLabel(`Player for ${rosterA[0].name.toLowerCase()}`)).toHaveValue(rosterA[0].id);
		const unmatched = dialog.getByLabel(`Player for ${first[0]}. ${rest.join(' ')}`);
		await expect(unmatched).toHaveValue('');
		await expect(dialog.getByRole('button', { name: 'Import' })).toBeDisabled();
		await unmatched.selectOption(rosterB[1].id);
		await expect(dialog).toContainText(`After importing: ${g.teamA} 62.5, ${g.teamB} 30`);
		await dialog.getByRole('button', { name: 'Import' }).click();

		await expect(cell(page, 'B31')).toHaveText('62.5');
		await expect(cell(page, 'K31')).toHaveText('30');
		await expect(cell(page, 'I2')).toHaveText('Mr. Example');
		await expect(cell(page, 'K4')).toContainText(rosterB[0].name);
		await expect(cell(page, 'L4')).toContainText(rosterB[1].name);
		await waitFor(() => storedEvents(g.match.id).filter((e) => e.type === 'bonus').length === 3);
		const answers = storedEvents(g.match.id)
			.filter((e) => e.type === 'tossup_answer')
			.map((e) => JSON.parse(e.body));
		expect(answers.map((a) => [a.tossup, a.side, a.playerId, a.correct])).toEqual([
			[1, 'B', rosterB[1].id, true],
			[2, 'A', rosterA[0].id, true],
			[3, 'B', rosterB[0].id, false],
			[3, 'A', rosterA[0].id, true]
		]);
		await ctx.close();
		await admin.close();
	});
});
