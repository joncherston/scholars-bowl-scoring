import { describeEvent } from '$lib/describe';
import { isFinalStatus } from '$lib/engine';
import { formatPoints } from '$lib/engine/points';
import { audit } from '$lib/server/audit';
import { eventIdParam } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { computeLive } from '$lib/server/live';
import { gameScore, groupStandings, reportMode } from '$lib/server/reports';
import ExcelJS from 'exceljs';

const sheetName = (s: string, used: Set<string>) => {
	let base = s.replace(/[[\]:*?/\\]/g, '-').slice(0, 31);
	let name = base;
	for (let i = 2; used.has(name); i++) name = `${base.slice(0, 28)} ${i}`;
	used.add(name);
	return name;
};

/** Everything in one workbook: team results per award division, individuals, games, and the raw log. */
export async function GET({ params, locals }) {
	const eventId = eventIdParam(params);
	const user = requireEventRole(locals.auth, eventId, ['head_scorekeeper']);
	const live = computeLive(eventId);
	const teamName = (id: string | number) => live.teams.find((t) => t.id === String(id))?.name ?? '?';
	const wb = new ExcelJS.Workbook();
	wb.creator = 'SUSCC Scholars Bowl Scoring';
	wb.created = new Date();
	const used = new Set<string>();
	const bold = (ws: ExcelJS.Worksheet) => {
		ws.getRow(1).font = { bold: true };
		ws.views = [{ state: 'frozen', ySplit: 1 }];
	};

	const summary = wb.addWorksheet(sheetName('Summary', used));
	summary.addRows([
		['Event', live.event.name],
		['Date', live.event.eventDate],
		['Practice / test event', live.event.isTest ? 'YES' : 'no'],
		['Exported', new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })],
		[],
		['Session', 'Status', 'Counting rounds approved or forfeited', 'Counting rounds total']
	]);
	for (const s of live.sessions) {
		const counting = live.matches.filter((m) => m.sessionId === s.id && m.counts);
		summary.addRow([s.name, reportMode(live, s.id) === 'final' ? `Final (finalized by ${s.finalizedBy})` : 'PROVISIONAL', counting.filter((m) => isFinalStatus(m.result.status)).length, counting.length]);
	}
	summary.getColumn(1).width = 26;
	summary.getColumn(2).width = 40;

	const sessionNames = (ids: string[]) => ids.map((id) => live.sessions.find((s) => String(s.id) === id)?.name ?? '?').join(' + ');
	// One sheet per award division; a team's points equal the sum of the scores in its counting games.
	for (const pg of live.provisional.divisions) {
		const { st } = groupStandings(live, pg.sessionIds);
		const g = st.divisions.find((x) => x.key === pg.key) ?? pg;
		const roundCount = Math.max(1, ...live.sessions.filter((s) => g.sessionIds.includes(String(s.id))).map((s) => s.roundCount));
		const ws = wb.addWorksheet(sheetName(`${sessionNames(g.sessionIds)} ${g.label}`, used));
		ws.addRow(['Place', 'Team', 'Classification', ...Array.from({ length: roundCount }, (_, i) => `Round ${i + 1}`), 'Wins', 'Losses', 'Points', 'Note']);
		for (const r of g.rows) {
			const t = live.teams.find((x) => x.id === r.teamId);
			const cells = Array.from({ length: roundCount }, (_, i) => {
				const m = live.matches.find((x) => String(x.sessionId) === t?.sessionId && x.roundNo === i + 1 && (String(x.teamA) === r.teamId || String(x.teamB) === r.teamId));
				if (!m) return 'bye';
				const side = String(m.teamA) === r.teamId ? 'A' : 'B';
				const opp = teamName(side === 'A' ? m.teamB : m.teamA);
				if (m.result.status === 'not_started') return `vs ${opp}`;
				const sc = gameScore(m.result, side);
				if (sc.text) return `${m.counts ? '' : 'NC '}${sc.text} vs ${opp}`;
				const wl = m.result.winner === side ? 'W' : m.result.winner ? 'L' : 'T';
				return `${m.counts ? '' : 'NC '}${wl} ${formatPoints(sc.mine)}–${formatPoints(sc.theirs)} vs ${opp}${sc.note ? ` (${sc.note})` : ''}${m.result.status === 'approved' ? '' : ` (${m.result.status})`}`;
			});
			const resolved = (r as { resolved?: string }).resolved;
			ws.addRow([r.place, teamName(r.teamId), t?.classification ?? '', ...cells, r.record.wins, r.record.losses, Number(formatPoints(r.record.totalPoints)), [r.tied ? 'tied' : '', resolved ? `tie decided: ${resolved}` : '', g.soleTeam ? 'only team in division' : '', t?.withdrawn ? 'withdrawn' : ''].filter(Boolean).join('; ')]);
		}
		bold(ws);
		ws.getColumn(2).width = 30;
		for (let i = 4; i < 4 + roundCount; i++) ws.getColumn(i).width = 34;
	}

	const ind = wb.addWorksheet(sheetName('Individuals', used));
	ind.addRow(['Session', 'Group', 'Place', 'Player', 'Team', 'Games', 'Tossups correct', 'Negs', 'Tossup points', 'Individual total', 'Tied']);
	for (const pg of live.provisional.individuals) {
		const g = groupStandings(live, pg.sessionIds).st.individuals.find((x) => x.key === pg.key) ?? pg;
		for (const r of g.rows)
			ind.addRow([sessionNames(g.sessionIds), g.label, r.place, live.playerNames[r.playerId] ?? 'Unknown', teamName(r.teamId), r.games, r.corrects, r.negs, Number(formatPoints(r.tossupPoints)), Number(formatPoints(r.total)), r.tied ? 'yes' : '']);
	}
	bold(ind);
	ind.getColumn(4).width = 26;
	ind.getColumn(5).width = 30;

	const games = wb.addWorksheet(sheetName('Games', used));
	games.addRow(['Session', 'Round', 'Room', 'Team A', 'Team B', 'Counts', 'Status', 'Score A', 'Score B', 'Winner', 'Tiebreaker', 'End reason', 'Settings version', 'Flags']);
	for (const m of live.matches) {
		const s = live.sessions.find((x) => x.id === m.sessionId)!;
		games.addRow([
			s.name,
			m.roundNo,
			m.roomName,
			teamName(m.teamA),
			teamName(m.teamB),
			m.counts ? 'yes' : 'non-counter',
			m.result.status,
			Number(formatPoints(gameScore(m.result, 'A').mine)),
			Number(formatPoints(gameScore(m.result, 'B').mine)),
			m.result.winner ? teamName(m.result.winner === 'A' ? m.teamA : m.teamB) : '',
			m.result.decidedByTiebreaker ? 'yes' : '',
			m.result.endReason ?? '',
			m.ruleVersion ?? '',
			m.result.flags.map((f) => f.message).join(' | ')
		]);
	}
	bold(games);
	games.getColumn(4).width = 28;
	games.getColumn(5).width = 28;

	const log = wb.addWorksheet(sheetName('Event log', used));
	log.addRow(['Session', 'Round', 'Room', 'Seq', 'Server time (UTC)', 'Client time', 'By', 'Device', 'Device seq', 'Type', 'Description', 'Active', 'Voided by', 'Raw']);
	for (const m of live.matches) {
		const s = live.sessions.find((x) => x.id === m.sessionId)!;
		const names = (id: string | null) => (id ? (live.playerNames[id] ?? 'Unknown') : 'Team');
		for (const a of m.result.audit)
			log.addRow([
				s.name,
				m.roundNo,
				m.roomName,
				a.event.seq,
				a.event.serverTs ?? '',
				a.event.clientTs ?? '',
				a.event.actorName ?? a.event.actor,
				a.event.deviceId ?? '',
				a.event.deviceSeq ?? '',
				a.event.body.type,
				describeEvent(a.event.body, names, { A: teamName(m.teamA), B: teamName(m.teamB) }),
				a.active ? 'yes' : 'no',
				a.voidedBy ? `${a.voidedBy.actorName ?? a.voidedBy.actor} (#${a.voidedBy.seq})` : '',
				JSON.stringify(a.event.body)
			]);
	}
	bold(log);
	log.getColumn(11).width = 70;

	const buf = await wb.xlsx.writeBuffer();
	audit(`user:${user.id}`, 'excel_exported', null, eventId);
	const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
	return new Response(buf as ArrayBuffer, {
		headers: {
			'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'Content-Disposition': `attachment; filename="scholars-bowl-${eventId}-${stamp}.xlsx"`,
			'Cache-Control': 'no-store'
		}
	});
}
