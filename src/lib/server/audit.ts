import { getDb, schema } from './db';

export function audit(actor: string, action: string, details: unknown = null, eventId: number | null = null) {
	getDb().insert(schema.auditLog).values({ actor, action, details, eventId }).run();
}
