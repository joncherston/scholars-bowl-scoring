import { and, eq } from 'drizzle-orm';
import { schema, type DB } from './db';
import { createTeam } from './teams';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0] | DB;

export interface ApprovedRow {
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
}

/** Apply approved registration rows (from the import preview or the automatic website sync). */
export function applyImportRows(tx: Tx, eventId: number, rows: ApprovedRow[], source: 'csv' | 'api') {
	const result = { created: 0, updated: 0, withdrawn: 0 };
	for (const r of rows) {
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
			createTeam(tx, eventId, { ...fields, name: r.schoolName, classification: r.classification, sessionId: r.sessionId, registrationId: r.registrationId, source });
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
	return result;
}
