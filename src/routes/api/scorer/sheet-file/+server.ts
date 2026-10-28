import { readScoresheetFile } from '$lib/server/sheet-file';
import { error, json } from '@sveltejs/kit';

/** A room scorer uploads an Excel scoresheet; its round tabs come back for the scorer to match names and import. Nothing is saved here. */
export async function POST({ locals, request }) {
	if (locals.auth.kind !== 'room') error(401, 'Sign in with the room PIN');
	const form = await request.formData().catch(() => null);
	const file = form?.get('file');
	if (!(file instanceof File) || file.size === 0) error(400, 'Choose the Excel scoresheet file.');
	if (file.size > 10 * 1024 * 1024) error(400, 'That file is too large for a scoresheet (over 10 MB).');
	try {
		const sheets = await readScoresheetFile(new Uint8Array(await file.arrayBuffer()));
		if (!sheets.length) error(400, 'No scoresheet tabs were found in that file. Each round tab should look like the usual scoresheet (Players in A4, TU Number in J3).');
		return json({ sheets });
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		error(400, e instanceof Error ? `That file could not be read: ${e.message}` : 'That file could not be read.');
	}
}
