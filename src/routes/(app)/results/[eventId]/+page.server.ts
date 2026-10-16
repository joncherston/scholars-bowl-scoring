import { publicResults } from '$lib/server/public';

export function load({ params, depends }) {
	depends('app:public');
	return { results: publicResults(Number(params.eventId)) };
}
