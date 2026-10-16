import { byesByRound } from '$lib/schedule';
import { eventIdParam, listSessions } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { loadSchedule } from '$lib/server/schedule';

export function load({ locals, params, url }) {
	const id = eventIdParam(params);
	requireEventRole(locals.auth, id, ['bracket_builder', 'head_scorekeeper', 'checkin'], url);
	const sessionId = Number(url.searchParams.get('session')) || listSessions(id)[0]?.id;
	const sched = loadSchedule(id, sessionId);
	return {
		...sched,
		byes: Object.fromEntries(byesByRound(sched.teams, sched.matches, sched.session.roundCount)),
		roomSheets: url.searchParams.get('rooms') === '1'
	};
}
