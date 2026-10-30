/**
 * Automatic sync with the registration website (plugin 1.1.0+): an event created on the website
 * becomes a scoring event, and its registrations become teams with their rosters. Runs every
 * 10 minutes when turned on, and right away when the website pings /api/wordpress/notify.
 *
 * Safety rules: nothing is ever deleted; a team that has played keeps its games; rosters that
 * check-in staff have confirmed are not overwritten; settings that change after scoring starts are
 * reported, not applied. Every change is in the audit log.
 */
import { DEFAULT_BRACKET_FORMAT, HIGH_SCHOOL_DEFAULTS, normalizeRules, type BracketSize, type DivisionFormat, type RuleSettings } from '$lib/engine';
import { and, desc, eq, inArray } from 'drizzle-orm';
import crypto from 'node:crypto';
import { audit } from './audit';
import { backupNow } from './backup';
import { publish } from './bus';
import { getDb, schema } from './db';
import { applyImportRows } from './import-apply';
import { createEvent, currentRuleVersion, defaultSessions, DEFAULT_CLASSIFICATIONS, listSessions, normalizeClassification, saveRules, sortClassifications } from './events';
import { buildPreview } from './registrations';
import { cleanName } from './registrations';
import { getWpSettings, wpEvents, wpRegistrations, WpError, type WpEvent, type WpRegistration, type WpSettings } from './wordpress';

export interface SyncReport {
	at: string;
	ok: boolean;
	error?: string;
	eventsCreated: string[];
	eventsUpdated: string[];
	teams: { created: number; updated: number; withdrawn: number };
	players: { added: number; updated: number; removed: number };
	notes: string[];
}

const STATUS_KEY = 'wordpress_sync_status';
const ACTOR = 'system:website-sync';

export function lastSyncReport(): SyncReport | null {
	const row = getDb().select().from(schema.appSettings).where(eq(schema.appSettings.key, STATUS_KEY)).get();
	return (row?.value as SyncReport | undefined) ?? null;
}
function saveReport(r: SyncReport) {
	getDb().insert(schema.appSettings).values({ key: STATUS_KEY, value: r }).onConflictDoUpdate({ target: schema.appSettings.key, set: { value: r } }).run();
}

/** The scoring event linked to a website event (never a practice event). */
const linkedEvent = (wpId: number) =>
	getDb()
		.select()
		.from(schema.events)
		.where(and(eq(schema.events.wpEventId, wpId), eq(schema.events.isTest, false)))
		.get();

/** Most recent real event: its rooms, round times, staff and scoring settings are the starting point. */
function templateEvent(excludeId?: number) {
	return getDb()
		.select()
		.from(schema.events)
		.where(eq(schema.events.isTest, false))
		.orderBy(desc(schema.events.eventDate), desc(schema.events.id))
		.all()
		.find((e) => e.id !== excludeId);
}

/** Website divisions and awards applied on top of a base set of settings. */
export function settingsFromWebsite(base: RuleSettings, ev: WpEvent): RuleSettings {
	const r = normalizeRules(structuredClone(base));
	if (ev.divisions?.length) {
		const divisions: Record<string, string> = {};
		const formats: Record<string, DivisionFormat> = {};
		for (const d of ev.divisions) {
			const name = cleanName(d.name || d.key).slice(0, 60);
			for (const c of d.classifications ?? []) divisions[normalizeClassification(c)] = name;
			if (d.format === 'bracket') {
				const prev = base.format?.divisions?.[name];
				formats[name] = {
					...DEFAULT_BRACKET_FORMAT,
					...(prev ?? {}),
					type: 'bracket',
					seedingRounds: Math.max(1, Math.min(20, Math.trunc(Number(d.seeding_rounds) || 3))),
					bracketSize: ([2, 4, 8].includes(Number(d.bracket_size)) ? Number(d.bracket_size) : 4) as BracketSize,
					thirdPlaceGame: d.third_place_game !== false
				};
			}
		}
		r.awards.divisions = divisions;
		r.format = { ...r.format, divisions: formats };
	}
	const a = ev.awards;
	const n = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : null);
	if (a) {
		r.awards.classPlaces = n(a.class_places, 0, 10) ?? r.awards.classPlaces;
		r.awards.teamPlaces = n(a.division_places, 1, 10) ?? r.awards.teamPlaces;
		r.awards.individualPlaces = n(a.individual_places, 0, 20) ?? r.awards.individualPlaces;
		r.awards.individualGrouping = 'division';
	}
	return normalizeRules(r);
}

