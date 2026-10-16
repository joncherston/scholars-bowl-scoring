import { eventIdParam } from '$lib/server/events';
import { roundSheet } from '$lib/server/reports';
import { error } from '@sveltejs/kit';

export function load({ params }) {
	const sheet = roundSheet(eventIdParam(params), Number(params.matchId));
	if (!sheet) error(404, 'Round not found');
	return { sheet };
}
