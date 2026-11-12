import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

export const BASE = 'http://localhost:4173';
export const ADMIN_STATE = 'e2e/.auth/admin.json';
/** Test-only credentials for the throwaway e2e database. */
export const ADMIN = { name: 'E2E Admin', email: 'e2e-admin@example.test', password: 'e2e-password-123' };

const dbFile = path.resolve('.e2e-data/scoring.db');

/** Read-only view of the test server's database, for checking what was stored. */
export function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
	const db = new Database(dbFile, { readonly: true, fileMustExist: true });
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

/** POST a SvelteKit form action the way a browser form would (with Origin for CSRF). */
export async function postAction(request: APIRequestContext, url: string, form: Record<string, string>) {
	return request.post(url, { form, headers: { Origin: BASE, Accept: 'text/html' }, maxRedirects: 0 });
}

export async function createPracticeEvent(request: APIRequestContext): Promise<number> {
	const res = await postAction(request, '/events/new?/practice', {});
	if (res.status() !== 303) throw new Error(`Practice event not created: ${res.status()} ${(await res.text()).replace(/\s+/g, ' ').slice(0, 400)}`);
	const id = Number(/\/events\/(\d+)/.exec(res.headers()['location'] ?? '')?.[1]);
	expect(id).toBeGreaterThan(0);
	return id;
}

export interface MatchRow {
	id: number;
	round_no: number;
	session_id: number;
	room_id: number;
	team_a_id: number;
	team_b_id: number;
	counts: number;
}

/** The first room (by order) in the event that has a game in round 1 of its first session, and that game. */
export function firstRoomGame(eventId: number) {
	const [session] = q<{ id: number }>('SELECT id FROM sessions WHERE event_id = ? ORDER BY sort_order LIMIT 1', eventId);
	const [m] = q<MatchRow & { pin: string; room_name: string }>(
		`SELECT m.*, r.pin, r.name AS room_name FROM matches m JOIN rooms r ON r.id = m.room_id
		 WHERE m.session_id = ? AND m.round_no = 1 ORDER BY r.sort_order LIMIT 1`,
		session.id
	);
	const teams = q<{ id: number; name: string }>('SELECT id, name FROM teams WHERE id IN (?, ?)', m.team_a_id, m.team_b_id);
	const name = (id: number) => teams.find((t) => t.id === id)!.name;
	return { match: m, pin: m.pin, roomName: m.room_name, teamA: name(m.team_a_id), teamB: name(m.team_b_id) };
}

export function roster(teamId: number) {
	return q<{ id: string; name: string }>(
		`SELECT p.id, COALESCE(p.preferred_name, p.first_name) || ' ' || p.last_name AS name
		 FROM roster_entries r JOIN players p ON p.id = r.player_id WHERE r.team_id = ? AND r.removed = 0 ORDER BY r.sort_order`,
		teamId
	);
}

export function storedEvents(matchId: number) {
	return q<{ id: string; seq: number; type: string; body: string; device_seq: number | null; source: string; actor: string }>(
		'SELECT id, seq, type, body, device_seq, source, actor FROM score_events WHERE match_id = ? ORDER BY seq',
		matchId
	);
}

export async function adminContext(browser: Browser) {
	return browser.newContext({ storageState: ADMIN_STATE });
}

/** Sign a fresh browser context in to a room with its PIN and wait for the scorer. */
export async function roomLogin(page: Page, pin: string, mode: 'screen' | 'sheet' = 'screen') {
	await page.goto('/room');
	await page.getByLabel('Room PIN').fill(pin);
	await page.getByRole('button', { name: mode === 'sheet' ? /with the spreadsheet/ : /with the new screen/ }).click();
	await page.waitForURL(mode === 'sheet' ? '**/sheet' : '**/scorer');
}

export const score = (page: Page, team: string) => page.getByLabel(`${team} score`);

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error('Timed out waiting for condition');
		await new Promise((r) => setTimeout(r, 200));
	}
}
