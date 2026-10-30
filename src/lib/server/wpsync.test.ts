import { HIGH_SCHOOL_DEFAULTS } from '$lib/engine';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, schema, useMemoryDb } from './db';
import { createEvent, currentRuleVersion, listSessions } from './events';
import { computeLive } from './live';
import { teamRoster } from './teams';
import { saveWpSettings, type WpEvent } from './wordpress';
import { settingsFromWebsite, syncFromWebsite, verifyPing } from './wpsync';

const WP_EVENT: WpEvent = {
	id: 12,
	name: "SUSCC High School Scholars' Bowl 2027",
	slug: 'hs-2027',
	date: '2099-10-27',
	status: 'active',
	morning_classifications: ['Private', '1A', '2A', '3A'],
	afternoon_classifications: ['4A', '5A', '6A', '7A'],
	sessions: [
		{ key: 'morning', label: 'Morning', start_time: '08:30', classifications: ['Private', '1A', '2A', '3A'] },
		{ key: 'afternoon', label: 'Afternoon', start_time: '12:15', classifications: ['4A', '5A', '6A', '7A'] }
	],
	divisions: [
		{ key: 'private', name: 'Private', session: 'morning', classifications: ['Private'], format: 'bracket', seeding_rounds: 3, bracket_size: 4, third_place_game: true },
		{ key: 'small', name: 'Public 1A–3A', session: 'morning', classifications: ['1A', '2A', '3A'], format: 'bracket', seeding_rounds: 3, bracket_size: 4, third_place_game: true },
		{ key: 'large', name: 'Public 4A–7A', session: 'afternoon', classifications: ['4A', '5A', '6A', '7A'], format: 'round_robin', seeding_rounds: 3, bracket_size: 4, third_place_game: true }
	],
	awards: { class_places: 2, division_places: 1, individual_places: 3 }
};

let regs: Record<string, unknown>[] = [];
const fakeFetch = vi.fn(async (url: string) => {
	const path = new URL(url).pathname + new URL(url).search;
	const body = path.includes('/events') ? { events: [WP_EVENT] } : { registrations: regs };
	return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
});

const reg = (id: number, school: string, cls: string, students: [number, string, string, string][], status = 'confirmed') => ({
	id, school_name: school, contact_name: 'Coach', contact_email: 'coach@example.test', contact_phone: null, competing_students: 4, coaches: 1,
	classification: cls, session_time: cls === 'Private' || cls < '4' ? 'morning' : 'afternoon', registration_status: status, is_test: false,
	registration_date: '2099-09-01 10:00:00', students: students.map(([sid, first, last, grade], i) => ({ id: sid, first_name: first, last_name: last, grade, sort_order: i + 1 })), roster_complete: students.length >= 4
});