/** Sessions from the website (1.1.0 sends them; older versions send morning/afternoon lists). */
function sessionsFromWebsite(ev: WpEvent, date: string, template?: { name: string; roundCount: number; roundTimes: string[] }[]) {
	const list =
		ev.sessions?.length
			? ev.sessions
			: [
					{ key: 'morning', label: 'Morning', start_time: ev.morning_session_time ?? '08:30', classifications: ev.morning_classifications },
					{ key: 'afternoon', label: 'Afternoon', start_time: ev.afternoon_session_time ?? '12:15', classifications: ev.afternoon_classifications }
				];
	return list
		.filter((s) => s.classifications?.length)
		.map((s) => {
			const name = cleanName(s.label || s.key).slice(0, 40) || 'Session';
			const t = template?.find((x) => x.name.toLowerCase() === name.toLowerCase());
			return {
				name,
				date,
				startTime: /^\d{1,2}:\d{2}/.test(s.start_time ?? '') ? (s.start_time as string).slice(0, 5).padStart(5, '0') : name.toLowerCase().startsWith('after') ? '12:15' : '08:30',
				classifications: sortClassifications(s.classifications.map((c) => normalizeClassification(c))),
				roundCount: t?.roundCount ?? 5,
				roundTimes: t?.roundTimes ?? []
			};
		});
}

function hasScoring(eventId: number): boolean {
	return !!getDb()
		.select({ id: schema.scoreEvents.id })
		.from(schema.scoreEvents)
		.innerJoin(schema.matches, eq(schema.scoreEvents.matchId, schema.matches.id))
		.innerJoin(schema.sessions, eq(schema.matches.sessionId, schema.sessions.id))
		.where(eq(schema.sessions.eventId, eventId))
		.limit(1)
		.get();
}

/** Create the scoring event for a website event, from the most recent real event's layout. */
export function createFromWebsite(ev: WpEvent): number {
	const db = getDb();
	const tpl = templateEvent();
	const base = tpl ? currentRuleVersion(tpl.id).settings : structuredClone(HIGH_SCHOOL_DEFAULTS);
	const tplSessions = tpl ? listSessions(tpl.id) : [];
	const tplRooms = tpl ? db.select().from(schema.rooms).where(and(eq(schema.rooms.eventId, tpl.id), eq(schema.rooms.active, true))).all() : [];
	const date = (ev.date ?? '').slice(0, 10);
	const sessions = sessionsFromWebsite(ev, date, tplSessions);
	const classifications = sortClassifications([...new Set([...sessions.flatMap((s) => s.classifications), ...(ev.divisions ?? []).flatMap((d) => d.classifications.map((c) => normalizeClassification(c)))])]);
	const id = createEvent(
		{
			name: cleanName(ev.name).slice(0, 120) || `Scholars' Bowl ${date}`,
			eventDate: date,
			isTest: false,
			classifications: classifications.length ? classifications : DEFAULT_CLASSIFICATIONS,
			sessions: sessions.length ? sessions : defaultSessions(date),
			roomNames: tplRooms.length ? tplRooms.sort((a, b) => a.sortOrder - b.sortOrder).map((r) => r.name) : ['Room 1', 'Room 2', 'Room 3', 'Room 4'],
			practiceRoomNames: tplRooms.filter((r) => r.practice).map((r) => r.name),
			settings: settingsFromWebsite(base, ev),
			settingsSource: `the registration website${tpl ? ` (layout from ${tpl.name})` : ''}`
		},
		'Website sync'
	);
	db.update(schema.events).set({ wpEventId: ev.id, wpSyncedAt: new Date().toISOString() }).where(eq(schema.events.id, id)).run();
	// The same staff as last time (they can be changed on the Staff page).
	if (tpl) for (const s of db.select().from(schema.eventStaff).where(eq(schema.eventStaff.eventId, tpl.id)).all()) db.insert(schema.eventStaff).values({ eventId: id, name: s.name, email: s.email, role: s.role }).onConflictDoNothing().run();
	audit(ACTOR, 'event_created_from_website', { wpEventId: ev.id, name: ev.name, date, template: tpl?.id ?? null }, id);
	return id;
}

