import { destroyAllUserSessions, hashPassword, validatePassword } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { backupNow, listBackups } from '$lib/server/backup';
import { getDb, schema } from '$lib/server/db';
import { requireAdmin } from '$lib/server/guard';
import { fail } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';

export function load({ locals, url }) {
	requireAdmin(locals.auth, url);
	const users = getDb()
		.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, isAdmin: schema.users.isAdmin, active: schema.users.active, must: schema.users.mustChangePassword, createdAt: schema.users.createdAt })
		.from(schema.users)
		.orderBy(asc(schema.users.name))
		.all();
	return { users, backups: listBackups().slice(0, 30) };
}

export const actions = {
	addUser: async ({ request, locals }) => {
		const admin = requireAdmin(locals.auth);
		const f = await request.formData();
		const name = String(f.get('name') ?? '').trim();
		const email = String(f.get('email') ?? '').trim().toLowerCase();
		const password = String(f.get('password') ?? '');
		const isAdmin = f.get('isAdmin') === 'on';
		if (!name || !email.includes('@')) return fail(400, { error: 'Enter a name and email.' });
		const err = validatePassword(password);
		if (err) return fail(400, { error: err });
		const db = getDb();
		if (db.select().from(schema.users).where(eq(schema.users.email, email)).get()) return fail(400, { error: 'That email already has an account.' });
		db.insert(schema.users).values({ name, email, isAdmin, passwordHash: await hashPassword(password), mustChangePassword: true }).run();
		audit(`user:${admin.id}`, 'user_created', { email, isAdmin });
		return { message: `Account created for ${name}. They'll choose their own password at first sign-in.` };
	},
	resetPassword: async ({ request, locals }) => {
		const admin = requireAdmin(locals.auth);
		const f = await request.formData();
		const id = Number(f.get('id'));
		const password = String(f.get('password') ?? '');
		const err = validatePassword(password);
		if (err) return fail(400, { error: err });
		getDb().update(schema.users).set({ passwordHash: await hashPassword(password), mustChangePassword: id !== admin.id }).where(eq(schema.users.id, id)).run();
		if (id !== admin.id) destroyAllUserSessions(id);
		audit(`user:${admin.id}`, 'user_password_reset', { userId: id });
		return { message: 'Password reset.' };
	},
	toggle: async ({ request, locals }) => {
		const admin = requireAdmin(locals.auth);
		const f = await request.formData();
		const id = Number(f.get('id'));
		const field = String(f.get('field'));
		if (id === admin.id) return fail(400, { error: 'You cannot change your own access here.' });
		const u = getDb().select().from(schema.users).where(eq(schema.users.id, id)).get();
		if (!u) return fail(404, { error: 'Not found.' });
		if (field === 'active') {
			getDb().update(schema.users).set({ active: !u.active }).where(eq(schema.users.id, id)).run();
			if (u.active) destroyAllUserSessions(id);
		} else if (field === 'admin') {
			getDb().update(schema.users).set({ isAdmin: !u.isAdmin }).where(eq(schema.users.id, id)).run();
		}
		audit(`user:${admin.id}`, 'user_access_changed', { userId: id, field });
	},
	backup: async ({ locals }) => {
		const admin = requireAdmin(locals.auth);
		const file = await backupNow('manual');
		audit(`user:${admin.id}`, 'backup_created', { file });
		return { message: 'Backup saved.' };
	}
};
