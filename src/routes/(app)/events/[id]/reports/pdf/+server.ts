import { eventIdParam } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { renderPdf } from '$lib/server/pdf';
import { error } from '@sveltejs/kit';

/** PDF of a report page in this event (only /events/<id>/reports/... paths are allowed). */
export async function GET({ params, url, locals, cookies }) {
	const eventId = eventIdParam(params);
	requireEventRole(locals.auth, eventId, ['head_scorekeeper', 'bracket_builder']);
	const path = url.searchParams.get('path') ?? '';
	if (!path.startsWith(`/events/${eventId}/reports/`) || path.includes('..') || path.includes('/pdf')) error(400, 'Not a report page');
	const name = (url.searchParams.get('name') ?? 'report').replace(/[^\w.-]+/g, '-').slice(0, 80);
	const origin = process.env.PORT && process.env.NODE_ENV === 'production' ? `http://127.0.0.1:${process.env.PORT}` : url.origin;
	try {
		const pdf = await renderPdf(`${origin}${path}`, `sb_session=${cookies.get('sb_session') ?? ''}`);
		return new Response(pdf as unknown as BodyInit, {
			headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}.pdf"`, 'Cache-Control': 'no-store' }
		});
	} catch (e) {
		console.error('[pdf]', e);
		error(500, 'The PDF could not be created. Use the Print button on the report page instead.');
	}
}
