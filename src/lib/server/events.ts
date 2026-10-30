import { normalizeRules, type ConfirmKey, type RuleSettings } from '$lib/engine';
import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getDb, schema } from './db';

export const DEFAULT_CLASSIFICATIONS = ['Private', '1A', '2A', '3A', '4A', '5A', '6A', '7A'];

export function sortClassifications(list: string[], order: string[] = DEFAULT_CLASSIFICATIONS): string[] {
	const idx = (c: string) => {
		const i = order.indexOf(c);
		return i === -1 ? order.length : i;
	};
	return [...list].sort((a, b) => idx(a) - idx(b) || a.localeCompare(b));
}

/** "1a" → "1A", "private" → "Private", "  6a " → "6A". Unknown values are trimmed and kept. */
export function normalizeClassification(raw: string | null | undefined, known: string[] = DEFAULT_CLASSIFICATIONS): string {
	const v = (raw ?? '').trim();
	if (!v) return '';
	const hit = known.find((k) => k.toLowerCase() === v.toLowerCase());
	if (hit) return hit;
	const m = /^(\d)\s*a$/i.exec(v);
	if (m) return `${m[1]}A`;
	if (/^priv/i.test(v)) return 'Private';
	return v;
}

export function getEvent(id: number) {
	const e = getDb().select().from(schema.events).where(eq(schema.events.id, id)).get();
	if (!e) error(404, 'Event not found');
	return e;
}

export function eventIdParam(params: { id: string }): number {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id < 1) error(404, 'Event not found');
	return id;
}

export function currentRuleVersion(eventId: number) {
	const v = getDb()
		.select()
		.from(schema.ruleVersions)
		.where(eq(schema.ruleVersions.eventId, eventId))
		.orderBy(desc(schema.ruleVersions.version))
		.limit(1)
		.get();
	if (!v) error(500, 'This event has no scoring settings');
	return { ...v, settings: normalizeRules(v.settings) };
}

export function ruleVersionById(id: number) {
	const v = getDb().select().from(schema.ruleVersions).where(eq(schema.ruleVersions.id, id)).get();
	if (!v) error(500, 'Scoring settings version not found');
	return { ...v, settings: normalizeRules(v.settings) };
}

/** Which settings fields each "confirm before event" item covers. */
const CONFIRM_FIELDS: Record<ConfirmKey, (r: RuleSettings) => unknown> = {
	tossup: (r) => [r.tossupPoints, r.power, r.neg],
	bonus: (r) => [r.bonus.bounceback, r.bonus.rounding],
	individual: (r) => [r.individual.includeBonus],
	tiebreaker: (r) => [r.tiebreaker, r.individual.includeTiebreaker],
	round: (r) => [r.round.timeLimitMinutes, r.round.minTossups, r.round.maxTossups],
	teamAwards: (r) => [r.awards.teamPlaces],
	divisions: (r) => [r.awards.divisions],
	individualAwards: (r) => [r.awards.individualGrouping, r.awards.individualPlaces],
	classAwards: (r) => [r.awards.classPlaces],
	format: (r) => [r.format],
	individualTies: () => 'flag'
};

/**
 * Save a new settings version if anything changed. Confirmations for the
 * groups that changed are cleared so they get re-confirmed.
 */
export function saveRules(eventId: number, settings: RuleSettings, actorName: string, note: string | null) {
	const db = getDb();
	const cur = currentRuleVersion(eventId);
	if (JSON.stringify(cur.settings) === JSON.stringify(settings)) return { changed: false, version: cur.version };
	const event = getEvent(eventId);
	const confirmations = { ...event.confirmations };
	for (const [key, pick] of Object.entries(CONFIRM_FIELDS))
		if (JSON.stringify(pick(cur.settings)) !== JSON.stringify(pick(settings))) delete confirmations[key];
	db.transaction((tx) => {
		tx.insert(schema.ruleVersions)
			.values({ eventId, version: cur.version + 1, settings, note, createdBy: actorName })
			.run();
		tx.update(schema.events).set({ confirmations }).where(eq(schema.events.id, eventId)).run();
	});
	return { changed: true, version: cur.version + 1 };
}

