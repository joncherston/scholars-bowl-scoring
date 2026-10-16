import { requireAdmin } from '$lib/server/guard';

export function load({ locals, url }) {
	requireAdmin(locals.auth, url);
}
