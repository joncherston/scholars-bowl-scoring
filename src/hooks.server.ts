import { building } from '$app/environment';
import { loadAuth } from '$lib/server/auth';
import { startBackupScheduler } from '$lib/server/backup';
import { getDb } from '$lib/server/db';
import { startWebsiteSync } from '$lib/server/wpsync';
import { redirect, type Handle, type ServerInit } from '@sveltejs/kit';

export const init: ServerInit = () => {
	if (building) return;
	getDb();
	startBackupScheduler();
	startWebsiteSync();
};

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.auth = loadAuth(event.cookies);
	const a = event.locals.auth;
	const p = event.url.pathname;
	if (
		a.kind === 'user' &&
		a.user.mustChangePassword &&
		event.request.method === 'GET' &&
		!p.startsWith('/account') &&
		!p.startsWith('/logout') &&
		!p.startsWith('/api') &&
		!p.startsWith('/_app')
	) {
		redirect(303, '/account?required=1');
	}
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	if (!response.headers.has('X-Frame-Options')) response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	return response;
};
