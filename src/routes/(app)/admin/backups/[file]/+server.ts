import { audit } from '$lib/server/audit';
import { backupDir, backupNow } from '$lib/server/backup';
import { requireAdmin } from '$lib/server/guard';
import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import path from 'node:path';

/** Download a backup. "latest" takes a fresh snapshot first. */
export async function GET({ params, locals }) {
	const admin = requireAdmin(locals.auth);
	let file = params.file;
	if (file === 'latest') file = path.basename(await backupNow('manual'));
	if (!/^scoring-[a-z-]+-\d{8}-\d{6}\.db$/.test(file)) error(404, 'Not found');
	const full = path.join(backupDir(), file);
	if (!fs.existsSync(full)) error(404, 'Not found');
	audit(`user:${admin.id}`, 'backup_downloaded', { file });
	return new Response(fs.readFileSync(full), {
		headers: { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'no-store' }
	});
}
