import { sseResponse } from '$lib/server/bus';
import { assertPublic } from '$lib/server/public';

export function GET({ params, request }) {
	const id = Number(params.eventId);
	assertPublic(id);
	return sseResponse((m) => m.eventId === id && (m.type === 'round' || m.type === 'session' || m.type === 'schedule'), request);
}