/** Keep an existing event in step with the website (only while nothing has been scored). */
function updateFromWebsite(eventId: number, ev: WpEvent, report: SyncReport) {
	const db = getDb();
	const event = db.select().from(schema.events).where(eq(schema.events.id, eventId)).get()!;
	if (event.status === 'finalized' || event.status === 'archived') return;
	const cur = currentRuleVersion(eventId).settings;
	const want = settingsFromWebsite(cur, ev);
	const started = hasScoring(eventId);
	const changed = JSON.stringify(want) !== JSON.stringify(cur);
	if (changed && !started) {
		saveRules(eventId, want, 'Website sync', 'Divisions, formats or award places changed on the registration website');
		report.eventsUpdated.push(`${event.name}: settings updated from the website`);
	} else if (changed) {
		report.notes.push(`${event.name}: the website's divisions/format/awards changed after scoring started. Not applied — review Scoring settings.`);
		audit(ACTOR, 'website_settings_not_applied', { wpEventId: ev.id }, eventId);
	}
	const date = (ev.date ?? '').slice(0, 10);
	const patch: Partial<typeof schema.events.$inferInsert> = { wpSyncedAt: new Date().toISOString() };
	if (!started) {
		if (ev.name && cleanName(ev.name) !== event.name) patch.name = cleanName(ev.name).slice(0, 120);
		if (date && date !== event.eventDate) patch.eventDate = date;
		// Session classifications and start times follow the website until games are scheduled.
		const sessions = listSessions(eventId);
		for (const s of sessionsFromWebsite(ev, date || event.eventDate)) {
			const row = sessions.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
			if (!row) continue;
			const hasGames = db.select({ id: schema.matches.id }).from(schema.matches).where(eq(schema.matches.sessionId, row.id)).limit(1).get();
			if (hasGames) continue;
			if (JSON.stringify(row.classifications) !== JSON.stringify(s.classifications) || row.startTime !== s.startTime || row.date !== s.date)
				db.update(schema.sessions).set({ classifications: s.classifications, startTime: s.startTime, date: s.date }).where(eq(schema.sessions.id, row.id)).run();
		}
		const cls = sortClassifications([...new Set([...event.classifications, ...listSessions(eventId).flatMap((s) => s.classifications)])]);
		if (JSON.stringify(cls) !== JSON.stringify(event.classifications)) patch.classifications = cls;
	}
	db.update(schema.events).set(patch).where(eq(schema.events.id, eventId)).run();
	if (patch.name || patch.eventDate) report.eventsUpdated.push(`${patch.name ?? event.name}: name/date updated`);
}

/** Teams from registrations (auto-applied: new, updated, cancelled-before-play), then rosters. */
async function syncTeams(eventId: number, regs: WpRegistration[], rows: ReturnType<typeof import('./wordpress').toRegistrationRows>, isTest: boolean, report: SyncReport, backup: () => Promise<void>) {
	const db = getDb();
	const sessions = listSessions(eventId).map((s) => ({ id: s.id, name: s.name, classifications: s.classifications }));
	const existing = db.select().from(schema.teams).where(eq(schema.teams.eventId, eventId)).all();
	const preview = buildPreview(rows.filter((r) => isTest || !r.isTest), existing, sessions, null);
	const played = new Set(
		db
			.select({ a: schema.matches.teamAId, b: schema.matches.teamBId })
			.from(schema.scoreEvents)
			.innerJoin(schema.matches, eq(schema.scoreEvents.matchId, schema.matches.id))
			.all()
			.flatMap((m) => [m.a, m.b])
	);
	const apply = preview.filter((p) => {
		if (p.action === 'new') return p.include && !!p.classification && p.sessionId !== null;
		if (p.action === 'update') return p.include;
		if (p.action === 'withdraw') {
			if (p.existingTeamId && played.has(p.existingTeamId)) {
				report.notes.push(`${p.schoolName} cancelled on the website after playing; left in place (record forfeits if needed).`);
				return false;
			}
			return true;
		}
		return false;
	});
	for (const p of preview)
		if (p.action === 'new' && !apply.includes(p) && p.status !== 'cancelled')
			report.notes.push(`${p.schoolName}: not added automatically (${p.notes.join('; ') || 'needs a classification or session'}). Use Teams → Import to review.`);
	if (apply.length) {
		await backup();
		const res = db.transaction((tx) =>
			applyImportRows(
				tx,
				eventId,
				apply.map((p) => ({ ...p, action: p.action as 'new' | 'update' | 'withdraw' })),
				'api'
			)
		);
		report.teams.created += res.created;
		report.teams.updated += res.updated;
		report.teams.withdrawn += res.withdrawn;
		audit(ACTOR, 'registrations_synced', res, eventId);
	}
	syncRosters(eventId, regs, report);
}

