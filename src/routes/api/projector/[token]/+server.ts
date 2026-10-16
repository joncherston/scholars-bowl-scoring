import { projectorState } from '$lib/server/projector';
import { json } from '@sveltejs/kit';

export function GET({ params }) {
	return json(projectorState(params.token), { headers: { 'Cache-Control': 'no-store' } });
}
