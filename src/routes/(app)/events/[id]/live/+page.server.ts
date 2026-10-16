import { computeRound } from '$lib/engine';
import { audit } from '$lib/server/audit';
import { publish } from '$lib/server/bus';
import { getDb, schema } from '$lib/server/db';
import { eventIdParam, listSessions } from '$lib/server/events';
import { requireAdmin, requireEventRole } from '$lib/server/guard';
import { matchEvents, rulesForMatch } from '$lib/server/ingest';
import { computeLive, roomHealth } from '$lib/server/live';
import { roomPending } from '$lib/server/presence';
import { sessionRooms } from '$lib/server/schedule';
import { staffEvent } from '$lib/server/staff-actions';
import { fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

export function load({ locals, params, url, depends }) {
	depends('app:live');
	const eventId = eventIdParam(params);
	requireEventRole(locals.auth, eventId, ['head_scorekeeper'], url);
	const sessions = listSessions(eventId);
	const sessionId = Number(url.searchParams.get('session')) || sessions[0]?.id;
	if (!sessionId) return { sessionId: null };
	const live = computeLive(eventId, { sessionIds: [sessionId] });
	const session = live.sessions[0];
	const teamName = (id: string | number) => live.teams.find((t) => t.id === String(id))?.name ?? '?';
	const rooms = sessionRooms(sessionId).map((r) => {
		const row = live.rooms.find((x) => x.id === r.id)!;
		const ms = live.matches.filter((m) => m.roomId === r.id).sort((a, b) => a.roundNo - b.roundNo);
		const current = ms.find((m) => m.result.status === 'in_progress' || m.result.status === 'ended') ?? ms.find((m) => m.result.status === 'submitted') ?? ms.find((m) => m.result.status === 'not_started');
		return {
			id: r.id,
			name: r.name,
			health: roomHealth(row.lastHeardAt),
			lastHeardAt: row.lastHeardAt,
			hasDevice: !!row.activeDeviceId,
			pending: roomPending(r.id),
			current: current ? { id: current.id, roundNo: current.roundNo } : null
		};
	});
	const matches = live.matches.map((m) => ({
		id: m.id,
		roundNo: m.roundNo,
		roomId: m.roomId,
		teamA: teamName(m.teamA),
		teamB: teamName(m.teamB),
		counts: m.counts,
		status: m.result.status,
		scoreA: m.result.teams.A.roundScore,
		scoreB: m.result.teams.B.roundScore,
		tossup: m.result.currentTossup,
		winner: m.result.winner,
		flagCount: m.result.flags.length + m.gaps.length + (m.rejected ? 1 : 0)
	}));
	const toRows = (g: (typeof live.provisional.classifications)[number]) => ({
		key: g.key,
		label: g.label,
		soleTeam: g.soleTeam,
		rows: g.rows.map((r) => ({
			teamId: r.teamId,
			name: teamName(r.teamId),
			place: r.place,
			tied: r.tied,
			resolved: 'resolved' in r ? (r.resolved as string | undefined) : undefined,
			wins: r.record.wins,
			losses: r.record.losses,
			ties: r.record.ties,
			played: r.record.played,
			points: r.record.totalPoints
		}))
	});
	return {
		sessionId,
		session,
		rooms,
		matches,
		roundCount: session.roundCount,
		classStandings: live.provisional.classifications.map(toRows),
		poolStandings: live.provisional.pools.map((g) => toRows(g as never)),
		individuals: live.provisional.individuals.map((g) => ({
			key: g.key,
			label: g.label,
			rows: g.rows.slice(0, 15).map((r) => ({
				playerId: r.playerId,
				name: live.playerNames[r.playerId] ?? 'Unknown',
				team: teamName(r.teamId),
				place: r.place,
				tied: r.tied,
				resolved: (r as { resolved?: string }).resolved,
				total: r.total,
				corrects: r.corrects,
				games: r.games
			}))
		})),
		flags: live.flags,
		individualPlaces: live.rules.awards.individualPlaces,
		teamPlaces: live.rules.awards.teamPlaces,
		pendingCounting: live.provisional.pendingMatchIds.length,
		unapprovedCounting: live.matches.filter((m) => m.counts && m.result.status !== 'approved').length,
		teamNames: Object.fromEntries(live.teams.map((t) => [t.id, t.name])),
		playerNames: live.playerNames
	};
}

export const actions = {
	approve: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const matchId = Number((await request.formData()).get('matchId'));
		const m = getDb().select().from(schema.matches).where(eq(schema.matches.id, matchId)).get();
		if (!m) return fail(404, { error: 'Round not found.' });
		const st = computeRound(matchEvents(matchId), rulesForMatch(m, eventId).settings).status;
		if (st !== 'submitted') return fail(400, { error: 'Only submitted rounds can be approved.' });
		const res = staffEvent(user, eventId, matchId, { type: 'approved' });
		if (res.status !== 'accepted') return fail(400, { error: `Could not approve (${res.reason}).` });
		return { message: 'Round approved.' };
	},

	finalize: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		const live = computeLive(eventId, { sessionIds: [sessionId] });
		const notApproved = live.matches.filter((m) => m.counts && m.result.status !== 'approved');
		if (notApproved.length) return fail(400, { error: `${notApproved.length} counting round(s) are not approved yet.` });
		const openTies = live.flags.filter((x) => x.tie);
		if (openTies.length) return fail(400, { error: 'Resolve the ties at award places before finalizing.' });
		getDb().update(schema.sessions).set({ finalizedAt: new Date().toISOString(), finalizedBy: user.name }).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.eventId, eventId))).run();
		audit(`user:${user.id}`, 'session_finalized', { sessionId }, eventId);
		publish({ type: 'session', eventId, sessionId });
		return { message: 'Session finalized. Results are locked for awards.' };
	},

	reopen: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const admin = requireAdmin(locals.auth);
		const f = await request.formData();
		const sessionId = Number(f.get('sessionId'));
		const reason = String(f.get('reason') ?? '').trim();
		if (!reason) return fail(400, { error: 'Give a reason for reopening.' });
		getDb().update(schema.sessions).set({ finalizedAt: null, finalizedBy: null }).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.eventId, eventId))).run();
		audit(`user:${admin.id}`, 'session_reopened', { sessionId, reason }, eventId);
		publish({ type: 'session', eventId, sessionId });
		return { message: 'Session reopened.' };
	},

	resolveTie: async ({ request, locals, params }) => {
		const eventId = eventIdParam(params);
		const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
		const f = await request.formData();
		const kind = String(f.get('kind')) as 'team' | 'individual';
		const groupKey = String(f.get('groupKey'));
		const ordered = String(f.get('ordered') ?? '').split(',').filter(Boolean);
		const note = String(f.get('note') ?? '').trim();
		if (!['team', 'individual'].includes(kind) || ordered.length < 2) return fail(400, { error: 'Choose the order of the tied entries.' });
		if (!note) return fail(400, { error: 'Explain how the tie was broken (for example, "won a tiebreaker question").' });
		getDb().insert(schema.tieResolutions).values({ eventId, kind, groupKey, ordered, note, decidedBy: user.name }).run();
		audit(`user:${user.id}`, 'tie_resolved', { kind, groupKey, ordered, note }, eventId);
		publish({ type: 'session', eventId });
		return { message: 'Tie resolution recorded.' };
	}
};