const nameKey = (first: string, last: string) => `${first} ${last}`.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rosters from the website. A roster check-in staff have confirmed is left alone (they are the
 * last word on the day). Returning students keep their player record from earlier years.
 */
export function syncRosters(eventId: number, regs: WpRegistration[], report: SyncReport) {
	const db = getDb();
	for (const reg of regs) {
		if (!Array.isArray(reg.students)) continue;
		const team = db.select().from(schema.teams).where(and(eq(schema.teams.eventId, eventId), eq(schema.teams.registrationId, reg.id))).get();
		if (!team || team.rosterConfirmedAt) continue;
		const students = reg.students
			.map((s) => ({ ...s, first: cleanName(s.first_name ?? '').slice(0, 60), last: cleanName(s.last_name ?? '').slice(0, 60), grade: /^\d{1,2}$/.test(String(s.grade ?? '').trim()) ? String(s.grade).trim() : null }))
			.filter((s) => s.first || s.last)
			.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
		db.transaction((tx) => {
			const roster = tx
				.select({ entry: schema.rosterEntries, player: schema.players })
				.from(schema.rosterEntries)
				.innerJoin(schema.players, eq(schema.rosterEntries.playerId, schema.players.id))
				.where(eq(schema.rosterEntries.teamId, team.id))
				.all();
			const seen = new Set<string>();
			students.forEach((s, i) => {
				const hit = roster.find((r) => r.player.wpStudentId === s.id) ?? roster.find((r) => !r.player.wpStudentId && nameKey(r.player.firstName, r.player.lastName) === nameKey(s.first, s.last));
				if (hit) {
					seen.add(hit.player.id);
					const p = hit.player;
					if (p.firstName !== s.first || p.lastName !== s.last || (s.grade && p.grade !== s.grade) || p.wpStudentId !== s.id) {
						tx.update(schema.players).set({ firstName: s.first, lastName: s.last, grade: s.grade ?? p.grade, wpStudentId: s.id }).where(eq(schema.players.id, p.id)).run();
						report.players.updated++;
					}
					if (hit.entry.removed || hit.entry.sortOrder !== i) tx.update(schema.rosterEntries).set({ removed: false, sortOrder: i }).where(eq(schema.rosterEntries.id, hit.entry.id)).run();
					return;
				}
				// A returning student keeps the same player record (same school, same name).
				const prior = tx.select().from(schema.players).where(eq(schema.players.schoolId, team.schoolId)).all().find((p) => nameKey(p.firstName, p.lastName) === nameKey(s.first, s.last));
				const id = prior?.id ?? crypto.randomUUID();
				if (!prior) tx.insert(schema.players).values({ id, schoolId: team.schoolId, firstName: s.first, lastName: s.last, grade: s.grade, wpStudentId: s.id }).run();
				else tx.update(schema.players).set({ grade: s.grade ?? prior.grade, wpStudentId: s.id }).where(eq(schema.players.id, id)).run();
				tx.insert(schema.rosterEntries).values({ teamId: team.id, playerId: id, sortOrder: i }).onConflictDoUpdate({ target: [schema.rosterEntries.teamId, schema.rosterEntries.playerId], set: { removed: false, sortOrder: i } }).run();
				seen.add(id);
				report.players.added++;
			});
			// Students the coach removed on the website (only those that came from the website and haven't played).
			const playedIds = new Set(
				tx
					.select({ body: schema.scoreEvents.body })
					.from(schema.scoreEvents)
					.innerJoin(schema.matches, eq(schema.scoreEvents.matchId, schema.matches.id))
					.where(inArray(schema.scoreEvents.type, ['round_started', 'lineup_set']))
					.all()
					.flatMap((e) => JSON.stringify(e.body).match(/[0-9a-f-]{36}/g) ?? [])
			);
			for (const r of roster)
				if (!seen.has(r.player.id) && r.player.wpStudentId && !r.entry.removed && !playedIds.has(r.player.id)) {
					tx.update(schema.rosterEntries).set({ removed: true }).where(eq(schema.rosterEntries.id, r.entry.id)).run();
					report.players.removed++;
				}
		});
	}
}

let running: Promise<SyncReport> | null = null;

/** Sync everything (or one website event). Safe to call often; runs one at a time. */
export function syncFromWebsite(opts: { wpEventId?: number; reason?: string } = {}): Promise<SyncReport> {
	if (running) return running.then(() => syncFromWebsite(opts));
	running = doSync(opts).finally(() => (running = null));
	return running;
}

