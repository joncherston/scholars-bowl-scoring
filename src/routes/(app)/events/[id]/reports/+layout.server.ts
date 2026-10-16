import { eventIdParam } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';

export function load({ locals, params, url }) {
	requireEventRole(locals.auth, eventIdParam(params), ['head_scorekeeper', 'bracket_builder'], url);
}
