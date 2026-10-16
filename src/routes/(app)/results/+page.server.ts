import { publicEvents } from '$lib/server/public';

export function load() {
	return { list: publicEvents() };
}
