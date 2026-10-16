import { eventIdParam } from '$lib/server/events';
import { awardsData } from '$lib/server/reports';

export function load({ params, url }) {
	const id = eventIdParam(params);
	const s = Number(url.searchParams.get('session')) || undefined;
	return { awards: awardsData(id, s ? [s] : undefined) };
}
