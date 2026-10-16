import { eventIdParam, listSessions } from '$lib/server/events';
import { roundSheet, sessionMatchIds } from '$lib/server/reports';

export function load({ params, url }) {
	const id = eventIdParam(params);
	const sessionId = Number(url.searchParams.get('session')) || listSessions(id)[0]?.id;
	const round = Number(url.searchParams.get('round')) || undefined;
	const blank = url.searchParams.get('blank') === '1';
	const sheets = sessionMatchIds(id, sessionId, round)
		.map((mid) => roundSheet(id, mid))
		.filter((s): s is NonNullable<typeof s> => !!s && (blank || s.result.status !== 'not_started'));
	return { sheets, blank };
}
