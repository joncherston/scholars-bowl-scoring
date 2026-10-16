import { getDb, schema } from '$lib/server/db';
import { redirect } from '@sveltejs/kit';
import { count } from 'drizzle-orm';

export function load({ locals }) {
	if (locals.auth.kind === 'user') redirect(303, '/events');
	if (locals.auth.kind === 'room') redirect(303, '/scorer');
	const users = getDb().select({ n: count() }).from(schema.users).get()!.n;
	return { needsSetup: users === 0 };
}
