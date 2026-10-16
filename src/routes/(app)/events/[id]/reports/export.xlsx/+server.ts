import { describeEvent } from '$lib/describe';
import { formatPoints } from '$lib/engine/points';
import { audit } from '$lib/server/audit';
import { eventIdParam } from '$lib/server/events';
import { requireEventRole } from '$lib/server/guard';
import { computeLive } from '$lib/server/live';
import { reportMode } from '$lib/server/reports';
import ExcelJS from 'exceljs';

const sheetName = (s: string, used: Set<string>) => {
	let base = s.replace(/[[\]:*?/\\]/g, '-').slice(0, 31);
	let name = base;
	for (let i = 2; used.has(name); i++) name = `${base.slice(0, 28)} ${i}`;
	used.add(name);
	return name;
};

/** Everything in one workbook: team results per classification, individuals, games, and the raw log. */
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
		['Session', 'Status', 'Counting rounds approved', 'Counting rounds total']
	]);
	for (const s of live.sessions) {
		const counting = live.matches.filter((m) => m.sessionId === s.id && m.counts);
		summary.addRow([s.name, reportMode(live, s.id) === 'final' ? `Final (finalized by ${s.finalizedBy})` : 'PROVISIONAL', counting.filter((m) => m.result.status === 'approved').length, counting.length]);
	}
	summary.getColumn(1).width = 26;
	summary.getColumn(2).width = 40;

	for (const s of live.sessions) {
		const st = reportMode(live, s.id) === 'final' ? live.final : live.provisional;
		const sessMatches = live.matches.filter((m) => m.sessionId === s.id);
		for (const g of st.classifications.filter((x) => x.sessionId === String(s.id))) {
			const ws = wb.addWorksheet(sheetName(`${s.name} ${g.label}`, used));
			const header = ['Place', 'Team', ...Array.from({ length: s.roundCount }, (_, i) => `Round ${i + 1}`), 'Wins', 'Losses', 'Points', 'Note'];
			ws.addRow(header);
			for (const r of g.rows) {
				const cells = Array.from({ length: s.roundCount }, (_, i) => {
					const m = sessMatches.find((x) => x.roundNo === i + 1 && (String(x.teamA) === r.teamId || String(x.teamB) === r.teamId));
					if (!m) return 'bye';
					const side = String(m.teamA) === r.teamId ? 'A' : 'B';
					const opp = teamName(side === 'A' ? m.teamB : m.teamA);
					if (m.result.status === 'not_started') return `vs ${opp}`;
					const mine = m.result.teams[side].roundScore;
					const theirs = m.result.teams[side === 'A' ? 'B' : 'A'].roundScore;
					const wl = m.result.winner === side ? 'W' : m.result.winner ? 'L' : 'T';
					return `${m.counts ? '' : 'NC '}${wl} ${formatPoints(mine)}–${formatPoints(theirs)} vs ${opp}${m.result.status === 'approved' ? '' : ` (${m.result.status})`}`;
				});
				ws.addRow([r.place, teamName(r.teamId), ...cells, r.record.wins, r.record.losses, Number(formatPoints(r.record.totalPoints)), [r.tied ? 'tied' : '', (r as { resolved?: string }).resolved ? `tie decided: ${(r as { resolved?: string }).resolved}` : '', g.soleTeam ? 'only team in classification' : ''].filter(Boolean).join('; ')]);
			}
			bold(ws);
			ws.getColumn(2).width = 30;
			for (let i = 3; i < 3 + s.roundCount; i++) ws.getColumn(i).width = 34;
		}
	}

	const ind = wb.addWorksheet(sheetName('Individuals', used));
	ind.addRow(['Session', 'Group', 'Place', 'Player', 'Team', 'Games', 'Tossups correct', 'Negs', 'Tossup points', 'Individual total', 'Tied']);
	for (const s of live.sessions) {
		const st = reportMode(live, s.id) === 'final' ? live.final : live.provisional;
		for (const g of st.individuals.filter((x) => x.sessionId === String(s.id) || x.sessionId === null))
			for (const r of g.rows)
				ind.addRow([s.name, g.label, r.place, live.playerNames[r.playerId] ?? 'Unknown', teamName(r.teamId), r.games, r.corrects, r.negs, Number(formatPoints(r.tossupPoints)), Number(formatPoints(r.total)), r.tied ? 'yes' : '']);
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
			Number(formatPoints(m.result.teams.A.roundScore)),
			Number(formatPoints(m.result.teams.B.roundScore)),
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
