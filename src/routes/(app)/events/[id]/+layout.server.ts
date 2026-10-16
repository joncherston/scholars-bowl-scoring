import { eventRoles } from '$lib/server/auth';
import { eventIdParam, getEvent, listSessions } from '$lib/server/events';
import { requireUser } from '$lib/server/guard';
import { error } from '@sveltejs/kit';

export function load({ locals, params, url }) {
	const user = requireUser(locals.auth, url);
	const id = eventIdParam(params);
	const event = getEvent(id);
	const roles = eventRoles(locals.auth, id);
	if (!user.isAdmin && roles.length === 0) error(403, 'You are not on the staff list for this event.');
	const has = (...r: string[]) => user.isAdmin || r.some((x) => roles.includes(x as never));
	return {
		event,
		sessions: listSessions(id).map((s) => ({ id: s.id, name: s.name })),
		roles,
		can: {
			admin: user.isAdmin,
			teams: has('checkin'),
			checkin: has('checkin', 'head_scorekeeper'),
			schedule: has('bracket_builder', 'head_scorekeeper'),
			editSchedule: has('bracket_builder'),
			live: has('head_scorekeeper'),
			reports: has('head_scorekeeper')
		}
	};
}
