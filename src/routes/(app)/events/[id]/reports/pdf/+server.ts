import { eventIdParam } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { printablePage, renderOrigin, renderPdf } from '$lib/server/pdf';
import { error } from '@sveltejs/kit';

/** PDF of a report page or the schedule printout in this event (see printablePage). */
export async function GET({ params, url, locals, cookies }) {
	const eventId = eventIdParam(params);
	requireEventRole(locals.auth, eventId, ['head_scorekeeper', 'bracket_builder']);
	const page = printablePage(eventId, url.searchParams.get('path') ?? '');
	if (!page) error(400, 'Not a report page');
	const name = (url.searchParams.get('name') ?? 'report').replace(/[^\w.-]+/g, '-').slice(0, 80);
	try {
		const pdf = await renderPdf(`${renderOrigin(url)}${page.path}`, `sb_session=${cookies.get('sb_session') ?? ''}`, page.landscape);
		return new Response(pdf as unknown as BodyInit, {
			headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}.pdf"`, 'Cache-Control': 'no-store' }
		});
	} catch (e) {
		console.error('[pdf]', e);
		error(500, 'The PDF could not be created. Use the Print button on the report page instead.');
	}
}
