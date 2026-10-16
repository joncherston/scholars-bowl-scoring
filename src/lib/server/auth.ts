import { hash, verify } from '@node-rs/argon2';
import type { Cookies } from '@sveltejs/kit';
import { and, eq, lt } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getDb, schema } from './db';

export type StaffRole = 'head_scorekeeper' | 'checkin' | 'bracket_builder';
export const STAFF_ROLES: { value: StaffRole; label: string }[] = [
	{ value: 'head_scorekeeper', label: 'Head scorekeeper' },
	{ value: 'checkin', label: 'Check-in staff' },
	{ value: 'bracket_builder', label: 'Bracket builder' }
];

export interface SessionUser {
	id: number;
	email: string;
	name: string;
	isAdmin: boolean;
	mustChangePassword: boolean;
}

export interface SessionRoom {
	id: number;
	name: string;
	eventId: number;
}

export type AuthContext =
	| { kind: 'anon' }
	| { kind: 'user'; user: SessionUser; sessionId: string }
	| { kind: 'room'; room: SessionRoom; deviceId: string | null; sessionId: string };

const COOKIE = 'sb_session';
const USER_TTL_MS = 14 * 24 * 3600 * 1000;
const ROOM_TTL_MS = 36 * 3600 * 1000;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();

/** Argon2id with OWASP-recommended parameters. */
export const hashPassword = (password: string) =>
	hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
	try {
		return await verify(passwordHash, password);
	} catch {
		return false;
	}
}

/** Used to equalize timing when an account does not exist. */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string) {
	dummyHash ??= hashPassword('not-a-real-password');
	await verifyPassword(await dummyHash, password);
}

export function validatePassword(pw: string): string | null {
	if (pw.length < 10) return 'Use at least 10 characters.';
	if (pw.length > 200) return 'That password is too long.';
	return null;
}

const secureCookies = () => process.env.NODE_ENV === 'production';

function setCookie(cookies: Cookies, token: string, ttl: number) {
	cookies.set(COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: secureCookies(),
		maxAge: Math.floor(ttl / 1000)
	});
}

export function createUserSession(cookies: Cookies, userId: number) {
	const token = crypto.randomBytes(32).toString('base64url');
	getDb()
		.insert(schema.authSessions)
		.values({ id: sha256(token), kind: 'user', userId, expiresAt: iso(Date.now() + USER_TTL_MS) })
		.run();
	setCookie(cookies, token, USER_TTL_MS);
}

export function createRoomSession(cookies: Cookies, room: SessionRoom, deviceId: string) {
	const token = crypto.randomBytes(32).toString('base64url');
	getDb()
		.insert(schema.authSessions)
		.values({
			id: sha256(token),
			kind: 'room',
			eventId: room.eventId,
			roomId: room.id,
			deviceId,
			expiresAt: iso(Date.now() + ROOM_TTL_MS)
		})
		.run();
	setCookie(cookies, token, ROOM_TTL_MS);
}

export function destroySession(cookies: Cookies) {
	const token = cookies.get(COOKIE);
	if (token) getDb().delete(schema.authSessions).where(eq(schema.authSessions.id, sha256(token))).run();
	cookies.delete(COOKIE, { path: '/' });
}

export function destroyAllUserSessions(userId: number) {
	getDb().delete(schema.authSessions).where(eq(schema.authSessions.userId, userId)).run();
}

let lastPurge = 0;

export function loadAuth(cookies: Cookies): AuthContext {
	const token = cookies.get(COOKIE);
	if (!token) return { kind: 'anon' };
	const db = getDb();
	const now = Date.now();
	if (now - lastPurge > 3600_000) {
		lastPurge = now;
		db.delete(schema.authSessions).where(lt(schema.authSessions.expiresAt, iso(now))).run();
	}
	const id = sha256(token);
	const s = db.select().from(schema.authSessions).where(eq(schema.authSessions.id, id)).get();
	if (!s || s.expiresAt < iso(now)) {
		cookies.delete(COOKIE, { path: '/' });
		return { kind: 'anon' };
	}
	if (s.kind === 'user' && s.userId) {
		const u = db.select().from(schema.users).where(eq(schema.users.id, s.userId)).get();
		if (!u || !u.active) {
			destroySession(cookies);
			return { kind: 'anon' };
		}
		// Sliding expiry, refreshed at most hourly.
		if (!s.lastSeenAt || now - Date.parse(s.lastSeenAt) > 3600_000) {
			db.update(schema.authSessions)
				.set({ lastSeenAt: iso(now), expiresAt: iso(now + USER_TTL_MS) })
				.where(eq(schema.authSessions.id, id))
				.run();
			setCookie(cookies, token, USER_TTL_MS);
		}
		return {
			kind: 'user',
			sessionId: id,
			user: { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, mustChangePassword: u.mustChangePassword }
		};
	}
	if (s.kind === 'room' && s.roomId) {
		const r = db.select().from(schema.rooms).where(eq(schema.rooms.id, s.roomId)).get();
		if (!r || !r.active) {
			destroySession(cookies);
			return { kind: 'anon' };
		}
		return { kind: 'room', sessionId: id, deviceId: s.deviceId, room: { id: r.id, name: r.name, eventId: r.eventId } };
	}
	return { kind: 'anon' };
}

/** Roles this user holds for an event (admins implicitly hold all). */
export function eventRoles(auth: AuthContext, eventId: number): StaffRole[] {
	if (auth.kind !== 'user') return [];
	if (auth.user.isAdmin) return STAFF_ROLES.map((r) => r.value);
	return getDb()
		.select({ role: schema.eventStaff.role })
		.from(schema.eventStaff)
		.where(and(eq(schema.eventStaff.eventId, eventId), eq(schema.eventStaff.email, auth.user.email)))
		.all()
		.map((r) => r.role);
}

export const actorOf = (auth: AuthContext): string =>
	auth.kind === 'user' ? `user:${auth.user.id}` : auth.kind === 'room' ? `room:${auth.room.id}` : 'anon';

export const actorNameOf = (auth: AuthContext): string =>
	auth.kind === 'user' ? auth.user.name : auth.kind === 'room' ? auth.room.name : 'Anonymous';
