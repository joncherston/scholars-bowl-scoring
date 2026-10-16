import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const createdAt = () => text('created_at').notNull().default(now);

/* ---------- Accounts ---------- */

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	email: text('email').notNull().unique(),
	name: text('name').notNull(),
	passwordHash: text('password_hash').notNull(),
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	active: integer('active', { mode: 'boolean' }).notNull().default(true),
	mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
	createdAt: createdAt()
});

/** Login sessions for staff (kind=user) and room scorers (kind=room). Stores a hash of the cookie token. */
export const authSessions = sqliteTable(
	'auth_sessions',
	{
		id: text('id').primaryKey(),
		kind: text('kind', { enum: ['user', 'room'] }).notNull(),
		userId: integer('user_id').references(() => users.id),
		eventId: integer('event_id').references(() => events.id),
		roomId: integer('room_id').references(() => rooms.id),
		deviceId: text('device_id'),
		expiresAt: text('expires_at').notNull(),
		lastSeenAt: text('last_seen_at'),
		createdAt: createdAt()
	},
	(t) => [index('auth_sessions_user').on(t.userId)]
);

/* ---------- Events and setup ---------- */

export const events = sqliteTable('events', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	eventDate: text('event_date').notNull(),
	isTest: integer('is_test', { mode: 'boolean' }).notNull().default(false),
	status: text('status', { enum: ['setup', 'active', 'finalized', 'archived'] }).notNull().default('setup'),
	publicResults: integer('public_results', { mode: 'boolean' }).notNull().default(false),
	/** Settings items an admin has confirmed: { [key]: { by, at } }. */
	confirmations: text('confirmations', { mode: 'json' }).$type<Record<string, { by: string; at: string }>>().notNull().default({}),
	classifications: text('classifications', { mode: 'json' }).$type<string[]>().notNull(),
	settingsSource: text('settings_source'),
	createdAt: createdAt()
});

/** Each event owns its scoring settings. Every edit creates a new immutable version. */
export const ruleVersions = sqliteTable(
	'rule_versions',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		eventId: integer('event_id').notNull().references(() => events.id),
		version: integer('version').notNull(),
		settings: text('settings', { mode: 'json' }).notNull(),
		note: text('note'),
		createdBy: text('created_by'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('rule_versions_event_version').on(t.eventId, t.version)]
);

export const sessions = sqliteTable('sessions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	eventId: integer('event_id').notNull().references(() => events.id),
	name: text('name').notNull(),
	date: text('date').notNull(),
	startTime: text('start_time').notNull(),
	classifications: text('classifications', { mode: 'json' }).$type<string[]>().notNull(),
	sortOrder: integer('sort_order').notNull().default(0),
	roundCount: integer('round_count').notNull().default(6),
	/** Start time for each round, e.g. ["08:45", "09:20"]. */
	roundTimes: text('round_times', { mode: 'json' }).$type<string[]>().notNull().default([]),
	scheduleStatus: text('schedule_status', { enum: ['draft', 'published'] }).notNull().default('draft'),
	schedulePublishedAt: text('schedule_published_at'),
	finalizedAt: text('finalized_at'),
	finalizedBy: text('finalized_by')
});

export const rooms = sqliteTable('rooms', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	eventId: integer('event_id').notNull().references(() => events.id),
	name: text('name').notNull(),
	sortOrder: integer('sort_order').notNull().default(0),
	pin: text('pin').notNull(),
	projectorToken: text('projector_token').notNull(),
	activeDeviceId: text('active_device_id'),
	lastHeardAt: text('last_heard_at'),
	active: integer('active', { mode: 'boolean' }).notNull().default(true)
});

/** Which rooms a session uses, and the moderator for each. */
export const sessionRooms = sqliteTable(
	'session_rooms',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		sessionId: integer('session_id').notNull().references(() => sessions.id),
		roomId: integer('room_id').notNull().references(() => rooms.id),
		moderator: text('moderator')
	},
	(t) => [uniqueIndex('session_rooms_unique').on(t.sessionId, t.roomId)]
);

/** Staff for one event. Logins are matched to accounts by email. */
export const eventStaff = sqliteTable(
	'event_staff',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		eventId: integer('event_id').notNull().references(() => events.id),
		name: text('name').notNull(),
		email: text('email').notNull(),
		role: text('role', { enum: ['head_scorekeeper', 'checkin', 'bracket_builder'] }).notNull(),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('event_staff_unique').on(t.eventId, t.email, t.role)]
);

/* ---------- Schools, teams, players ---------- */

export const schools = sqliteTable('schools', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	displayName: text('display_name').notNull(),
	normalizedKey: text('normalized_key').notNull(),
	createdAt: createdAt()
});

