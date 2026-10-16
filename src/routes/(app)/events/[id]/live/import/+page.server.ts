import { audit } from '$lib/server/audit';
import { backupNow } from '$lib/server/backup';
import { eventIdParam } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { applyRescue, parseRescue, previewRescue } from '$lib/server/rescue';
import { fail } from '@sveltejs/kit';

export function load({ locals, params, url }) {
	requireEventRole(locals.auth, eventIdParam(params), ['head_scorekeeper'], url);
}

export const actions = {
	preview: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const f = await request.formData();
		const file = f.get('file');
		if (!(file instanceof File) || !file.size) return fail(400, { error: 'Choose the results file from the flash drive.' });
		if (file.size > 10_000_000) return fail(400, { error: 'That file is too large to be a scorer results file.' });
		const text = await file.text();
		const parsed = parseRescue(text, eventId);
		if ('error' in parsed) return fail(400, { error: parsed.error });
		return {
			stage: 'preview' as const,
			text,
			filename: file.name,
			checksumOk: parsed.checksumOk,
			roomName: parsed.file.roomName,
			exportedAt: parsed.file.exportedAt,
			rounds: previewRescue(parsed.file, eventId)
		};
	},
	apply: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const f = await request.formData();
		const parsed = parseRescue(String(f.get('text') ?? ''), eventId);
		if ('error' in parsed) return fail(400, { error: parsed.error });
		await backupNow('pre-import');
		const results = applyRescue(parsed.file, eventId, user.name);
		const summary = {
			accepted: results.filter((r) => r.status === 'accepted').length,
			duplicate: results.filter((r) => r.status === 'duplicate').length,
			rejected: results.filter((r) => r.status === 'rejected').length
		};
		audit(`user:${user.id}`, 'results_file_imported', { room: parsed.file.roomName, deviceId: parsed.file.deviceId, exportedAt: parsed.file.exportedAt, checksumOk: parsed.checksumOk, ...summary }, eventId);
		return { stage: 'done' as const, ...summary };
	}
};
