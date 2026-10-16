import { getSqlite } from '$lib/server/db';
import { json } from '@sveltejs/kit';

export function GET() {
	try {
		getSqlite().prepare('SELECT 1').get();
		return json({ ok: true, time: new Date().toISOString() });
	} catch {
		return json({ ok: false }, { status: 503 });
	}
}
