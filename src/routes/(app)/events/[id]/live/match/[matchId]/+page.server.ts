import { computeRound, parsePoints, type BonusPart, type ScoringBody } from '$lib/engine';
import { getDb, schema } from '$lib/server/db';
import { eventIdParam } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { deviceGaps, matchEvents, rulesForMatch } from '$lib/server/ingest';
import { buildMatches } from '$lib/server/scorer';
import { staffEvent } from '$lib/server/staff-actions';
import { error, fail } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';

function matchRow(eventId: number, matchId: number) {
	const m = getDb()
		.select({ match: schema.matches })
		.from(schema.matches)
		.innerJoin(schema.sessions, eq(schema.matches.sessionId, schema.sessions.id))
		.where(and(eq(schema.matches.id, matchId), eq(schema.sessions.eventId, eventId)))
		.get()?.match;
	if (!m) error(404, 'Round not found');
	return m;
}

export function load({ locals, params, url, depends }) {
	depends('app:live');
	const eventId = eventIdParam(params);
	requireEventRole(locals.auth, eventId, ['head_scorekeeper'], url);
	const m = matchRow(eventId, Number(params.matchId));
	const [info] = buildMatches(eventId, [m]);
	const rv = rulesForMatch(m, eventId);
	const session = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, m.sessionId)).get()!;
	const rejected = getDb().select().from(schema.rejectedEvents).where(eq(schema.rejectedEvents.matchId, m.id)).orderBy(asc(schema.rejectedEvents.id)).all();
	return {
		match: info,
		session: { id: session.id, name: session.name, finalizedAt: session.finalizedAt },
		ruleVersion: m.ruleVersionId ? rv.version : null,
		gaps: deviceGaps(m.id),
		rejected: rejected.map((r) => ({ id: r.id, reason: r.reason, deviceId: r.deviceId, receivedAt: r.receivedAt, raw: r.raw }))
	};
}

function parseReplacement(f: FormData): ScoringBody | string {
	const type = String(f.get('rtype'));
	const tossup = Number(f.get('tossup'));
	const tiebreaker = f.get('tiebreaker') === 'on';
	if (!Number.isInteger(tossup) || tossup < 1 || tossup > 99) return 'Enter a tossup number.';
	const side = String(f.get('side'));
	if (type === 'tossup_dead') return { type, tossup, ...(tiebreaker ? { tiebreaker } : {}) };
	if (side !== 'A' && side !== 'B') return 'Choose the team.';
	if (type === 'tossup_answer') {
		const playerId = String(f.get('playerId') ?? '') || null;
		return {
			type,
			tossup,
			...(tiebreaker ? { tiebreaker } : {}),
			side,
			playerId,
			correct: f.get('correct') === 'yes',
			...(f.get('interrupt') === 'on' ? { interrupt: true } : {}),
			...(f.get('power') === 'on' ? { power: true } : {})
		};
	}
	if (type === 'bonus') {
		const value = parsePoints(String(f.get('value') ?? ''));
		if (value === null || value <= 0) return 'Enter the bonus value.';
		const n = Number(f.get('parts'));
		if (!Number.isInteger(n) || n < 1 || n > 10) return 'Enter the number of parts (1–10).';
		const parts: BonusPart[] = Array.from({ length: n }, (_, i) => {
			const v = String(f.get(`part${i}`) ?? 'incorrect');
			return v === 'correct' || v === 'bounceback' ? v : 'incorrect';
		});
		return { type, tossup, side, value, parts };
	}
	return 'Choose what kind of entry this is.';
}

const reasonOf = (f: FormData) => String(f.get('reason') ?? '').trim();

export const actions = {
	approve: async ({ locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const m = matchRow(eventId, Number(params.matchId));
		const st = computeRound(matchEvents(m.id), rulesForMatch(m, eventId).settings).status;
		if (st !== 'submitted') return fail(400, { error: 'Only a submitted round can be approved.' });
		const r = staffEvent(user, eventId, m.id, { type: 'approved' });
		return r.status === 'accepted' ? { message: 'Approved.' } : fail(400, { error: `Not saved (${r.reason}).` });
	},
	unapprove: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const reason = reasonOf(await request.formData());
		if (!reason) return fail(400, { error: 'A reason is required.' });
		const r = staffEvent(user, eventId, Number(params.matchId), { type: 'unapproved', reason });
		return r.status === 'accepted' ? { message: 'Approval withdrawn.' } : fail(400, { error: `Not saved (${r.reason}).` });
	},
	returnToRoom: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const reason = reasonOf(await request.formData());
		if (!reason) return fail(400, { error: 'A reason is required.' });
		const m = matchRow(eventId, Number(params.matchId));
		const res = computeRound(matchEvents(m.id), rulesForMatch(m, eventId).settings);
		const submitted = [...res.audit].reverse().find((a) => a.active && a.event.body.type === 'submitted');
		if (!submitted) return fail(400, { error: 'This round has not been submitted.' });
		const r = staffEvent(user, eventId, m.id, { type: 'correction', action: 'void', target: submitted.event.id, reason: `Returned to the room: ${reason}` });
		return r.status === 'accepted' ? { message: 'Returned to the room. The scorer can edit and submit again.' } : fail(400, { error: `Not saved (${r.reason}).` });
	},
	void: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const f = await request.formData();
		const reason = reasonOf(f);
		if (!reason) return fail(400, { error: 'A reason is required for every correction.' });
		const r = staffEvent(user, eventId, Number(params.matchId), { type: 'correction', action: 'void', target: String(f.get('target')), reason });
		return r.status === 'accepted' ? { message: 'Entry voided.' } : fail(400, { error: `Not saved (${r.reason}).` });
	},
	amend: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const f = await request.formData();
		const reason = reasonOf(f);
		if (!reason) return fail(400, { error: 'A reason is required for every correction.' });
		const replacement = parseReplacement(f);
		if (typeof replacement === 'string') return fail(400, { error: replacement });
		const target = String(f.get('target') ?? '');
		const body = target
			? ({ type: 'correction', action: 'amend', target, replacement, reason } as const)
			: ({ type: 'correction', action: 'add', replacement, reason } as const);
		const r = staffEvent(user, eventId, Number(params.matchId), body);
		return r.status === 'accepted' ? { message: target ? 'Entry corrected.' : 'Entry added.' } : fail(400, { error: `Not saved (${r.reason}).` });
	},
	note: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const text = String((await request.formData()).get('text') ?? '').trim();
		if (!text) return fail(400, { error: 'Write the note first.' });
		const r = staffEvent(user, eventId, Number(params.matchId), { type: 'note', text });
		return r.status === 'accepted' ? { message: 'Note added.' } : fail(400, { error: `Not saved (${r.reason}).` });
	}
};
