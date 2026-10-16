import { eq } from 'drizzle-orm';
import { getDb, schema } from './db';
import { normalizeClassification } from './events';
import { cleanName, normalizeDate, type RegistrationRow } from './registrations';

/** Connection to the registration website's read-only API (plugin 1.0.7+). */
export interface WpSettings {
	url: string;
	token: string;
	enabled: boolean;
}

const KEY = 'wordpress';

export function getWpSettings(): WpSettings | null {
	const row = getDb().select().from(schema.appSettings).where(eq(schema.appSettings.key, KEY)).get();
	const v = row?.value as Partial<WpSettings> | undefined;
	return v?.url ? { url: v.url, token: v.token ?? '', enabled: !!v.enabled } : null;
}

export function saveWpSettings(s: WpSettings) {
	getDb()
		.insert(schema.appSettings)
		.values({ key: KEY, value: s })
		.onConflictDoUpdate({ target: schema.appSettings.key, set: { value: s } })
		.run();
}

/** https:// addresses only, except a local development site. */
export function normalizeSiteUrl(raw: string): string | null {
	try {
		const u = new URL(raw.trim());
		const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
		if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
		return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
	} catch {
		return null;
	}
}

export class WpError extends Error {}

async function wpGet(s: WpSettings, path: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
	let res: Response;
	try {
		res = await fetchImpl(`${s.url}/wp-json/sbr/v1${path}`, {
			headers: { 'X-SBR-Token': s.token, Accept: 'application/json' },
			signal: AbortSignal.timeout(20000)
		});
	} catch (e) {
		console.error('[wordpress] request failed', path, e instanceof Error ? `${e.message} ${(e as { cause?: unknown }).cause ?? ''}` : e);
		throw new WpError('Could not reach the website. Check the address and try again.');
	}
	if (res.status === 401) throw new WpError('The website rejected the API token. Generate a new one on the website (Scholars\' Bowl → API Access) and paste it here.');
	if (res.status === 404) throw new WpError('The website does not have the registration API. Is plugin version 1.0.7 or later installed?');
	if (!res.ok) throw new WpError(`The website answered with an error (${res.status}).`);
	try {
		return await res.json();
	} catch {
		throw new WpError('The website did not send valid data.');
	}
}

export interface WpEvent {
	id: number;
	name: string;
	slug: string;
	date: string | null;
	status: string | null;
	morning_classifications: string[];
	afternoon_classifications: string[];
}

export async function wpEvents(s: WpSettings, fetchImpl?: typeof fetch): Promise<WpEvent[]> {
	const j = (await wpGet(s, '/events', fetchImpl)) as { events?: WpEvent[] };
	if (!Array.isArray(j?.events)) throw new WpError('The website sent an unexpected answer for events.');
	return j.events;
}

interface WpRegistration {
	id: number;
	school_name: string | null;
	contact_name: string | null;
	contact_email: string | null;
	contact_phone: string | null;
	competing_students: number | null;
	coaches: number | null;
	classification: string | null;
	session_time: string | null;
	registration_status: string | null;
	is_test: boolean;
	registration_date: string | null;
}

/** Website registrations in the same shape the CSV importer produces, so both use one preview. */
export function toRegistrationRows(regs: WpRegistration[], classifications: string[]): RegistrationRow[] {
	return regs
		.map((r, i) => ({
			rowNumber: i + 1,
			isTest: !!r.is_test,
			registrationId: Number.isInteger(r.id) ? r.id : null,
			schoolName: cleanName(r.school_name ?? ''),
			classification: normalizeClassification(r.classification ?? '', classifications),
			session: cleanName(r.session_time ?? '').toLowerCase(),
			status: (r.registration_status ?? 'pending').toLowerCase(),
			registeredAt: normalizeDate(r.registration_date ?? undefined),
			contactName: r.contact_name ? cleanName(r.contact_name) : null,
			contactEmail: r.contact_email ? r.contact_email.trim().toLowerCase() : null,
			contactPhone: r.contact_phone ? cleanName(r.contact_phone) : null,
			competingStudents: Number.isInteger(r.competing_students) ? r.competing_students : null,
			coaches: Number.isInteger(r.coaches) ? r.coaches : null
		}))
		.filter((r) => r.schoolName !== '');
}

export async function wpRegistrations(s: WpSettings, wpEventId: number, classifications: string[], fetchImpl?: typeof fetch) {
	const j = (await wpGet(s, `/registrations?event_id=${encodeURIComponent(String(wpEventId))}`, fetchImpl)) as { registrations?: WpRegistration[] };
	if (!Array.isArray(j?.registrations)) throw new WpError('The website sent an unexpected answer for registrations.');
	return { raw: j.registrations, rows: toRegistrationRows(j.registrations, classifications) };
}
