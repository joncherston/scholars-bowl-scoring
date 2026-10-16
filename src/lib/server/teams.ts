import { and, asc, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getDb, schema, type DB } from './db';
import { cleanName, schoolKey, schoolNameFromTeam } from './registrations';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0] | DB;

/** Find a school by its normalized name, or create it. */
export function findOrCreateSchool(tx: Tx, teamOrSchoolName: string): number {
	const name = schoolNameFromTeam(teamOrSchoolName);
	const key = schoolKey(teamOrSchoolName);
	const hit = tx.select().from(schema.schools).where(eq(schema.schools.normalizedKey, key)).get();
	if (hit) return hit.id;
	const [s] = tx.insert(schema.schools).values({ name, displayName: name, normalizedKey: key }).returning().all();
	return s.id;
}

export interface TeamFields {
	name: string;
	classification: string;
	sessionId: number | null;
	registrationId?: number | null;
	registrationName?: string | null;
	source?: 'csv' | 'api' | 'manual';
	registrationStatus?: string | null;
	contactName?: string | null;
	contactEmail?: string | null;
	contactPhone?: string | null;
	competingStudents?: number | null;
	coaches?: number | null;
}

export function createTeam(tx: Tx, eventId: number, f: TeamFields, schoolName?: string): number {
	const schoolId = findOrCreateSchool(tx, schoolName ?? f.name);
	const [t] = tx
		.insert(schema.teams)
		.values({ eventId, schoolId, ...f, name: cleanName(f.name) })
		.returning()
		.all();
	return t.id;
}

export function listTeams(eventId: number) {
	return getDb()
		.select({
			team: schema.teams,
			schoolName: schema.schools.name,
			schoolDisplayName: schema.schools.displayName
		})
		.from(schema.teams)
		.innerJoin(schema.schools, eq(schema.teams.schoolId, schema.schools.id))
		.where(eq(schema.teams.eventId, eventId))
		.orderBy(asc(schema.teams.name))
		.all()
		.map((r) => ({ ...r.team, schoolName: r.schoolName, schoolDisplayName: r.schoolDisplayName }));
}

export interface PlayerInput {
	firstName: string;
	lastName: string;
	preferredName?: string | null;
	grade?: string | null;
}

export const playerDisplayName = (p: { firstName: string; lastName: string; preferredName?: string | null }) =>
	`${p.preferredName?.trim() || p.firstName} ${p.lastName}`;

export function addPlayerToTeam(tx: Tx, teamId: number, p: PlayerInput): string {
	const team = tx.select().from(schema.teams).where(eq(schema.teams.id, teamId)).get();
	if (!team) throw new Error('Team not found');
	const id = crypto.randomUUID();
	tx.insert(schema.players)
		.values({
			id,
			schoolId: team.schoolId,
			firstName: cleanName(p.firstName),
			lastName: cleanName(p.lastName),
			preferredName: p.preferredName ? cleanName(p.preferredName) : null,
			grade: p.grade || null
		})
		.run();
	const count = tx.select().from(schema.rosterEntries).where(eq(schema.rosterEntries.teamId, teamId)).all().length;
	tx.insert(schema.rosterEntries).values({ teamId, playerId: id, sortOrder: count }).run();
	return id;
}

/** Current (not removed) roster for a team, in entry order. */
export function teamRoster(teamId: number, db: Tx = getDb()) {
	return db
		.select({ player: schema.players, sortOrder: schema.rosterEntries.sortOrder })
		.from(schema.rosterEntries)
		.innerJoin(schema.players, eq(schema.rosterEntries.playerId, schema.players.id))
		.where(and(eq(schema.rosterEntries.teamId, teamId), eq(schema.rosterEntries.removed, false)))
		.orderBy(asc(schema.rosterEntries.sortOrder))
		.all()
		.map((r) => r.player);
}
