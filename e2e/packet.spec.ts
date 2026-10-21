import { expect, request as playwrightRequest, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import fs from 'node:fs';
import { adminContext, BASE, createPracticeEvent, postAction, q, waitFor } from './helpers';

test.describe('review packet', () => {
	test('one .zip with the PDFs, the workbook, and a Read me; head scorekeepers only', async ({ browser }) => {
		test.setTimeout(300_000);
		const admin = await adminContext(browser);
		const eventId = await createPracticeEvent(admin.request);
		const [morning, afternoon] = q<{ id: number; name: string }>('SELECT id, name FROM sessions WHERE event_id = ? ORDER BY sort_order', eventId);
		const event = q<{ name: string }>('SELECT name FROM events WHERE id = ?', eventId)[0];

		// Play and approve the morning; the afternoon stays unplayed. Neither is finalized.
		const games = q('SELECT id FROM matches WHERE session_id = ?', morning.id).length;
		const counting = q('SELECT id FROM matches WHERE session_id = ? AND counts = 1', morning.id).length;
		const sim = await postAction(admin.request, `/events/${eventId}/live?/simulate`, { sessionId: String(morning.id), stepMs: '0', approve: 'on' });
		expect(sim.status()).toBeLessThan(400);
		await waitFor(() => q("SELECT DISTINCT match_id FROM score_events WHERE type = 'approved' AND match_id IN (SELECT id FROM matches WHERE session_id = ?)", morning.id).length === games, 60_000);

		const page = await admin.newPage();
		await page.goto(`/events/${eventId}/reports`);
		const button = page.getByRole('button', { name: 'Download review packet' });
		const [download] = await Promise.all([page.waitForEvent('download', { timeout: 240_000 }), button.click()]);
		await expect(page.getByText('Review packet downloaded.')).toBeVisible();
		expect(download.suggestedFilename()).toMatch(new RegExp(`^scholars-bowl-${eventId}-review-packet-[\\d-]+\\.zip$`));

		const zip = await JSZip.loadAsync(fs.readFileSync(await download.path()));
		const names = Object.keys(zip.files);
		expect(names).toEqual([
			'00 Read me.txt',
			'01 Awards sheet - all sessions (PROVISIONAL).pdf',
			`02 ${morning.name} - full results (PROVISIONAL).pdf`,
			`03 ${morning.name} - completed scoresheets (PROVISIONAL).pdf`,
			`04 ${morning.name} - schedule.pdf`,
			`05 ${afternoon.name} - full results (PROVISIONAL).pdf`,
			`06 ${afternoon.name} - completed scoresheets (PROVISIONAL).pdf`,
			`07 ${afternoon.name} - schedule.pdf`,
			'08 Excel workbook (PROVISIONAL).xlsx'
		]);
		for (const name of names.filter((n) => n.endsWith('.pdf'))) {
			const bytes = await zip.file(name)!.async('uint8array');
			expect(Buffer.from(bytes.subarray(0, 5)).toString(), name).toBe('%PDF-');
		}
		// The morning's scoresheets hold every game, so they are by far the largest file.
		expect((await zip.file(names[3])!.async('uint8array')).length).toBeGreaterThan(10 * (await zip.file(names[6])!.async('uint8array')).length);

		const readme = await zip.file('00 Read me.txt')!.async('string');
		expect(readme).toContain(`Event:        ${event.name} (PRACTICE / TEST EVENT)`);
		expect(readme).toContain(`- ${morning.name}: `);
		expect(readme).toContain(`${counting} of ${counting} counting games approved or forfeited`);
		expect(readme).toContain('PROVISIONAL, not finalized');
		expect(readme).toContain('SCORING RULES (settings version 1)');
		expect(readme).toContain('OPEN FLAGS AND TIES');
		expect(readme).not.toContain('MISSING');

		const wb = new ExcelJS.Workbook();
		await wb.xlsx.load(Buffer.from(await zip.file(names[8])!.async('uint8array')) as never);
		const summary = wb.getWorksheet('Summary')!;
		expect(summary.getCell('B1').value).toBe(event.name);
		expect(summary.getColumn(2).values).toContain('PROVISIONAL');

		const [entry] = q<{ actor: string; details: string }>("SELECT actor, details FROM audit_log WHERE event_id = ? AND action = 'review_packet_exported'", eventId);
		expect(entry.actor).toMatch(/^user:\d+$/);
		expect(JSON.parse(entry.details)).toMatchObject({ files: names, missing: [] });

		// The schedule printout can now be a PDF on its own; other pages still can't.
		const pdf = (path: string) => admin.request.get(`/events/${eventId}/reports/pdf?path=${encodeURIComponent(path)}&name=schedule`);
		const schedule = await pdf(`/events/${eventId}/schedule/print?session=${afternoon.id}`);
		expect(schedule.status()).toBe(200);
		expect((await schedule.body()).subarray(0, 5).toString()).toBe('%PDF-');
		expect((await pdf(`/events/${eventId}/live`)).status()).toBe(400);
		expect((await pdf(`/events/${eventId}/reports/packet.zip`)).status()).toBe(400);

		// A bracket builder can open Reports but not the packet.
		const email = `bracket-${eventId}@example.test`;
		expect((await postAction(admin.request, `/events/${eventId}/setup/staff?/add`, { name: 'Blair Bracket', email, role: 'bracket_builder' })).status()).toBeLessThan(400);
		expect((await postAction(admin.request, `/events/${eventId}/setup/staff?/password`, { email, password: 'temporary-pass-2' })).status()).toBeLessThan(400);
		await admin.close();
		const bb = await playwrightRequest.newContext({ baseURL: BASE });
		expect((await postAction(bb, '/login', { email, password: 'temporary-pass-2' })).status()).toBe(303);
		expect((await postAction(bb, '/account?/password', { current: 'temporary-pass-2', password: 'bracket-own-pass-2', confirm: 'bracket-own-pass-2' })).status()).toBeLessThan(400);
		const reports = await bb.get(`/events/${eventId}/reports`);
		expect(reports.status()).toBe(200);
		expect(await reports.text()).not.toContain('Download review packet');
		expect((await bb.get(`/events/${eventId}/reports/packet.zip`)).status()).toBe(403);
		expect(q("SELECT id FROM audit_log WHERE event_id = ? AND action = 'review_packet_exported'", eventId)).toHaveLength(1);
		await bb.dispose();
	});
});
