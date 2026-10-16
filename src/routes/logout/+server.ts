import { destroySession } from '$lib/server/auth';
import { redirect } from '@sveltejs/kit';

export function POST({ cookies }) {
	destroySession(cookies);
	redirect(303, '/');
}
