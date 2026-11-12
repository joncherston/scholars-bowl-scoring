import { audit } from '$lib/server/audit';
import { backupNow } from '$lib/server/backup';
import { getDb, schema } from '$lib/server/db';
import { eventIdParam, getEvent, listSessions, normalizeClassification } from '$lib/server/events';
import { requireAdmin } from '$lib/server/guard';
import { buildPreview, detectMapping, FIELDS, parseCsv, toRows, type ColumnMapping, type FieldKey } from '$lib/server/registrations';
import { applyImportRows } from '$lib/server/import-apply';
import { getWpSettings, wpEvents, wpRegistrations, WpError, type WpEvent } from '$lib/server/wordpress';
import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

export async function load({ locals, url, params }) {
	requireAdmin(locals.auth, url);
	const event = getEvent(eventIdParam(params));
	const wp = getWpSettings();
	let website: { events: WpEvent[]; suggested: number | null; error: string | null } | null = null;
	if (wp?.enabled && wp.token) {
		try {
			const events = await wpEvents(wp);
			const suggested = events.find((e) => e.date === event.eventDate) ?? events.find((e) => e.date?.slice(0, 4) === event.eventDate.slice(0, 4)) ?? events[0];
			website = { events, suggested: suggested?.id ?? null, error: null };
		} catch (e) {
			website = { events: [], suggested: null, error: e instanceof WpError ? e.message : 'Could not reach the website.' };
		}
	}
	return { defaultCutoff: `${event.eventDate.slice(0, 4)}-01-01`, fields: FIELDS, website };
}

function existingTeams(eventId: number) {
	return getDb()
		.select()
		.from(schema.teams)
		.where(eq(schema.teams.eventId, eventId))
		.all();
}

export const actions = {
	preview: async ({ request, locals, params }) => {
		requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const event = getEvent(eventId);
		const f = await request.formData();
		const file = f.get('file');
		let text = String(f.get('fileText') ?? '');
		let filename = String(f.get('filename') ?? '');
		if (file instanceof File && file.size > 0) {
			if (file.size > 5_000_000) return fail(400, { error: 'That file is too large for a registration export.' });
			text = await file.text();
			filename = file.name;
		}
		if (!text.trim()) return fail(400, { error: 'Choose the CSV file to upload.' });
		const cutoff = String(f.get('cutoff') ?? '') || null;
		const { headers, records, errors } = parseCsv(text);
		if (!headers.length || !records.length) return fail(400, { error: 'The file has no rows.' });
		const detected = detectMapping(headers);
		let mapping: ColumnMapping = detected.mapping;
		const manual = f.get('manualMapping') === '1';
		if (manual) {
			mapping = {};
			for (const k of Object.keys(FIELDS) as FieldKey[]) {
				const h = String(f.get(`map_${k}`) ?? '');
				if (h && headers.includes(h)) mapping[k] = h;
			}
		}
		if (!detected.pluginLayout && !manual) {
			return { stage: 'mapping' as const, headers, mapping, fileText: text, filename, cutoff, sample: records.slice(0, 3) };
		}
		if (!mapping.schoolName) return { stage: 'mapping' as const, headers, mapping, fileText: text, filename, cutoff, sample: records.slice(0, 3), error: 'Choose which column holds the school or team name.' };
		const rows = toRows(records, mapping, event.classifications);
		const sessions = listSessions(eventId).map((s) => ({ id: s.id, name: s.name, classifications: s.classifications }));
		const preview = buildPreview(rows, existingTeams(eventId), sessions, cutoff);
		return {
			stage: 'preview' as const,
			source: 'csv' as const,
			preview,
			pluginLayout: detected.pluginLayout,
			parseErrors: errors,
			filename,
			sha256: crypto.createHash('sha256').update(text).digest('hex'),
			cutoff
		};
	},

	pull: async ({ request, locals, params }) => {
		requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const event = getEvent(eventId);
		const wp = getWpSettings();
		if (!wp?.enabled || !wp.token) return fail(400, { error: 'The website connection is not set up (Admin → Website connection).' });
		const wpEventId = Number((await request.formData()).get('wpEventId'));
		if (!Number.isInteger(wpEventId) || wpEventId < 1) return fail(400, { error: 'Choose the website event.' });
		try {
			const [events, regs] = await Promise.all([wpEvents(wp), wpRegistrations(wp, wpEventId, event.classifications)]);
			const sessions = listSessions(eventId).map((s) => ({ id: s.id, name: s.name, classifications: s.classifications }));
			const preview = buildPreview(regs.rows, existingTeams(eventId), sessions, null);
			return {
				stage: 'preview' as const,
				source: 'api' as const,
				preview,
				pluginLayout: false,
				parseErrors: [] as string[],
				filename: `Website: ${events.find((e) => e.id === wpEventId)?.name ?? `event ${wpEventId}`}`,
				sha256: crypto.createHash('sha256').update(JSON.stringify(regs.raw)).digest('hex'),
				cutoff: null
			};
		} catch (e) {
			return fail(400, { error: e instanceof WpError ? e.message : 'Could not read registrations from the website.' });
		}
	},

	apply: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const event = getEvent(eventId);
		const f = await request.formData();
		let payload: {
			source?: 'csv' | 'api';
			filename: string;
			sha256: string;
			rows: {
				action: 'new' | 'update' | 'withdraw';
				existingTeamId: number | null;
				registrationId: number | null;
				schoolName: string;
				classification: string;
				sessionId: number | null;
				status: string;
				contactName: string | null;
				contactEmail: string | null;
				contactPhone: string | null;
				competingStudents: number | null;
				coaches: number | null;
			}[];
		};
		try {
			payload = JSON.parse(String(f.get('payload')));
		} catch {
			return fail(400, { error: 'Could not read the approved rows. Please preview the file again.' });
		}
		const sessionIds = new Set(listSessions(eventId).map((s) => s.id));
		for (const r of payload.rows) {
			r.classification = normalizeClassification(r.classification, event.classifications);
			if (r.action !== 'withdraw' && !r.classification) return fail(400, { error: `Choose a classification for ${r.schoolName}.` });
			if (r.sessionId !== null && !sessionIds.has(r.sessionId)) return fail(400, { error: `Unknown session for ${r.schoolName}.` });
		}
		await backupNow('pre-import');
		const db = getDb();
		const result = db.transaction((tx) => applyImportRows(tx, eventId, payload.rows, payload.source === 'api' ? 'api' : 'csv'));
		audit(`user:${admin.id}`, 'registrations_imported', { source: payload.source === 'api' ? 'api' : 'csv', filename: payload.filename, sha256: payload.sha256, ...result }, eventId);
		return { stage: 'done' as const, result };
	}
};
