import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { eventIdParam, getEvent, listSessions, normalizeClassification } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { cleanName } from '$lib/server/registrations';
import { createTeam, listTeams } from '$lib/server/teams';
import { fail } from '@sveltejs/kit';
import { and, count, eq, or } from 'drizzle-orm';

export function load({ locals, params, url }) {
	const id = eventIdParam(params);
	requireEventRole(locals.auth, id, ['checkin'], url);
	const db = getDb();
	const teams = listTeams(id).map((t) => ({
		...t,
		players: db.select({ n: count() }).from(schema.rosterEntries).where(and(eq(schema.rosterEntries.teamId, t.id), eq(schema.rosterEntries.removed, false))).get()!.n,
		games: db.select({ n: count() }).from(schema.matches).where(or(eq(schema.matches.teamAId, t.id), eq(schema.matches.teamBId, t.id))).get()!.n
	}));
	return { teams, sessionList: listSessions(id) };
}

export const actions = {
	add: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['checkin']);
		const event = getEvent(eventId);
		const f = await request.formData();
		const name = cleanName(String(f.get('name') ?? ''));
		const classification = normalizeClassification(String(f.get('classification') ?? ''), event.classifications);
		const sessionId = Number(f.get('sessionId')) || null;
		if (!name) return fail(400, { error: 'Enter the team name.' });
		if (!classification) return fail(400, { error: 'Choose a classification.' });
		const id = getDb().transaction((tx) =>
			createTeam(tx, eventId, {
				name,
				registrationName: null,
				classification,
				sessionId,
				source: 'manual',
				registrationStatus: 'manual',
				contactName: String(f.get('contactName') ?? '').trim() || null,
				contactEmail: String(f.get('contactEmail') ?? '').trim().toLowerCase() || null
			})
		);
		audit(`user:${user.id}`, 'team_added_manually', { teamId: id, name, classification, sessionId }, eventId);
		return { message: `${name} added.` };
	},

	update: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['checkin']);
		const event = getEvent(eventId);
		const f = await request.formData();
		const teamId = Number(f.get('teamId'));
		const db = getDb();
		const team = db.select().from(schema.teams).where(and(eq(schema.teams.id, teamId), eq(schema.teams.eventId, eventId))).get();
		if (!team) return fail(404, { error: 'Team not found.' });
		const name = cleanName(String(f.get('name') ?? ''));
		const classification = normalizeClassification(String(f.get('classification') ?? ''), event.classifications);
		const sessionId = Number(f.get('sessionId')) || null;
		const withdrawn = f.get('withdrawn') === 'on';
		const schoolDisplayName = cleanName(String(f.get('schoolDisplayName') ?? ''));
		if (!name || !classification) return fail(400, { error: 'Team name and classification are required.' });
		db.transaction((tx) => {
			tx.update(schema.teams).set({ name, classification, sessionId, withdrawn }).where(eq(schema.teams.id, teamId)).run();
			if (schoolDisplayName) tx.update(schema.schools).set({ displayName: schoolDisplayName }).where(eq(schema.schools.id, team.schoolId)).run();
		});
		audit(`user:${user.id}`, 'team_updated', { teamId, before: { name: team.name, classification: team.classification, sessionId: team.sessionId, withdrawn: team.withdrawn }, after: { name, classification, sessionId, withdrawn } }, eventId);
		return { message: `${name} saved.` };
	}
};