/** 6-digit PIN not used by any room in a non-archived event. */
export function generatePin(exclude: Set<string> = new Set()): string {
	const db = getDb();
	const used = new Set(
		db
			.select({ pin: schema.rooms.pin })
			.from(schema.rooms)
			.innerJoin(schema.events, eq(schema.rooms.eventId, schema.events.id))
			.where(ne(schema.events.status, 'archived'))
			.all()
			.map((r) => r.pin)
	);
	for (;;) {
		const pin = String(crypto.randomInt(100000, 1000000));
		if (!used.has(pin) && !exclude.has(pin)) return pin;
	}
}

export const newProjectorToken = () => crypto.randomBytes(18).toString('base64url');

export interface NewSession {
	name: string;
	date: string;
	startTime: string;
	classifications: string[];
	roundCount: number;
	roundTimes: string[];
}

export interface NewEventInput {
	name: string;
	eventDate: string;
	isTest: boolean;
	classifications: string[];
	sessions: NewSession[];
	roomNames: string[];
	/** Rooms (by name) set aside for byes and practice; their games never count. */
	practiceRoomNames?: string[];
	settings: RuleSettings;
	settingsSource: string;
}

export function createEvent(input: NewEventInput, actorName: string): number {
	const db = getDb();
	return db.transaction((tx) => {
		const [ev] = tx
			.insert(schema.events)
			.values({
				name: input.name,
				eventDate: input.eventDate,
				isTest: input.isTest,
				classifications: input.classifications,
				settingsSource: input.settingsSource
			})
			.returning()
			.all();
		tx.insert(schema.ruleVersions)
			.values({ eventId: ev.id, version: 1, settings: input.settings, note: `Created from ${input.settingsSource}`, createdBy: actorName })
			.run();
		const pins = new Set<string>();
		const roomIds: number[] = [];
		input.roomNames.forEach((name, i) => {
			const pin = generatePin(pins);
			pins.add(pin);
			const [r] = tx
				.insert(schema.rooms)
				.values({ eventId: ev.id, name, sortOrder: i, pin, projectorToken: newProjectorToken(), practice: !!input.practiceRoomNames?.includes(name) })
				.returning()
				.all();
			roomIds.push(r.id);
		});
		input.sessions.forEach((s, i) => {
			const [row] = tx
				.insert(schema.sessions)
				.values({ eventId: ev.id, sortOrder: i, ...s })
				.returning()
				.all();
			for (const roomId of roomIds) tx.insert(schema.sessionRooms).values({ sessionId: row.id, roomId }).run();
		});
		return ev.id;
	});
}

/** Settings and layout to copy into a new event. Never schools, players, PINs, or scores. */
export function copySourceFrom(eventId: number) {
	const db = getDb();
	const ev = getEvent(eventId);
	const rules = currentRuleVersion(eventId);
	const sess = db.select().from(schema.sessions).where(eq(schema.sessions.eventId, eventId)).orderBy(asc(schema.sessions.sortOrder)).all();
	const rooms = db
		.select()
		.from(schema.rooms)
		.where(and(eq(schema.rooms.eventId, eventId), eq(schema.rooms.active, true)))
		.orderBy(asc(schema.rooms.sortOrder))
		.all();
	return {
		event: ev,
		settings: rules.settings,
		classifications: ev.classifications,
		sessions: sess.map((s) => ({
			name: s.name,
			startTime: s.startTime,
			classifications: s.classifications,
			roundCount: s.roundCount,
			roundTimes: s.roundTimes
		})),
		roomNames: rooms.map((r) => r.name),
		practiceRoomNames: rooms.filter((r) => r.practice).map((r) => r.name)
	};
}

export function listSessions(eventId: number) {
	return getDb().select().from(schema.sessions).where(eq(schema.sessions.eventId, eventId)).orderBy(asc(schema.sessions.sortOrder)).all();
}

export function listRooms(eventId: number, includeInactive = false) {
	const rows = getDb().select().from(schema.rooms).where(eq(schema.rooms.eventId, eventId)).orderBy(asc(schema.rooms.sortOrder)).all();
	return includeInactive ? rows : rows.filter((r) => r.active);
}

/** Default session layout for a new high-school event. */
export function defaultSessions(date: string): NewSession[] {
	return [
		{ name: 'Morning', date, startTime: '08:30', classifications: ['Private', '1A', '2A', '3A'], roundCount: 6, roundTimes: [] },
		{ name: 'Afternoon', date, startTime: '12:15', classifications: ['4A', '5A', '6A', '7A'], roundCount: 6, roundTimes: [] }
	];
}
