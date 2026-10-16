import { createUserSession, hashPassword, validatePassword } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { rateLimit } from '$lib/server/rate-limit';
import { error, fail, redirect } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import crypto from 'node:crypto';

const hasUsers = () => getDb().select({ n: count() }).from(schema.users).get()!.n > 0;

export function load() {
	if (hasUsers()) error(404, 'Not found');
	return { tokenRequired: !!process.env.SETUP_TOKEN };
}

export const actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		if (hasUsers()) error(404, 'Not found');
		if (!rateLimit(`setup:${getClientAddress()}`, 10, 15 * 60_000).ok) return fail(429, { name: '', email: '', error: 'Too many attempts.' });
		const f = await request.formData();
		const token = String(f.get('token') ?? '');
		const name = String(f.get('name') ?? '').trim();
		const email = String(f.get('email') ?? '').trim().toLowerCase();
		const password = String(f.get('password') ?? '');
		const confirm = String(f.get('confirm') ?? '');
		const expected = process.env.SETUP_TOKEN ?? '';
		if (
			!expected ||
			token.length !== expected.length ||
			!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
		)
			return fail(400, { name, email, error: 'The setup code is not correct.' });
		if (!name || !email.includes('@')) return fail(400, { name, email, error: 'Enter your name and email.' });
		const pwErr = validatePassword(password);
		if (pwErr) return fail(400, { name, email, error: pwErr });
		if (password !== confirm) return fail(400, { name, email, error: 'The passwords do not match.' });
		const [u] = getDb()
			.insert(schema.users)
			.values({ name, email, passwordHash: await hashPassword(password), isAdmin: true })
			.returning()
			.all();
		audit(`user:${u.id}`, 'first_admin_created', { email });
		createUserSession(cookies, u.id);
		redirect(303, '/events');
	}
};
