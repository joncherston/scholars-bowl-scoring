import { eventIdParam, listSessions } from '$lib/server/events';

export function load({ params }) {
	const id = eventIdParam(params);
	return { sessionList: listSessions(id).map((s) => ({ id: s.id, name: s.name, roundCount: s.roundCount, finalizedAt: s.finalizedAt })) };
}
