import { audit } from '$lib/server/audit';
import { backupNow } from '$lib/server/backup';
import { getDb, schema } from '$lib/server/db';
import { eventIdParam, getEvent, listSessions, normalizeClassification } from '$lib/server/events';
import { requireAdmin } from '$lib/server/guard';
import { buildPreview, detectMapping, FIELDS, parseCsv, toRows, type ColumnMapping, type FieldKey } from '$lib/server/registrations';
import { createTeam } from '$lib/server/teams';
import { fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';

export function load({ locals, url, params }) {
	requireAdmin(locals.auth, url);
	const event = getEvent(eventIdParam(params));
	return { defaultCutoff: `${event.eventDate.slice(0, 4)}-01-01`, fields: FIELDS };
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
			preview,
			pluginLayout: detected.pluginLayout,
			parseErrors: errors,
			filename,
			sha256: crypto.createHash('sha256').update(text).digest('hex'),
			cutoff
		};
	},

	apply: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const event = getEvent(eventId);
		const f = await request.formData();
		let payload: {
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
		const result = { created: 0, updated: 0, withdrawn: 0 };
		db.transaction((tx) => {
			for (const r of payload.rows) {
				const fields = {
					registrationName: r.schoolName,
					registrationStatus: r.status,
					contactName: r.contactName,
					contactEmail: r.contactEmail,
					contactPhone: r.contactPhone,
					competingStudents: r.competingStudents,
					coaches: r.coaches
				};
				if (r.action === 'new') {
					if (r.registrationId != null) {
						const dup = tx.select().from(schema.teams).where(and(eq(schema.teams.eventId, eventId), eq(schema.teams.registrationId, r.registrationId))).get();
						if (dup) continue;
					}
					createTeam(tx, eventId, { ...fields, name: r.schoolName, classification: r.classification, sessionId: r.sessionId, registrationId: r.registrationId, source: 'csv' });
					result.created++;
				} else if (r.action === 'update' && r.existingTeamId) {
					const t = tx.select().from(schema.teams).where(and(eq(schema.teams.id, r.existingTeamId), eq(schema.teams.eventId, eventId))).get();
					if (!t) continue;
					// Keep a display name the admin chose; follow the registration's name otherwise.
					const name = t.name === (t.registrationName ?? t.name) ? r.schoolName : t.name;
					tx.update(schema.teams)
						.set({ ...fields, name, classification: r.classification || t.classification, sessionId: r.sessionId ?? t.sessionId, withdrawn: false })
						.where(eq(schema.teams.id, t.id))
						.run();
					result.updated++;
				} else if (r.action === 'withdraw' && r.existingTeamId) {
					tx.update(schema.teams).set({ withdrawn: true, registrationStatus: 'cancelled' }).where(and(eq(schema.teams.id, r.existingTeamId), eq(schema.teams.eventId, eventId))).run();
					result.withdrawn++;
				}
			}
		});
		audit(`user:${admin.id}`, 'registrations_imported', { source: 'csv', filename: payload.filename, sha256: payload.sha256, ...result }, eventId);
		return { stage: 'done' as const, result };
	}
};
