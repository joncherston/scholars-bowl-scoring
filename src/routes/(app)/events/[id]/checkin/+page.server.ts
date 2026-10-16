import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { currentRuleVersion, eventIdParam, listSessions } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { cleanName } from '$lib/server/registrations';
import { addPlayerToTeam, listTeams, teamRoster } from '$lib/server/teams';
import { fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

export function load({ locals, params, url }) {
	const id = eventIdParam(params);
	requireEventRole(locals.auth, id, ['checkin', 'head_scorekeeper'], url);
	const sessions = listSessions(id);
	const sessionId = Number(url.searchParams.get('session')) || sessions[0]?.id || null;
	const teams = listTeams(id)
		.filter((t) => t.sessionId === sessionId && !t.withdrawn)
		.map((t) => ({ ...t, roster: teamRoster(t.id) }));
	return { sessionId, teams, maxPlayers: currentRuleVersion(id).settings.roster.maxPlayers };
}

function teamIn(eventId: number, teamId: number) {
	return getDb().select().from(schema.teams).where(and(eq(schema.teams.id, teamId), eq(schema.teams.eventId, eventId))).get();
}

const GRADES = new Set(['', '6', '7', '8', '9', '10', '11', '12']);

export const actions = {
	arrive: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['checkin', 'head_scorekeeper']);
		const f = await request.formData();
		const team = teamIn(eventId, Number(f.get('teamId')));
		if (!team) return fail(404, { error: 'Team not found.' });
		const arrived = f.get('arrived') === '1';
		getDb()
			.update(schema.teams)
			.set(arrived ? { arrivedAt: new Date().toISOString(), arrivedBy: user.name } : { arrivedAt: null, arrivedBy: null })
			.where(eq(schema.teams.id, team.id))
			.run();
		audit(`user:${user.id}`, arrived ? 'team_checked_in' : 'team_check_in_undone', { teamId: team.id, name: team.name }, eventId);
		return { teamId: team.id };
	},

	addPlayer: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['checkin', 'head_scorekeeper']);
		const f = await request.formData();
		const team = teamIn(eventId, Number(f.get('teamId')));
		if (!team) return fail(404, { error: 'Team not found.' });
		const firstName = cleanName(String(f.get('firstName') ?? ''));
		const lastName = cleanName(String(f.get('lastName') ?? ''));
		const preferredName = cleanName(String(f.get('preferredName') ?? '')) || null;
		const grade = String(f.get('grade') ?? '');
		if (!firstName || !lastName) return fail(400, { error: 'Enter the player\'s first and last name.', teamId: team.id });
		if (!GRADES.has(grade)) return fail(400, { error: 'Choose a grade or leave it blank.', teamId: team.id });
		const max = currentRuleVersion(eventId).settings.roster.maxPlayers;
		const roster = teamRoster(team.id);
		if (roster.length >= max) return fail(400, { error: `A team can register at most ${max} players.`, teamId: team.id });
		if (roster.some((p) => p.firstName.toLowerCase() === firstName.toLowerCase() && p.lastName.toLowerCase() === lastName.toLowerCase()))
			return fail(400, { error: `${firstName} ${lastName} is already on this team.`, teamId: team.id });
		const db = getDb();
		const playerId = db.transaction((tx) => addPlayerToTeam(tx, team.id, { firstName, lastName, preferredName, grade }));
		audit(`user:${user.id}`, 'player_added', { teamId: team.id, playerId, firstName, lastName }, eventId);
		return { teamId: team.id, added: true };
	},

	updatePlayer: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['checkin', 'head_scorekeeper']);
		const f = await request.formData();
		const team = teamIn(eventId, Number(f.get('teamId')));
		const playerId = String(f.get('playerId') ?? '');
		if (!team || !teamRoster(team.id).some((p) => p.id === playerId)) return fail(404, { error: 'Player not found.' });
		const firstName = cleanName(String(f.get('firstName') ?? ''));
		const lastName = cleanName(String(f.get('lastName') ?? ''));
		const preferredName = cleanName(String(f.get('preferredName') ?? '')) || null;
		const grade = String(f.get('grade') ?? '');
		if (!firstName || !lastName) return fail(400, { error: 'First and last name are required.', teamId: team.id });
		if (!GRADES.has(grade)) return fail(400, { error: 'Choose a grade or leave it blank.', teamId: team.id });
		const db = getDb();
		const before = db.select().from(schema.players).where(eq(schema.players.id, playerId)).get();
		db.update(schema.players).set({ firstName, lastName, preferredName, grade: grade || null }).where(eq(schema.players.id, playerId)).run();
		audit(`user:${user.id}`, 'player_updated', { teamId: team.id, playerId, before, after: { firstName, lastName, preferredName, grade } }, eventId);
		return { teamId: team.id };
	},

	removePlayer: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['checkin', 'head_scorekeeper']);
		const f = await request.formData();
		const team = teamIn(eventId, Number(f.get('teamId')));
		const playerId = String(f.get('playerId') ?? '');
		if (!team) return fail(404, { error: 'Team not found.' });
		getDb()
			.update(schema.rosterEntries)
			.set({ removed: true })
			.where(and(eq(schema.rosterEntries.teamId, team.id), eq(schema.rosterEntries.playerId, playerId)))
			.run();
		audit(`user:${user.id}`, 'player_removed_from_roster', { teamId: team.id, playerId }, eventId);
		return { teamId: team.id };
	}
};
