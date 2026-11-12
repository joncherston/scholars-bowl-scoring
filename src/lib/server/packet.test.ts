import { CONFIRM_ITEMS, DEFAULT_BRACKET_FORMAT, HIGH_SCHOOL_DEFAULTS } from '$lib/engine';
import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, schema, useMemoryDb } from './db';
import { listSessions } from './events';
import { computeLive } from './live';
import { buildReviewPacket, fileSafe, packetPlan, packetReadme, rulesSummary } from './packet';
import { printablePage } from './pdf';
import { createPracticeEvent } from './practice';
import { simulationStatus, startSimulation } from './simulate';

let eventId: number;

beforeEach(() => {
	process.env.DISABLE_BACKUPS = '1';
	useMemoryDb();
	eventId = createPracticeEvent('test', { date: '2026-10-28' });
});

const finalize = (sessionId: number) => getDb().update(schema.sessions).set({ finalizedAt: '2026-10-28T17:05:00.000Z', finalizedBy: 'Head Scorekeeper' }).where(eq(schema.sessions.id, sessionId)).run();

async function playSession(sessionId: number) {
	startSimulation(eventId, sessionId, { stepMs: 0, approve: true, startedBy: 'test', approverId: 1 });
	for (let i = 0; i < 600 && simulationStatus(sessionId)?.running; i++) await new Promise((r) => setTimeout(r, 25));
	expect(simulationStatus(sessionId)).toMatchObject({ running: false, error: null });
}

describe('printablePage', () => {
	it("allows this event's report pages, and its schedule printout in landscape", () => {
		expect(printablePage(5, '/events/5/reports/awards')).toEqual({ path: '/events/5/reports/awards', landscape: false });
		expect(printablePage(5, '/events/5/reports/results?session=3')).toEqual({ path: '/events/5/reports/results?session=3', landscape: false });
		expect(printablePage(5, '/events/5/reports/scoresheets?session=3&round=2&blank=1')?.landscape).toBe(false);
		expect(printablePage(5, '/events/5/reports/round/12')?.landscape).toBe(false);
		expect(printablePage(5, '/events/5/schedule/print?session=3')).toEqual({ path: '/events/5/schedule/print?session=3', landscape: true });
		expect(printablePage(5, '/events/5/reports/./awards')?.path).toBe('/events/5/reports/awards');
	});

	it('refuses anything else', () => {
		for (const p of [
			'',
			'/events/6/reports/awards',
			'/events/55/reports/awards',
			'/events/5/reports/pdf?path=/events/5/reports/awards',
			'/events/5/reports/packet.zip',
			'/events/5/reports/export.xlsx',
			'/events/5/reports',
			'/events/5/reports/../live',
			'/events/5/reports/%2e%2e/live',
			'/events/5/reports/awards/../../setup/staff',
			'/events/5/schedule',
			'/events/5/schedule/print/../../admin',
			'/events/6/schedule/print',
			'//evil.example/events/5/reports/awards',
			'http://evil.example/events/5/reports/awards',
			'/\\evil.example/events/5/reports/awards',
			'events/5/reports/awards',
			'/admin'
		])
			expect(printablePage(5, p), p).toBeNull();
	});
});

