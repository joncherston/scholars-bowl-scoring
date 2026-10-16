export function load({ locals }) {
	const a = locals.auth;
	return {
		auth:
			a.kind === 'user'
				? { kind: 'user' as const, name: a.user.name, email: a.user.email, isAdmin: a.user.isAdmin }
				: a.kind === 'room'
					? { kind: 'room' as const, roomName: a.room.name, eventId: a.room.eventId }
					: { kind: 'anon' as const }
	};
}
