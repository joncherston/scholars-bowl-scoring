import { HIGH_SCHOOL_DEFAULTS, RULE_TEMPLATES } from '$lib/engine';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { copySourceFrom, createEvent, DEFAULT_CLASSIFICATIONS, defaultSessions } from '$lib/server/events';
import { requireAdmin } from '$lib/server/guard';
import { createPracticeEvent } from '$lib/server/practice';
import { fail, redirect } from '@sveltejs/kit';
import { desc } from 'drizzle-orm';

export function load({ locals, url }) {
	requireAdmin(locals.auth, url);
	const events = getDb()
		.select({ id: schema.events.id, name: schema.events.name, eventDate: schema.events.eventDate, isTest: schema.events.isTest })
		.from(schema.events)
		.orderBy(desc(schema.events.eventDate))
		.all();
	return { templates: RULE_TEMPLATES.map((t) => ({ id: t.id, name: t.name })), events };
}

export const actions = {
	create: async ({ request, locals }) => {
		const admin = requireAdmin(locals.auth);
		const f = await request.formData();
		const name = String(f.get('name') ?? '').trim();
		const eventDate = String(f.get('eventDate') ?? '');
		const isTest = f.get('isTest') === 'on';
		const source = String(f.get('source') ?? 'template:high-school');
		const roomCount = Number(f.get('roomCount') ?? 8);
		const values = { name, eventDate, isTest, source, roomCount };
		if (!name) return fail(400, { ...values, error: 'Give the event a name.' });
		if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return fail(400, { ...values, error: 'Choose the event date.' });
		if (!Number.isInteger(roomCount) || roomCount < 1 || roomCount > 40)
			return fail(400, { ...values, error: 'Number of rooms must be between 1 and 40.' });

		let settings = structuredClone(HIGH_SCHOOL_DEFAULTS);
		let settingsSource = 'SUSCC High School defaults';
		let classifications = DEFAULT_CLASSIFICATIONS;
		let sessions = defaultSessions(eventDate);
		let roomNames = Array.from({ length: roomCount }, (_, i) => `Room ${i + 1}`);

		if (source.startsWith('template:')) {
			const t = RULE_TEMPLATES.find((x) => x.id === source.slice(9));
			if (t) {
				settings = structuredClone(t.settings);
				settingsSource = t.name;
			}
		} else if (source.startsWith('event:')) {
			const src = copySourceFrom(Number(source.slice(6)));
			settings = src.settings;
			settingsSource = `copy of "${src.event.name}"`;
			classifications = src.classifications;
			if (src.sessions.length) sessions = src.sessions.map((s) => ({ ...s, date: eventDate }));
			if (src.roomNames.length && f.get('copyRooms') === 'on') roomNames = src.roomNames;
		}

		const id = createEvent({ name, eventDate, isTest, classifications, sessions, roomNames, settings, settingsSource }, admin.name);
		audit(`user:${admin.id}`, 'event_created', { name, eventDate, isTest, settingsSource, rooms: roomNames.length }, id);
		redirect(303, `/events/${id}`);
	},

	practice: async ({ locals }) => {
		const admin = requireAdmin(locals.auth);
		const id = createPracticeEvent(admin.name);
		audit(`user:${admin.id}`, 'practice_event_created', null, id);
		redirect(303, `/events/${id}`);
	}
};
