import { burnPasswordCheck, createUserSession, verifyPassword } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { rateLimit, resetRateLimit } from '$lib/server/rate-limit';
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

		const byIp = rateLimit(`login-ip:${ip}`, 30, 15 * 60_000);
		const byEmail = rateLimit(`login-email:${email}`, 8, 15 * 60_000);
		if (!byIp.ok || !byEmail.ok) {
			const wait = Math.max(byIp.retryAfterSec, byEmail.retryAfterSec);
			return fail(429, { email, error: `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
		}

		const user = getDb().select().from(schema.users).where(eq(schema.users.email, email)).get();
		if (!user || !user.active) {
			await burnPasswordCheck(password);
			return fail(400, { email, error: 'Email or password is incorrect.' });
		}
		if (!(await verifyPassword(user.passwordHash, password))) {
			audit(`user:${user.id}`, 'login_failed', { ip });
			return fail(400, { email, error: 'Email or password is incorrect.' });
		}
		resetRateLimit(`login-email:${email}`);
		createUserSession(cookies, user.id);
		audit(`user:${user.id}`, 'login', { ip });
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
