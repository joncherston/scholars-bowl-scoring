import { eventIdParam, listSessions } from '$lib/server/events';
import { resultsData } from '$lib/server/reports';

export function load({ params, url }) {
	const id = eventIdParam(params);
	const sessionId = Number(url.searchParams.get('session')) || listSessions(id)[0]?.id;
	return { results: resultsData(id, sessionId) };
}
