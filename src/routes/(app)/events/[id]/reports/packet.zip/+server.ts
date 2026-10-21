import { audit } from '$lib/server/audit';
import { eventIdParam } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { buildReviewPacket } from '$lib/server/packet';
import { renderOrigin, renderPdf } from '$lib/server/pdf';

/** The review packet (.zip): awards, each session's results, scoresheets and schedule as PDFs, the workbook, and a Read me. */
export async function GET({ params, url, locals, cookies }) {
	const eventId = eventIdParam(params);
	const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
	const cookie = `sb_session=${cookies.get('sb_session') ?? ''}`;
	const packet = await buildReviewPacket(eventId, { render: (path, landscape) => renderPdf(`${renderOrigin(url)}${path}`, cookie, landscape), madeBy: user.name });
	audit(`user:${user.id}`, 'review_packet_exported', { files: packet.files, missing: packet.missing, bytes: packet.bytes.length }, eventId);
	const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
	return new Response(packet.bytes as unknown as BodyInit, {
		headers: {
			'Content-Type': 'application/zip',
			'Content-Disposition': `attachment; filename="scholars-bowl-${eventId}-review-packet-${stamp}.zip"`,
			'Cache-Control': 'no-store',
			'X-Packet-Missing': String(packet.missing.length)
		}
	});
}
