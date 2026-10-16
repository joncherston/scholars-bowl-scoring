import { getDb, schema } from '$lib/server/db';
import { requireUser } from '$lib/server/guard';
import { desc, eq, inArray } from 'drizzle-orm';

export function load({ locals, url }) {
	const u = requireUser(locals.auth, url);
	const db = getDb();
	let rows = db.select().from(schema.events).orderBy(desc(schema.events.eventDate)).all();
	if (!u.isAdmin) {
		const mine = db
			.select({ eventId: schema.eventStaff.eventId })
			.from(schema.eventStaff)
			.where(eq(schema.eventStaff.email, u.email))
			.all()
			.map((r) => r.eventId);
		rows = mine.length ? db.select().from(schema.events).where(inArray(schema.events.id, mine)).orderBy(desc(schema.events.eventDate)).all() : [];
	}
	return { events: rows, isAdmin: u.isAdmin };
}
