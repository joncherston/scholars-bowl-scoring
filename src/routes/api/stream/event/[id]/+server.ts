import { eventRoles } from '$lib/server/auth';
import { sseResponse } from '$lib/server/bus';
import { error } from '@sveltejs/kit';

/** Live updates for staff views of one event. */
export function GET({ params, locals, request }) {
	const id = Number(params.id);
	if (locals.auth.kind !== 'user' || eventRoles(locals.auth, id).length === 0) error(403, 'Forbidden');
	return sseResponse((m) => m.eventId === id, request);
}
