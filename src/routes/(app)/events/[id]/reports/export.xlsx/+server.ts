import { audit } from '$lib/server/audit';
import { eventIdParam } from '$lib/server/events';
import { buildWorkbook } from '$lib/server/excel';
import { requireEventRole } from '$lib/server/guard';

/** The event's Excel workbook (see buildWorkbook). */
export async function GET({ params, locals }) {
	const eventId = eventIdParam(params);
	const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
	const buf = await buildWorkbook(eventId);
	audit(`user:${user.id}`, 'excel_exported', null, eventId);
	const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
	return new Response(buf, {
		headers: {
			'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'Content-Disposition': `attachment; filename="scholars-bowl-${eventId}-${stamp}.xlsx"`,
			'Cache-Control': 'no-store'
		}
	});
}
