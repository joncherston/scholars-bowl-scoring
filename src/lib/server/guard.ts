import { error, redirect } from '@sveltejs/kit';
import { eventRoles, type AuthContext, type SessionUser, type StaffRole } from './auth';

export function requireUser(auth: AuthContext, url?: URL): SessionUser {
	if (auth.kind !== 'user') {
		const next = url ? `?next=${encodeURIComponent(url.pathname + url.search)}` : '';
		redirect(303, `/login${next}`);
	}
	return auth.user;
}

export function requireAdmin(auth: AuthContext, url?: URL): SessionUser {
	const u = requireUser(auth, url);
	if (!u.isAdmin) error(403, 'Only an administrator can do that.');
	return u;
}

/** Staff with any of `roles` for this event, or an admin. */
export function requireEventRole(auth: AuthContext, eventId: number, roles: StaffRole[], url?: URL): SessionUser {
	const u = requireUser(auth, url);
	if (u.isAdmin) return u;
	const mine = eventRoles(auth, eventId);
	if (!roles.some((r) => mine.includes(r))) error(403, 'Your account does not have access to this part of the event.');
	return u;
}
