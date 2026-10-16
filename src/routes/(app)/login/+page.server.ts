import { burnPasswordCheck, createUserSession, verifyPassword } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { clearFailures, noteFailure, tooManyFailures } from '$lib/server/rate-limit';
import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';

export function load({ locals }) {
	if (locals.auth.kind === 'user') redirect(303, '/events');
}

const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/events');

export const actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim().toLowerCase();
		const password = String(form.get('password') ?? '');
		const ip = getClientAddress();

		if (tooManyFailures(`login-ip:${ip}`, 50, 15 * 60_000) || tooManyFailures(`login-email:${email}`, 8, 15 * 60_000))
			return fail(429, { email, error: 'Too many failed sign-in attempts. Wait 15 minutes and try again.' });

		const user = getDb().select().from(schema.users).where(eq(schema.users.email, email)).get();
		if (!user || !user.active) {
			noteFailure(`login-ip:${ip}`, `login-email:${email}`);
			await burnPasswordCheck(password);
			return fail(400, { email, error: 'Email or password is incorrect.' });
		}
		if (!(await verifyPassword(user.passwordHash, password))) {
			noteFailure(`login-ip:${ip}`, `login-email:${email}`);
			audit(`user:${user.id}`, 'login_failed', { ip });
			return fail(400, { email, error: 'Email or password is incorrect.' });
		}
		clearFailures(`login-email:${email}`);
		createUserSession(cookies, user.id);
		audit(`user:${user.id}`, 'login', { ip });
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
