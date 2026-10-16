import { destroyAllUserSessions, createUserSession, hashPassword, validatePassword, verifyPassword } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { requireUser } from '$lib/server/guard';
import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';

export function load({ locals, url }) {
	const u = requireUser(locals.auth, url);
	return { required: u.mustChangePassword };
}

export const actions = {
	password: async ({ request, locals, cookies }) => {
		const u = requireUser(locals.auth);
		const f = await request.formData();
		const current = String(f.get('current') ?? '');
		const next = String(f.get('password') ?? '');
		const confirm = String(f.get('confirm') ?? '');
		const row = getDb().select().from(schema.users).where(eq(schema.users.id, u.id)).get()!;
		if (!(await verifyPassword(row.passwordHash, current))) return fail(400, { error: 'Your current password is not correct.' });
		const err = validatePassword(next);
		if (err) return fail(400, { error: err });
		if (next !== confirm) return fail(400, { error: 'The new passwords do not match.' });
		getDb()
			.update(schema.users)
			.set({ passwordHash: await hashPassword(next), mustChangePassword: false })
			.where(eq(schema.users.id, u.id))
			.run();
		destroyAllUserSessions(u.id);
		createUserSession(cookies, u.id);
		audit(`user:${u.id}`, 'password_changed');
		return { ok: true };
	}
};