export const pools = sqliteTable('pools', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	sessionId: integer('session_id').notNull().references(() => sessions.id),
	name: text('name').notNull(),
	classifications: text('classifications', { mode: 'json' }).$type<string[]>().notNull()
});

export const teams = sqliteTable(
	'teams',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		eventId: integer('event_id').notNull().references(() => events.id),
		schoolId: integer('school_id').notNull().references(() => schools.id),
		name: text('name').notNull(),
		classification: text('classification').notNull(),
		sessionId: integer('session_id').references(() => sessions.id),
		/** Plugin registration ID, for idempotent re-imports. */
		registrationId: integer('registration_id'),
		source: text('source', { enum: ['csv', 'api', 'manual'] }).notNull().default('manual'),
		registrationStatus: text('registration_status'),
		contactName: text('contact_name'),
		contactEmail: text('contact_email'),
		contactPhone: text('contact_phone'),
		competingStudents: integer('competing_students'),
		coaches: integer('coaches'),
		arrivedAt: text('arrived_at'),
		arrivedBy: text('arrived_by'),
		withdrawn: integer('withdrawn', { mode: 'boolean' }).notNull().default(false),
		notes: text('notes'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('teams_event_registration').on(t.eventId, t.registrationId), index('teams_event').on(t.eventId)]
);

export const players = sqliteTable('players', {
	id: text('id').primaryKey(),
	schoolId: integer('school_id').notNull().references(() => schools.id),
	firstName: text('first_name').notNull(),
	lastName: text('last_name').notNull(),
	preferredName: text('preferred_name'),
	grade: text('grade'),
	createdAt: createdAt()
});

export const rosterEntries = sqliteTable(
	'roster_entries',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		teamId: integer('team_id').notNull().references(() => teams.id),
		playerId: text('player_id').notNull().references(() => players.id),
		sortOrder: integer('sort_order').notNull().default(0),
		removed: integer('removed', { mode: 'boolean' }).notNull().default(false)
	},
	(t) => [uniqueIndex('roster_unique').on(t.teamId, t.playerId)]
);

/* ---------- Schedule and scoring ---------- */

/** A scheduled game. Its scoring log lives in score_events. */
export const matches = sqliteTable(
	'matches',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		sessionId: integer('session_id').notNull().references(() => sessions.id),
		roundNo: integer('round_no').notNull(),
		roomId: integer('room_id').notNull().references(() => rooms.id),
		teamAId: integer('team_a_id').notNull().references(() => teams.id),
		teamBId: integer('team_b_id').notNull().references(() => teams.id),
		counts: integer('counts', { mode: 'boolean' }).notNull().default(true),
		poolId: integer('pool_id').references(() => pools.id),
		/** Settings version the round was scored under; set when scoring starts. */
		ruleVersionId: integer('rule_version_id').references(() => ruleVersions.id),
		createdAt: createdAt()
	},
	(t) => [index('matches_session').on(t.sessionId, t.roundNo)]
);

/** The append-only scoring log. Rows are never updated or deleted. */
export const scoreEvents = sqliteTable(
	'score_events',
	{
		id: text('id').primaryKey(),
		matchId: integer('match_id').notNull().references(() => matches.id),
		seq: integer('seq').notNull(),
		type: text('type').notNull(),
		body: text('body', { mode: 'json' }).notNull(),
		actor: text('actor').notNull(),
		actorName: text('actor_name'),
		deviceId: text('device_id'),
		deviceSeq: integer('device_seq'),
		clientTs: text('client_ts'),
		serverTs: text('server_ts').notNull().default(now),
		source: text('source', { enum: ['live', 'file_import', 'simulation', 'staff'] }).notNull().default('live')
	},
	(t) => [uniqueIndex('score_events_match_seq').on(t.matchId, t.seq), index('score_events_device').on(t.deviceId, t.matchId)]
);

/** Events that were received but not accepted (e.g. from a device that was taken over). Kept for audit. */
export const rejectedEvents = sqliteTable('rejected_events', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	eventUuid: text('event_uuid').notNull(),
	matchId: integer('match_id'),
	deviceId: text('device_id'),
	reason: text('reason').notNull(),
	raw: text('raw', { mode: 'json' }).notNull(),
	receivedAt: text('received_at').notNull().default(now)
});

/** Non-scoring admin actions: imports, PIN changes, schedule edits, finalizing, and so on. */
export const auditLog = sqliteTable(
	'audit_log',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		eventId: integer('event_id'),
		actor: text('actor').notNull(),
		action: text('action').notNull(),
		details: text('details', { mode: 'json' }),
		at: text('at').notNull().default(now)
	},
	(t) => [index('audit_event').on(t.eventId)]
);

export const appSettings = sqliteTable('app_settings', {
	key: text('key').primaryKey(),
	value: text('value', { mode: 'json' })
});
