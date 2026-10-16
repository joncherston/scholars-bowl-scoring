import { destroyAllUserSessions, hashPassword, STAFF_ROLES, validatePassword, type StaffRole } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { eventIdParam } from '$lib/server/events';
import { requireAdmin } from '$lib/server/guard';
import { fail } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';

export function load({ params }) {
	const id = eventIdParam(params);
	const db = getDb();
	const staff = db.select().from(schema.eventStaff).where(eq(schema.eventStaff.eventId, id)).orderBy(asc(schema.eventStaff.name)).all();
	const users = db.select({ email: schema.users.email, active: schema.users.active, isAdmin: schema.users.isAdmin, must: schema.users.mustChangePassword }).from(schema.users).all();
	return {
		roles: STAFF_ROLES,
		staff: staff.map((s) => {
			const u = users.find((x) => x.email === s.email);
			return { ...s, account: u ? (u.active ? (u.must ? 'temporary' : 'active') : 'disabled') : 'none', isAdmin: !!u?.isAdmin };
		})
	};
}

export const actions = {
	add: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const f = await request.formData();
		const name = String(f.get('name') ?? '').trim();
		const email = String(f.get('email') ?? '').trim().toLowerCase();
		const roles = f.getAll('role').map(String).filter((r): r is StaffRole => STAFF_ROLES.some((x) => x.value === r));
		if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, { error: 'Enter a name and a valid email.', name, email });
		if (!roles.length) return fail(400, { error: 'Choose at least one role.', name, email });
		const db = getDb();
		for (const role of roles)
			db.insert(schema.eventStaff).values({ eventId, name, email, role }).onConflictDoUpdate({ target: [schema.eventStaff.eventId, schema.eventStaff.email, schema.eventStaff.role], set: { name } }).run();
		audit(`user:${admin.id}`, 'staff_added', { name, email, roles }, eventId);
		return { message: `${name} added.` };
	},
	remove: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const id = Number((await request.formData()).get('id'));
		const row = getDb().select().from(schema.eventStaff).where(and(eq(schema.eventStaff.id, id), eq(schema.eventStaff.eventId, eventId))).get();
		if (!row) return fail(404, { error: 'Not found.' });
		getDb().delete(schema.eventStaff).where(eq(schema.eventStaff.id, id)).run();
		audit(`user:${admin.id}`, 'staff_removed', { name: row.name, email: row.email, role: row.role }, eventId);
	},
	password: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const eventId = eventIdParam(params);
		const f = await request.formData();
		const email = String(f.get('email') ?? '').toLowerCase();
		const password = String(f.get('password') ?? '');
		const staff = getDb().select().from(schema.eventStaff).where(and(eq(schema.eventStaff.eventId, eventId), eq(schema.eventStaff.email, email))).get();
		if (!staff) return fail(404, { error: 'That person is not on this event staff list.' });
		const err = validatePassword(password);
		if (err) return fail(400, { error: err });
		const db = getDb();
		const existing = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
		const passwordHash = await hashPassword(password);
		if (existing) {
			if (existing.isAdmin && existing.id !== admin.id) return fail(400, { error: 'Reset another administrator from the Admin page.' });
			db.update(schema.users).set({ passwordHash, mustChangePassword: true, active: true }).where(eq(schema.users.id, existing.id)).run();
			destroyAllUserSessions(existing.id);
		} else {
			db.insert(schema.users).values({ email, name: staff.name, passwordHash, mustChangePassword: true }).run();
		}
		audit(`user:${admin.id}`, existing ? 'staff_password_reset' : 'staff_login_created', { email }, eventId);
		return { message: `${staff.name} can now sign in with that temporary password. They'll be asked to choose their own.` };
	}
};
