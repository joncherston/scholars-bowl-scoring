import type { EventBody } from '$lib/engine';
import { computeRound } from '$lib/engine';
import { describeEvent } from '$lib/describe';
import { and, eq, inArray } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getDb, schema } from './db';
import { ingestEvents, matchEvents, ROOM_TYPES, rulesForMatch } from './ingest';
import { buildMatches } from './scorer';

export interface RescueFile {
	format: 'sb-scorer-rescue';
	version: number;
	exportedAt: string;
	eventId: number;
	roomId: number;
	roomName: string;
	deviceId: string;
	events: { id: string; matchId: number; deviceSeq: number; body: EventBody; clientTs: string; synced: number; rejected: string | null }[];
	sha256: string;
}

export function parseRescue(text: string, eventId: number): { file: RescueFile; checksumOk: boolean } | { error: string } {
	let file: RescueFile;
	try {
		file = JSON.parse(text);
	} catch {
		return { error: 'That file is not a scorer results file (it is not valid JSON).' };
	}
	if (file?.format !== 'sb-scorer-rescue' || !Array.isArray(file.events)) return { error: 'That file is not a scorer results file.' };
	if (file.eventId !== eventId) return { error: 'That file is from a different event.' };
	const room = getDb().select().from(schema.rooms).where(and(eq(schema.rooms.id, file.roomId), eq(schema.rooms.eventId, eventId))).get();
	if (!room) return { error: 'That file is for a room that is not in this event.' };
	const digest = crypto.createHash('sha256').update(JSON.stringify(file.events)).digest('hex');
	return { file, checksumOk: digest === file.sha256 };
}

/** Which events in the file are new to the server, grouped by round. */
export function previewRescue(file: RescueFile, eventId: number) {
	const ids = file.events.map((e) => e.id);
	const existing = new Set(
		ids.length
			? getDb().select({ id: schema.scoreEvents.id }).from(schema.scoreEvents).where(inArray(schema.scoreEvents.id, ids)).all().map((r) => r.id)
			: []
	);
	const matchIds = [...new Set(file.events.map((e) => e.matchId))];
	const rows = matchIds.length ? getDb().select().from(schema.matches).where(inArray(schema.matches.id, matchIds)).all() : [];
	const infos = buildMatches(eventId, rows);
	return matchIds.map((matchId) => {
		const info = infos.find((m) => m.id === matchId);
		const evs = file.events.filter((e) => e.matchId === matchId).sort((a, b) => a.deviceSeq - b.deviceSeq);
		const fresh = evs.filter((e) => !existing.has(e.id));
		const nameOf = (id: string | null) =>
			(id && (info?.teams.A.roster.find((p) => p.id === id)?.name ?? info?.teams.B.roster.find((p) => p.id === id)?.name)) || 'Team';
		const row = rows.find((r) => r.id === matchId);
		const status = row ? computeRound(matchEvents(matchId), rulesForMatch(row, eventId).settings).status : 'unknown';
		return {
			matchId,
			label: info ? `${info.sessionName} Round ${info.roundNo}: ${info.teams.A.name} vs ${info.teams.B.name}` : `Game ${matchId} (not found)`,
			status,
			total: evs.length,
			onServer: evs.length - fresh.length,
			fresh: fresh.map((e) => ({
				id: e.id,
				deviceSeq: e.deviceSeq,
				clientTs: e.clientTs,
				text: info ? describeEvent(e.body, nameOf, { A: info.teams.A.name, B: info.teams.B.name }) : e.body.type,
				rejected: e.rejected
			}))
		};
	});
}

export function applyRescue(file: RescueFile, eventId: number, importedBy: string) {
	const room = getDb().select().from(schema.rooms).where(eq(schema.rooms.id, file.roomId)).get()!;
	const events = [...file.events].sort((a, b) => a.matchId - b.matchId || a.deviceSeq - b.deviceSeq);
	return ingestEvents(
		{
			eventId,
			roomId: file.roomId,
			deviceId: file.deviceId,
			actor: `room:${file.roomId}`,
			actorName: `${room.name} (results file imported by ${importedBy})`,
			source: 'file_import',
			allowed: ROOM_TYPES,
			enforceLease: false,
			lockSubmitted: false
		},
		events.map((e) => ({ id: e.id, matchId: e.matchId, deviceSeq: e.deviceSeq, body: e.body, clientTs: e.clientTs }))
	);
}
