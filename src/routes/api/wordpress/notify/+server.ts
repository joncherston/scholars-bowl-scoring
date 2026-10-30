import { rateLimit } from '$lib/server/rate-limit';
import { getWpSettings } from '$lib/server/wordpress';
import { requestSync, verifyPing } from '$lib/server/wpsync';
import { json } from '@sveltejs/kit';

/**
 * Signed ping from the registration website when an event, registration or roster changes.
 * The ping carries no personal data; on a valid signature the app pulls the details itself.
 */
export async function POST({ request, getClientAddress }) {
	if (!rateLimit(`wp-notify:${getClientAddress()}`, 60, 60_000).ok) return json({ ok: false }, { status: 429 });
	const body = await request.text();
	if (body.length > 4096) return json({ ok: false }, { status: 413 });
	const check = verifyPing(getWpSettings(), body, request.headers.get('x-sbr-timestamp'), request.headers.get('x-sbr-signature'));
	if (!check.ok) {
		console.warn('[wp-notify] rejected:', check.reason);
		return json({ ok: false }, { status: 401 });
	}
	let wpEventId: number | undefined;
	let type = 'ping';
	try {
		const j = JSON.parse(body);
		if (Number.isInteger(j?.event_id) && j.event_id > 0) wpEventId = j.event_id;
		if (typeof j?.type === 'string') type = j.type.slice(0, 40);
	} catch {
		/* a valid signature on an unparseable body: just sync everything */
	}
	requestSync(type === 'event.deleted' ? undefined : wpEventId, `website:${type}`);
	return json({ ok: true }, { status: 202 });
}
