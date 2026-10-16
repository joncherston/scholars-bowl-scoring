import { eventIdParam, listRooms } from '$lib/server/events';

export function load({ params, url }) {
	return { rooms: listRooms(eventIdParam(params)), origin: url.origin };
}
