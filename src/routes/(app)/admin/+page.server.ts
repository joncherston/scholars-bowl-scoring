import { destroyAllUserSessions, hashPassword, validatePassword } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { backupNow, listBackups } from '$lib/server/backup';
import { getDb, schema } from '$lib/server/db';
import { requireAdmin } from '$lib/server/guard';
import { getWpSettings, normalizeSiteUrl, saveWpSettings, wpEvents, WpError } from '$lib/server/wordpress';
import { lastSyncReport, syncFromWebsite } from '$lib/server/wpsync';
import { fail } from '@sveltejs/kit';
import { asc, desc, eq } from 'drizzle-orm';

export function load({ locals, url }) {
	requireAdmin(locals.auth, url);
	const users = getDb()
		.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, isAdmin: schema.users.isAdmin, active: schema.users.active, must: schema.users.mustChangePassword, createdAt: schema.users.createdAt })
		.from(schema.users)
		.orderBy(asc(schema.users.name))
		.all();
	const events = getDb().select({ id: schema.events.id, name: schema.events.name, isTest: schema.events.isTest }).from(schema.events).orderBy(desc(schema.events.eventDate)).all();
	const wp = getWpSettings();
	return {
		users,
		events,
		backups: listBackups().slice(0, 30),
		website: wp ? { url: wp.url, enabled: wp.enabled, autoSync: !!wp.autoSync, tokenSet: !!wp.token, tokenHint: wp.token ? wp.token.slice(-4) : '' } : null,
		sync: lastSyncReport(),
		notifyUrl: `${url.origin}/api/wordpress/notify`
	};
}

export const actions = {
	addUser: async ({ request, locals }) => {
		const admin = requireAdmin(locals.auth);
		const f = await request.formData();
		const name = String(f.get('name') ?? '').trim();
		const email = String(f.get('email') ?? '').trim().toLowerCase();
		const password = String(f.get('password') ?? '');
		const isAdmin = f.get('isAdmin') === 'on';
		if (!name || !email.includes('@')) return fail(400, { error: 'Enter a name and email.' });
		const err = validatePassword(password);
		if (err) return fail(400, { error: err });
		const db = getDb();
		if (db.select().from(schema.users).where(eq(schema.users.email, email)).get()) return fail(400, { error: 'That email already has an account.' });
		db.insert(schema.users).values({ name, email, isAdmin, passwordHash: await hashPassword(password), mustChangePassword: true }).run();
		audit(`user:${admin.id}`, 'user_created', { email, isAdmin });
		return { message: `Account created for ${name}. They'll choose their own password at first sign-in.` };
	},
	resetPassword: async ({ request, locals }) => {
		const admin = requireAdmin(locals.auth);
		const f = await request.formData();
		const id = Number(f.get('id'));
		const password = String(f.get('password') ?? '');
		const err = validatePassword(password);
		if (err) return fail(400, { error: err });
		getDb().update(schema.users).set({ passwordHash: await hashPassword(password), mustChangePassword: id !== admin.id }).where(eq(schema.users.id, id)).run();
		if (id !== admin.id) destroyAllUserSessions(id);
		audit(`user:${admin.id}`, 'user_password_reset', { userId: id });
		return { message: 'Password reset.' };
	},
	toggle: async ({ request, locals }) => {
		const admin = requireAdmin(locals.auth);
		const f = await request.formData();
		const id = Number(f.get('id'));
		const field = String(f.get('field'));
		if (id === admin.id) return fail(400, { error: 'You cannot change your own access here.' });
		const u = getDb().select().from(schema.users).where(eq(schema.users.id, id)).get();
		if (!u) return fail(404, { error: 'Not found.' });
		if (field === 'active') {
			getDb().update(schema.users).set({ active: !u.active }).where(eq(schema.users.id, id)).run();
			if (u.active) destroyAllUserSessions(id);
		} else if (field === 'admin') {
			getDb().update(schema.users).set({ isAdmin: !u.isAdmin }).where(eq(schema.users.id, id)).run();
		}
		audit(`user:${admin.id}`, 'user_access_changed', { userId: id, field });
	},
	website: async ({ request, locals }) => {
		const admin = requireAdmin(locals.auth);
		const f = await request.formData();
		const url = normalizeSiteUrl(String(f.get('url') ?? ''));
		if (!url) return fail(400, { error: 'Enter the website address, starting with https://' });
		const existing = getWpSettings();
		const newToken = String(f.get('token') ?? '').trim();
		const token = f.get('clearToken') === 'on' ? '' : newToken || existing?.token || '';
		const enabled = f.get('enabled') === 'on' && !!token;
		saveWpSettings({ url, token, enabled, autoSync: enabled && f.get('autoSync') === 'on' });
		audit(`user:${admin.id}`, 'website_connection_saved', { url, enabled: f.get('enabled') === 'on', autoSync: f.get('autoSync') === 'on', tokenChanged: !!newToken });
		return { message: token ? 'Website connection saved.' : 'Saved. Add an API token to turn the connection on.' };
	},
	testWebsite: async ({ locals }) => {
		requireAdmin(locals.auth);
		const s = getWpSettings();
		if (!s?.token) return fail(400, { error: 'Save the website address and API token first.' });
		try {
			const evs = await wpEvents(s);
			return { message: `Connected. The website has ${evs.length} event(s): ${evs.slice(0, 3).map((e) => e.name).join(', ')}${evs.length > 3 ? '…' : ''}` };
		} catch (e) {
			return fail(400, { error: e instanceof WpError ? e.message : 'The connection test failed.' });
		}
	},
	syncNow: async ({ locals }) => {
		const admin = requireAdmin(locals.auth);
		const r = await syncFromWebsite({ reason: `manual by ${admin.name}` });
		if (!r.ok) return fail(400, { error: r.error ?? 'Sync failed.' });
		return { message: `Synced: ${r.eventsCreated.length} event(s) created, ${r.teams.created} team(s) added, ${r.teams.updated} updated, ${r.teams.withdrawn} withdrawn, ${r.players.added} player(s) added, ${r.players.updated} updated.` };
	},
	backup: async ({ locals }) => {
		const admin = requireAdmin(locals.auth);
		const file = await backupNow('manual');
		audit(`user:${admin.id}`, 'backup_created', { file });
		return { message: 'Backup saved.' };
	}
};