describe('website sync', () => {
	beforeEach(() => {
		process.env.DISABLE_BACKUPS = '1';
		useMemoryDb();
		vi.stubGlobal('fetch', fakeFetch);
		saveWpSettings({ url: 'https://wp.example.test', token: 'tok-123', enabled: true, autoSync: true });
		regs = [];
	});
	afterEach(() => vi.unstubAllGlobals());

	it('maps website divisions, formats and award places onto scoring settings', () => {
		const r = settingsFromWebsite(HIGH_SCHOOL_DEFAULTS, WP_EVENT);
		expect(r.awards.divisions['2A']).toBe('Public 1A–3A');
		expect(r.format.divisions['Private']).toMatchObject({ type: 'bracket', seedingRounds: 3, bracketSize: 4 });
		expect(r.format.divisions['Public 4A–7A']).toBeUndefined();
		expect(r.awards.classPlaces).toBe(2);
	});

	it('creates the event from the last real event layout, then teams and rosters; re-syncs without duplicates', async () => {
		// Last year's event supplies rooms and round counts.
		const prev = createEvent(
			{ name: '2026', eventDate: '2026-10-28', isTest: false, classifications: ['Private', '1A', '2A', '3A', '4A', '5A', '6A', '7A'], sessions: [{ name: 'Morning', date: '2026-10-28', startTime: '08:30', classifications: ['Private'], roundCount: 5, roundTimes: ['08:40'] }], roomNames: ['Ren 214', 'Ren 116'], settings: structuredClone(HIGH_SCHOOL_DEFAULTS), settingsSource: 'test' },
			'test'
		);
		regs = [reg(501, 'Faith Christian', 'Private', [[1, 'Levi', 'Wells', '12'], [2, 'Ann', 'Lee', '11']]), reg(502, 'Woodland High', '1A', [])];
		const r1 = await syncFromWebsite();
		expect(r1.ok).toBe(true);
		expect(r1.eventsCreated).toHaveLength(1);
		const ev = getDb().select().from(schema.events).all().find((e) => e.wpEventId === 12)!;
		expect(ev.id).not.toBe(prev);
		expect(getDb().select().from(schema.rooms).all().filter((r) => r.eventId === ev.id).map((r) => r.name)).toEqual(['Ren 214', 'Ren 116']);
		expect(listSessions(ev.id).map((s) => [s.name, s.startTime, s.roundCount])).toEqual([['Morning', '08:30', 5], ['Afternoon', '12:15', 5]]);
		expect(currentRuleVersion(ev.id).settings.format.divisions['Public 1A–3A']?.type).toBe('bracket');
		const teams = getDb().select().from(schema.teams).all().filter((t) => t.eventId === ev.id);
		expect(teams.map((t) => t.name).sort()).toEqual(['Faith Christian', 'Woodland High']);
		const faith = teams.find((t) => t.name === 'Faith Christian')!;
		expect(teamRoster(faith.id).map((p) => `${p.firstName} ${p.lastName}`)).toEqual(['Levi Wells', 'Ann Lee']);

		// The coach fixes a spelling, adds two students and drops one; a third school cancels.
		regs = [reg(501, 'Faith Christian', 'Private', [[1, 'Levi', 'Wells', '12'], [3, 'Will', 'Sedenik', '11'], [4, 'Cris', 'Jackson', '11']]), reg(502, 'Woodland High', '1A', [], 'cancelled')];
		const r2 = await syncFromWebsite();
		expect(r2.eventsCreated).toEqual([]);
		expect(teamRoster(faith.id).map((p) => `${p.firstName} ${p.lastName}`)).toEqual(['Levi Wells', 'Will Sedenik', 'Cris Jackson']);
		expect(r2.players).toEqual({ added: 2, updated: 0, removed: 1 });
		expect(getDb().select().from(schema.teams).all().find((t) => t.registrationId === 502)!.withdrawn).toBe(true);

		// Once check-in confirms a roster, the website no longer changes it.
		getDb().update(schema.teams).set({ rosterConfirmedAt: new Date().toISOString() }).run();
		regs = [reg(501, 'Faith Christian', 'Private', [[1, 'Levi', 'Wells', '12']])];
		await syncFromWebsite();
		expect(teamRoster(faith.id)).toHaveLength(3);
		expect(computeLive(ev.id).teams).toHaveLength(2);
	});

	it('accepts only correctly signed, fresh, unreplayed pings', () => {
		const s = { url: 'https://wp.example.test', token: 'tok-123', enabled: true, autoSync: true };
		const body = JSON.stringify({ type: 'roster.saved', event_id: 12 });
		const ts = String(Math.floor(Date.now() / 1000));
		const key = crypto.createHash('sha256').update('tok-123').digest('hex');
		const sig = 'sha256=' + crypto.createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');
		expect(verifyPing(s, body, ts, sig).ok).toBe(true);
		expect(verifyPing(s, body, ts, sig)).toEqual({ ok: false, reason: 'replayed' });
		expect(verifyPing(s, body + ' ', ts, sig).ok).toBe(false);
		const old = String(Number(ts) - 600);
		expect(verifyPing(s, body, old, 'sha256=' + crypto.createHmac('sha256', key).update(`${old}.${body}`).digest('hex'))).toEqual({ ok: false, reason: 'stale' });
		expect(verifyPing({ ...s, autoSync: false }, body, ts, sig).ok).toBe(false);
	});
});
