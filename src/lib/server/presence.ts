/** Latest unsent-action count each room's device reported (in memory; resets on restart). */
const pendingByRoom = new Map<number, { pending: number; at: number }>();

export function reportPending(roomId: number, pending: number) {
	pendingByRoom.set(roomId, { pending, at: Date.now() });
}

export function roomPending(roomId: number): number {
	const p = pendingByRoom.get(roomId);
	return p && Date.now() - p.at < 120_000 ? p.pending : 0;
}
