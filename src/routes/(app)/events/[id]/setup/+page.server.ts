import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { eventIdParam, getEvent, normalizeClassification, sortClassifications } from '$lib/server/events';
import { requireAdmin } from '$lib/server/guard';
import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';

export const actions = {
	default: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const id = eventIdParam(params);
		const before = getEvent(id);
		const f = await request.formData();
		const name = String(f.get('name') ?? '').trim();
		const eventDate = String(f.get('eventDate') ?? '');
		const status = String(f.get('status') ?? 'setup') as typeof before.status;
		const classifications = sortClassifications(
			[...new Set(String(f.get('classifications') ?? '').split(',').map((c) => normalizeClassification(c)).filter(Boolean))],
			before.classifications
		);
		if (!name) return fail(400, { error: 'The event needs a name.' });
		if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return fail(400, { error: 'Choose a valid date.' });
		if (!classifications.length) return fail(400, { error: 'List at least one classification.' });
		if (!['setup', 'active', 'finalized', 'archived'].includes(status)) return fail(400, { error: 'Unknown status.' });
		const isTest = f.get('isTest') === 'on';
		const publicResults = f.get('publicResults') === 'on' && !isTest;
		getDb().update(schema.events).set({ name, eventDate, isTest, publicResults, classifications, status }).where(eq(schema.events.id, id)).run();
		audit(`user:${admin.id}`, 'event_updated', { name, eventDate, isTest, publicResults, classifications, status }, id);
		return { ok: true };
	}
};