describe('packet file names', () => {
	it('are plain ASCII without reserved characters', () => {
		expect(fileSafe('Mock Day — 2026 Scholars’ Bowl', 'x')).toBe("Mock Day - 2026 Scholars' Bowl");
		expect(fileSafe('Été', 'x')).toBe('Ete');
		expect(fileSafe('A/B: "1A|2A"?', 'x')).toMatch(/^[^<>:"/\\|?*]+$/);
		expect(fileSafe(' ... ', 'Session 1')).toBe('Session 1');
		expect(fileSafe('x'.repeat(100), 'y')).toHaveLength(40);
	});

	it('list every file in order and mark provisional sessions and draft schedules', () => {
		const [morning, afternoon] = listSessions(eventId);
		expect(packetPlan(eventId, listSessions(eventId)).map((i) => i.name)).toEqual([
			'00 Read me.txt',
			'01 Awards sheet - all sessions (PROVISIONAL).pdf',
			'02 Morning - full results (PROVISIONAL).pdf',
			'03 Morning - completed scoresheets (PROVISIONAL).pdf',
			'04 Morning - schedule.pdf',
			'05 Afternoon - full results (PROVISIONAL).pdf',
			'06 Afternoon - completed scoresheets (PROVISIONAL).pdf',
			'07 Afternoon - schedule.pdf',
			'08 Excel workbook (PROVISIONAL).xlsx'
		]);

		finalize(morning.id);
		getDb().update(schema.sessions).set({ scheduleStatus: 'draft' }).where(eq(schema.sessions.id, afternoon.id)).run();
		const plan = packetPlan(eventId, listSessions(eventId));
		expect(plan.map((i) => i.name).slice(2, 8)).toEqual([
			'02 Morning - full results.pdf',
			'03 Morning - completed scoresheets.pdf',
			'04 Morning - schedule.pdf',
			'05 Afternoon - full results (PROVISIONAL).pdf',
			'06 Afternoon - completed scoresheets (PROVISIONAL).pdf',
			'07 Afternoon - schedule (DRAFT).pdf'
		]);

		finalize(afternoon.id);
		expect(packetPlan(eventId, listSessions(eventId)).map((i) => i.name)).toContain('01 Awards sheet - all sessions.pdf');
		expect(packetPlan(eventId, listSessions(eventId)).map((i) => i.name)).toContain('08 Excel workbook.xlsx');
	});

	it('only point at pages the PDF renderer allows, with the schedule in landscape', () => {
		for (const item of packetPlan(eventId, listSessions(eventId)).filter((i) => i.page)) {
			expect(printablePage(eventId, item.page!.path), item.name).toEqual({ path: item.page!.path, landscape: item.name.includes('schedule') });
			expect(item.page!.landscape).toBe(item.name.includes('schedule'));
		}
	});

	it('keep sessions with the same name apart', () => {
		const names = packetPlan(1, [
			{ id: 1, name: 'Morning', finalizedAt: null, scheduleStatus: 'published' },
			{ id: 2, name: 'morning', finalizedAt: null, scheduleStatus: 'published' },
			{ id: 3, name: '???', finalizedAt: null, scheduleStatus: 'published' }
		]).map((i) => i.name);
		expect(names).toContain('02 Morning - full results (PROVISIONAL).pdf');
		expect(names).toContain('05 morning (2) - full results (PROVISIONAL).pdf');
		expect(names).toContain('08 Session 3 - full results (PROVISIONAL).pdf');
	});
});

describe('packet Read me', () => {
	it('summarizes the event, sessions, files, rules, and open flags', () => {
		const live = computeLive(eventId);
		const items = packetPlan(eventId, listSessions(eventId));
		const text = packetReadme({
			live: {
				...live,
				flags: [
					{ level: 'info', kind: 'fractional_bonus', message: 'Morning R2 Room 1: bonus of 12.5' },
					{ level: 'info', kind: 'fractional_bonus', message: 'Morning R2 Room 1: bonus of 12.5' },
					{ level: 'error', kind: 'team_tie', message: 'Private: Alpha and Beta tied for 1st', tie: { kind: 'team', groupKey: 'd:Private', ids: ['1', '2'] } },
					{ level: 'warning', kind: 'not_submitted', message: 'Morning R1 Room 3: not submitted yet' },
					{ level: 'info', kind: 'individual_tie_resolved', message: 'Public 4A–7A: two players tied for 3rd — resolved: sudden-death question' }
				]
			},
			ruleVersion: 1,
			items,
			missing: [items[3].name],
			madeAt: new Date('2026-10-28T22:15:00Z'),
			madeBy: 'Jordan Reviewer'
		});
		expect(text.startsWith('\uFEFF')).toBe(true);
		expect(text).toContain('\r\n');
		const lines = text.split('\r\n');
		expect(lines).toContain('Event:        Practice Event 2026-10-28 (PRACTICE / TEST EVENT)');
		expect(lines).toContain('Event date:   Wednesday, October 28, 2026');
		expect(lines).toContain('Packet made:  October 28, 2026 at 5:15 PM Central, by Jordan Reviewer');
		expect(text).toContain('PROVISIONAL - 2 of 2 sessions not finalized');
		expect(text).toContain('- Morning: Wednesday, October 28, 2026, arrival 8:30 AM, 6 rounds. PROVISIONAL, not finalized.');
		expect(text).toContain('- Afternoon: Wednesday, October 28, 2026, arrival 12:15 PM, 6 rounds. PROVISIONAL, not finalized.');
		expect(text).toMatch(/0 of \d+ counting games approved or forfeited/);
		for (const i of items) expect(text).toContain(i.name);
		expect(lines.find((l) => l.startsWith(items[3].name))).toMatch(/\.pdf +MISSING - could not be made\. /);
		expect(text).toContain('WARNING: 1 file could not be made');
		expect(text).toContain('SCORING RULES (settings version 1)');
		expect(text).toContain('- Bonuses: team points only; individual scores count tossups only. Partial credit is proportional per part, kept exact (e.g. 12.5). Bouncebacks: no.');
		expect(text).toContain('toward total points in standings: no; toward individual totals: no.');
		expect(text).toContain('- Forfeits: a win for the opponent; no points for either team.');
		expect(text).toContain('- Award divisions: Private; Public 1A–3A (1A, 2A, 3A); Public 4A–7A (4A, 5A, 6A, 7A).');
		expect(text).toContain("- Awards: 1 team place per award division; 2 places in each classification, ordered by the division's final places; 3 individual places, grouped by award division.");
		expect(text).toContain('- Format: Private: round robin; Public 1A–3A: round robin; Public 4A–7A: round robin.\r\n');
		expect(text).toContain(`Settings confirmed before the event: 0 of ${CONFIRM_ITEMS.length}.`);
		// Open flags, most serious first; decided ties listed apart.
		const open = lines.slice(lines.indexOf('OPEN FLAGS AND TIES (3)') + 1, lines.indexOf('OPEN FLAGS AND TIES (3)') + 4);
		const team = (id: string) => live.teams.find((t) => t.id === id)!.name;
		expect(open).toEqual([
			`- [TIE - NEEDS A DECISION] Private: Alpha and Beta tied for 1st. Tied: ${team('1')}, ${team('2')}`,
			'- [CHECK] Morning R1 Room 3: not submitted yet',
			'- [NOTE] Morning R2 Room 1: bonus of 12.5'
		]);
		expect(lines).toContain('TIES DECIDED BY THE HEAD SCOREKEEPER (1)');
		expect(text).toContain('resolved: sudden-death question');
	});

	it('describes bracket formats and the seeding order', () => {
		const rules = structuredClone(HIGH_SCHOOL_DEFAULTS);
		rules.standings.order = ['winPct', 'totalPoints', 'headToHead'];
		rules.awards.classPlaces = 0;
		rules.format.divisions['Public 4A–7A'] = { ...DEFAULT_BRACKET_FORMAT, seedingRounds: 4, bracketSize: 8, thirdPlaceGame: false, seeding: 'poolWinnersFirst', bracketCountsForIndividuals: false };
		const lines = rulesSummary(rules, ['Private', '1A', '4A', '5A']);
		expect(lines).toContain('Standings: win/loss ratio, then total points (counting games), then head-to-head among tied teams. Non-counter games never count.');
		expect(lines.find((l) => l.startsWith('Awards:'))).toMatch(/^Awards: 1 team place per award division; 3 individual places/);
		expect(lines).toContain(
			'Format: Private: round robin; Public 1A–3A: round robin; Public 4A–7A: 4 pool-play rounds seed an 8-team bracket (pool winners seeded first; no 3rd-place game; bracket games count for individuals: no). Bracket seeding: win/loss ratio, then total points (counting games), then head-to-head among tied teams.'
		);
	});

	it('says when nothing is open and every session is final', () => {
		for (const s of listSessions(eventId)) finalize(s.id);
		const live = computeLive(eventId);
		const text = packetReadme({ live: { ...live, flags: [] }, ruleVersion: 1, items: packetPlan(eventId, listSessions(eventId)), missing: [], madeAt: new Date(), madeBy: 'x' });
		expect(text).toContain('FINAL - every session is finalized.');
		expect(text).toContain('FINAL, finalized by Head Scorekeeper on Oct 28, 2026, 12:05 PM');
		expect(text).toContain('OPEN FLAGS AND TIES (0)\r\nNone.');
		expect(text).not.toContain('WARNING');
		expect(text).not.toContain('MISSING');
	});
});

describe('buildReviewPacket', () => {
	it('renders each page one at a time and zips them with the workbook and Read me', async () => {
		const [morning, afternoon] = listSessions(eventId);
		await playSession(morning.id);
		finalize(morning.id);

		const calls: { path: string; landscape: boolean }[] = [];
		let active = 0;
		let most = 0;
		const render = async (path: string, landscape: boolean) => {
			most = Math.max(most, ++active);
			calls.push({ path, landscape });
			await new Promise((r) => setTimeout(r, 2));
			active--;
			if (path.includes('scoresheets') && path.endsWith(`session=${afternoon.id}`)) throw new Error('Report page returned 500');
			return new TextEncoder().encode(`%PDF-1.7 fake ${path}`);
		};
		const packet = await buildReviewPacket(eventId, { render, madeBy: 'Head Scorekeeper', now: new Date('2026-10-28T22:15:00Z') });

		expect(most).toBe(1);
		const plan = packetPlan(eventId, listSessions(eventId));
		expect(calls).toEqual(plan.filter((i) => i.page).map((i) => i.page));
		expect(packet.missing).toEqual(['06 Afternoon - completed scoresheets (PROVISIONAL).pdf']);
		expect(packet.files).toEqual(plan.map((i) => i.name).filter((n) => !packet.missing.includes(n)));

		const zip = await JSZip.loadAsync(packet.bytes);
		expect(Object.keys(zip.files)).toEqual(packet.files);
		expect(await zip.file('02 Morning - full results.pdf')!.async('string')).toBe(`%PDF-1.7 fake /events/${eventId}/reports/results?session=${morning.id}`);
		// Entry dates are Central clock time (5:15 PM), not UTC.
		expect(zip.file('00 Read me.txt')!.date.getUTCHours()).toBe(17);

		const readme = await zip.file('00 Read me.txt')!.async('string');
		expect(readme).toContain('- Morning: Wednesday, October 28, 2026, arrival 8:30 AM, 6 rounds. FINAL, finalized by Head Scorekeeper');
		expect(readme).toMatch(/ (\d+) of \1 counting games approved or forfeited/);
		expect(readme).toContain('06 Afternoon - completed scoresheets (PROVISIONAL).pdf  MISSING');

		const wb = new ExcelJS.Workbook();
		await wb.xlsx.load(Buffer.from(await zip.file('08 Excel workbook (PROVISIONAL).xlsx')!.async('uint8array')) as never);
		expect(wb.getWorksheet('Summary')?.getCell('A1').value).toBe('Event');
		expect(wb.getWorksheet('Games')!.rowCount).toBeGreaterThan(1);
	}, 60_000);

	it('builds one packet at a time', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const first = buildReviewPacket(eventId, { render: async () => (await gate, new Uint8Array([37, 80, 68, 70])), madeBy: 'a' });
		await expect(buildReviewPacket(eventId, { render: async () => new Uint8Array(), madeBy: 'b' })).rejects.toMatchObject({ status: 429 });
		release();
		await first;
		await expect(buildReviewPacket(eventId, { render: async () => new Uint8Array([37]), madeBy: 'c' })).resolves.toHaveProperty('missing', []);
	});
});