async function doSync(opts: { wpEventId?: number; reason?: string }): Promise<SyncReport> {
	const report: SyncReport = { at: new Date().toISOString(), ok: true, eventsCreated: [], eventsUpdated: [], teams: { created: 0, updated: 0, withdrawn: 0 }, players: { added: 0, updated: 0, removed: 0 }, notes: [] };
	const s = getWpSettings();
	if (!s?.enabled || !s.token || !s.autoSync) return { ...report, ok: false, error: 'Automatic sync is off.' };
	try {
		const events = await wpEvents(s);
		// Only events from today on become new scoring events (past events are never created after the fact).
		const today = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
		const wanted = events.filter((e) => (opts.wpEventId ? e.id === opts.wpEventId : true) && e.date && /^\d{4}-\d{2}-\d{2}/.test(e.date));
		let backedUp = false;
		for (const ev of wanted) {
			const status = (ev.status ?? '').toLowerCase();
			const inactive = ['cancelled', 'canceled', 'deleted', 'archived', 'draft'].includes(status);
			let linked = linkedEvent(ev.id);
			if (!linked) {
				// Only upcoming, active website events become scoring events automatically.
				if (inactive || ev.date!.slice(0, 10) < today) continue;
				const id = createFromWebsite(ev);
				report.eventsCreated.push(`${ev.name} (${ev.date!.slice(0, 10)})`);
				linked = getDb().select().from(schema.events).where(eq(schema.events.id, id)).get()!;
			} else {
				if (linked.status === 'finalized' || linked.status === 'archived') continue;
				updateFromWebsite(linked.id, ev, report);
			}
			const regs = await wpRegistrations(s, ev.id, linked.classifications);
			await syncTeams(linked.id, regs.raw as WpRegistration[], regs.rows, linked.isTest, report, async () => {
				if (!backedUp) await backupNow('pre-import').catch(() => {});
				backedUp = true;
			});
			publish({ type: 'teams', eventId: linked.id });
		}
	} catch (e) {
		report.ok = false;
		report.error = e instanceof WpError ? e.message : e instanceof Error ? e.message : 'Sync failed';
		console.error('[wpsync]', e);
	}
	saveReport(report);
	if (report.eventsCreated.length || report.teams.created || report.teams.updated || report.teams.withdrawn || report.players.added || report.players.updated || report.players.removed)
		audit(ACTOR, 'website_sync', { reason: opts.reason ?? 'scheduled', ...report });
	return report;
}

let timer: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

/** Every 10 minutes while automatic sync is on (checked each time, so turning it off takes effect at once). */
export function startWebsiteSync() {
	if (timer || process.env.DISABLE_WEBSITE_SYNC === '1') return;
	timer = setInterval(() => {
		if (getWpSettings()?.autoSync) syncFromWebsite({ reason: 'scheduled' }).catch(() => {});
	}, 10 * 60_000);
	timer.unref?.();
}

/** Called by the website's signed ping: sync soon, coalescing bursts. */
export function requestSync(wpEventId: number | undefined, reason: string) {
	if (debounce) clearTimeout(debounce);
	debounce = setTimeout(() => {
		debounce = null;
		syncFromWebsite({ wpEventId, reason }).catch(() => {});
	}, 2000);
}

/** Verify a website ping: HMAC-SHA256 over "timestamp.body", keyed with sha256(api token), within 5 minutes, never replayed. */
const seenSignatures = new Map<string, number>();
export function verifyPing(s: WpSettings | null, body: string, timestamp: string | null, signature: string | null, now = Date.now()): { ok: boolean; reason?: string } {
	if (!s?.enabled || !s.token || !s.autoSync) return { ok: false, reason: 'sync off' };
	if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: 'bad timestamp' };
	if (Math.abs(now / 1000 - Number(timestamp)) > 300) return { ok: false, reason: 'stale' };
	const m = /^sha256=([0-9a-f]{64})$/.exec(signature ?? '');
	if (!m) return { ok: false, reason: 'bad signature format' };
	const key = crypto.createHash('sha256').update(s.token).digest('hex');
	const expected = crypto.createHmac('sha256', key).update(`${timestamp}.${body}`).digest();
	const given = Buffer.from(m[1], 'hex');
	if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'signature mismatch' };
	for (const [k, t] of seenSignatures) if (now - t > 600_000) seenSignatures.delete(k);
	if (seenSignatures.has(m[1])) return { ok: false, reason: 'replayed' };
	seenSignatures.set(m[1], now);
	return { ok: true };
}
