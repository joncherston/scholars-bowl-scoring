import { sseResponse } from '$lib/server/bus';
import { roomByToken, roomMatchRows } from '$lib/server/projector';

export function GET({ params, request }) {
	const room = roomByToken(params.token);
	const ids = new Set(roomMatchRows(room).map((m) => m.id));
	return sseResponse((m) => m.type === 'round' && (m.roomId === room.id || (m.matchId !== undefined && ids.has(m.matchId))), request);
}
