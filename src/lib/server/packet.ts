import { CONFIRM_ITEMS, divisionOf, formatOf, isFinalStatus, type RuleSettings, type StandingsCriterion } from '$lib/engine';
import { formatPoints } from '$lib/engine/points';
import { error } from '@sveltejs/kit';
import JSZip from 'jszip';
import { currentRuleVersion, listSessions } from './events';
import { buildWorkbook } from './excel';
import { computeLive, type Live } from './live';

/**
 * The review packet: one .zip with the PDFs and the Excel workbook staff use to double-check
 * results, plus a generated Read me. PDFs are rendered from the app's own report pages, so
 * provisional sessions carry the same PROVISIONAL labels as on screen.
 */

type Session = ReturnType<typeof listSessions>[number];

export interface PacketItem {
	/** File name inside the zip. */
	name: string;
	about: string;
	/** A page rendered to PDF; files made here (Read me, Excel) have none. */
	page?: { path: string; landscape: boolean };
}

const ascii = (s: string) =>
	s
		.normalize('NFKD')
		.replace(/[\u2010-\u2015\u2212]/g, '-')
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[^\x20-\x7e]/g, '');

/** Part of a file name that opens cleanly on Windows and macOS (plain ASCII, no reserved characters). */
export function fileSafe(s: string, fallback: string) {
	const out = ascii(s)
		.replace(/[<>:"/\\|?*]+/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.-]+|[\s.]+$/g, '')
		.slice(0, 40)
		.trim();
	return out || fallback;
}

/** Every file in the packet, in order: Read me, awards, each session's results, scoresheets and schedule, then Excel. */
export function packetPlan(eventId: number, sessions: Pick<Session, 'id' | 'name' | 'finalizedAt' | 'scheduleStatus'>[]): PacketItem[] {
	const base = `/events/${eventId}`;
	const anyProvisional = sessions.some((s) => !s.finalizedAt) ? ' (PROVISIONAL)' : '';
	const files: (Omit<PacketItem, 'name'> & { title: string })[] = [
		{ title: 'Read me.txt', about: 'This file.' },
		{ title: `Awards sheet - all sessions${anyProvisional}.pdf`, about: 'Team and individual award places, one page per session.', page: { path: `${base}/reports/awards`, landscape: false } }
	];
	const used = new Set<string>();
	sessions.forEach((s, i) => {
		const safe = fileSafe(s.name, `Session ${i + 1}`);
		let n = safe;
		for (let k = 2; used.has(n.toLowerCase()); k++) n = `${safe} (${k})`;
		used.add(n.toLowerCase());
		const prov = s.finalizedAt ? '' : ' (PROVISIONAL)';
		files.push(
			{ title: `${n} - full results${prov}.pdf`, about: `${s.name}: standings by award division and pool, every game, and individual standings.`, page: { path: `${base}/reports/results?session=${s.id}`, landscape: false } },
			{ title: `${n} - completed scoresheets${prov}.pdf`, about: `${s.name}: the scoresheet of every game that has been scored.`, page: { path: `${base}/reports/scoresheets?session=${s.id}`, landscape: false } },
			{ title: `${n} - schedule${s.scheduleStatus === 'published' ? '' : ' (DRAFT)'}.pdf`, about: `${s.name}: the schedule printout (rounds by room).`, page: { path: `${base}/schedule/print?session=${s.id}`, landscape: true } }
		);
	});
	files.push({ title: `Excel workbook${anyProvisional}.xlsx`, about: "Team results per award division with each round's score, individuals, every game, and the full scoring log." });
	return files.map(({ title, ...f }, i) => ({ name: `${String(i).padStart(2, '0')} ${title}`, ...f }));
}

const central = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleString('en-US', { timeZone: 'America/Chicago', ...opts });
const longDate = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const clock = (hhmm: string) => {
	const [h, m] = hhmm.split(':').map(Number);
	return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The scoring rules in plain words. */
export function rulesSummary(rules: RuleSettings, classifications: string[]): string[] {
	const pts = (h: number) => `${formatPoints(h)} points`;
	const yes = (b: boolean) => (b ? 'yes' : 'no');
	const rounding = { exact: 'kept exact (e.g. 12.5)', half_up: 'rounded to whole points, halves up', down: 'rounded down to whole points' }[rules.bonus.rounding];
	const criteria: Record<StandingsCriterion, string> = { winPct: 'win/loss ratio', roundsWon: 'most rounds won', totalPoints: 'total points (counting games)', headToHead: 'head-to-head among tied teams' };
	const grouping = { division: 'by award division', classification: 'by classification', session: 'by session', overall: 'across the whole event' }[rules.awards.individualGrouping];
	const divisions = new Map<string, string[]>();
	for (const c of classifications) divisions.set(divisionOf(rules, c), [...(divisions.get(divisionOf(rules, c)) ?? []), c]);
	const formats = [...divisions.keys()].map((d) => [d, formatOf(rules, d)] as const);
	const format = formats.map(([d, f]) =>
		f.type === 'bracket'
			? `${d}: ${plural(f.seedingRounds, 'pool-play round')} seed ${f.bracketSize === 8 ? 'an' : 'a'} ${f.bracketSize}-team bracket (${f.seeding === 'poolWinnersFirst' ? 'pool winners seeded first' : 'seeded by standings'}; ${f.thirdPlaceGame ? 'with a' : 'no'} 3rd-place game; bracket games count for individuals: ${yes(f.bracketCountsForIndividuals)})`
			: `${d}: round robin`
	);
	return [
		`Tossups: ${pts(rules.tossupPoints)}. Powers: ${rules.power.enabled ? pts(rules.power.points) : 'no'}. Negs: ${rules.neg.enabled ? `minus ${pts(rules.neg.points)}${rules.neg.onlyOnInterrupt ? ', only on an interrupt' : ''}` : 'no'}.`,
		`Bonuses: ${rules.individual.includeBonus ? 'team points, also credited to the player who answered the tossup' : 'team points only; individual scores count tossups only'}. Partial credit is proportional per part, ${rounding}. Bouncebacks: ${yes(rules.bonus.bounceback)}.`,
		`Tiebreakers: a round that ends tied goes to sudden-death tossups. Tiebreaker points count toward the round score: ${yes(rules.tiebreaker.countsInRoundScore)}; toward total points in standings: ${yes(rules.tiebreaker.countsInTotalPoints)}; toward individual totals: ${yes(rules.individual.includeTiebreaker)}.`,
		'Forfeits: a win for the opponent; no points for either team.',
		`Standings: ${rules.standings.order.map((c) => criteria[c]).join(', then ')}. Non-counter games never count.`,
		`Rounds: up to ${rules.round.maxTossups} tossups, ${rules.round.timeLimitMinutes}-minute limit, minimum tossups: ${rules.round.minTossups ?? 'none'}.`,
		`Awards: ${plural(rules.awards.teamPlaces, 'team place')} per award division; ${rules.awards.classPlaces ? `${plural(rules.awards.classPlaces, 'place')} in each classification, ordered by the division's final places; ` : ''}${plural(rules.awards.individualPlaces, 'individual place')}, grouped ${grouping}. Ties at award places are decided by the head scorekeeper, with a recorded reason.`,
		`Award divisions: ${[...divisions].map(([d, cs]) => (cs.length === 1 && cs[0] === d ? d : `${d} (${cs.join(', ')})`)).join('; ')}.`,
		`Format: ${format.join('; ')}.${formats.some(([, f]) => f.type === 'bracket') ? ` Bracket seeding: ${rules.format.seedingOrder.map((c) => criteria[c]).join(', then ')}.` : ''}`
	];
}

export interface ReadmeInput {
	live: Live;
	ruleVersion: number;
	items: PacketItem[];
	/** Names of files that could not be made. */
	missing: string[];
	madeAt: Date;
	madeBy: string;
}

/** The packet's Read me: event, sessions, files, rules, and anything still open. */
export function packetReadme({ live, ruleVersion, items, missing, madeAt, madeBy }: ReadmeInput): string {
	const { event, rules } = live;
	const finalCount = live.sessions.filter((s) => s.finalizedAt).length;
	const out: string[] = [
		"SUSCC SCHOLARS' BOWL - REVIEW PACKET",
		'',
		`Event:        ${event.name}${event.isTest ? ' (PRACTICE / TEST EVENT)' : ''}`,
		`Event date:   ${longDate(event.eventDate)}`,
		`Packet made:  ${central(madeAt, { dateStyle: 'long', timeStyle: 'short' })} Central, by ${madeBy}`,
		`Results:      ${finalCount === live.sessions.length ? 'FINAL - every session is finalized.' : `PROVISIONAL - ${live.sessions.length - finalCount} of ${plural(live.sessions.length, 'session')} not finalized. Results can still change.`}`
	];
	if (missing.length) out.push('', `WARNING: ${plural(missing.length, 'file')} could not be made (marked MISSING below). Download them from the Reports page.`);

	out.push('', 'SESSIONS');
	for (const s of live.sessions) {
		const games = live.matches.filter((m) => m.sessionId === s.id);
		const counting = games.filter((m) => m.counts);
		const done = counting.filter((m) => isFinalStatus(m.result.status)).length;
		const status = s.finalizedAt ? `FINAL, finalized by ${s.finalizedBy ?? 'unknown'} on ${central(new Date(s.finalizedAt), { dateStyle: 'medium', timeStyle: 'short' })}` : 'PROVISIONAL, not finalized';
		out.push(`- ${s.name}: ${longDate(s.date)}, arrival ${clock(s.startTime)}, ${plural(s.roundCount, 'round')}. ${status}.`);
		out.push(`  ${done} of ${counting.length} counting games approved or forfeited${games.length > counting.length ? `; ${plural(games.length - counting.length, 'non-counter game')}` : ''}. Schedule ${s.scheduleStatus === 'published' ? 'published' : 'NOT published (draft)'}.`);
	}

	out.push('', 'FILES');
	const width = Math.max(...items.map((i) => i.name.length));
	for (const i of items) out.push(`${i.name.padEnd(width)}  ${missing.includes(i.name) ? 'MISSING - could not be made. ' : ''}${i.about}`);

	out.push('', `SCORING RULES (settings version ${ruleVersion})`, ...rulesSummary(rules, event.classifications).map((l) => `- ${l}`));
	const older = [...new Set(live.matches.map((m) => m.ruleVersion).filter((v): v is number => v !== null && v !== ruleVersion))].sort((a, b) => a - b);
	if (older.length) out.push(`- Some games were scored under earlier settings: version ${older.join(', ')} (see the Games sheet in the workbook).`);
	const unconfirmed = CONFIRM_ITEMS.filter((c) => !event.confirmations[c.key]);
	out.push(`- Settings confirmed before the event: ${CONFIRM_ITEMS.length - unconfirmed.length} of ${CONFIRM_ITEMS.length}.${unconfirmed.length ? ` Not confirmed: ${unconfirmed.map((c) => c.label.replace(/\.$/, '')).join('; ')}.` : ''}`);

	const rank = { error: 0, warning: 1, info: 2 };
	const teamName = (id: string) => live.teams.find((t) => t.id === id)?.name ?? '?';
	const playerTeam = new Map(live.provisional.individuals.flatMap((g) => g.rows.map((r) => [r.playerId, r.teamId] as const)));
	const who = (tie: NonNullable<Live['flags'][number]['tie']>) =>
		tie.ids.map((id) => (tie.kind === 'team' ? teamName(id) : `${live.playerNames[id] ?? 'Unknown'} (${teamName(playerTeam.get(id) ?? '')})`)).join(', ');
	const tag = (f: Live['flags'][number]) => (f.tie ? 'TIE - NEEDS A DECISION' : { error: 'PROBLEM', warning: 'CHECK', info: 'NOTE' }[f.level]);
	// The same note can come from a pool and a division; list it once.
	const unique = (lines: string[]) => [...new Set(lines)];
	const open = unique(
		live.flags
			.filter((f) => !f.kind.endsWith('_resolved'))
			.sort((a, b) => rank[a.level] - rank[b.level])
			.map((f) => `- [${tag(f)}] ${f.message}${f.tie ? `. Tied: ${who(f.tie)}` : ''}`)
	);
	const resolved = unique(live.flags.filter((f) => f.kind.endsWith('_resolved')).map((f) => `- ${f.message}`));
	out.push('', `OPEN FLAGS AND TIES (${open.length})`, ...(open.length ? open : ['None.']));
	if (resolved.length) out.push('', `TIES DECIDED BY THE HEAD SCOREKEEPER (${resolved.length})`, ...resolved);

	out.push(
		'',
		'HOW TO CHECK',
		"- A team's points equal the sum of its scores in counting games; the division sheets in the workbook show each round's score.",
		'- Tiebreaker points decide a game but are not added to totals unless the rules above say so.',
		'- Each scoresheet shows every tossup and bonus as scored. The Event log sheet in the workbook shows every entry and correction, with who made it and when.'
	);
	// Notepad and TextEdit both open UTF-8 with a byte-order mark and Windows line endings.
	return `\uFEFF${out.join('\r\n')}\r\n`;
}

/** Clock time in Central, for the file dates inside the zip (zip dates have no time zone; JSZip writes UTC fields). */
function centralWallClock(d: Date) {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
			.formatToParts(d)
			.map((x) => [x.type, Number(x.value)])
	);
	return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

let building = false;

/**
 * Build the review packet. `render` turns one page into a PDF; pages are rendered one at a time
 * so the server's two CPUs aren't swamped. Only one packet is built at a time.
 * A page that fails is left out and marked MISSING in the Read me rather than failing the packet.
 */
export async function buildReviewPacket(eventId: number, opts: { render: (path: string, landscape: boolean) => Promise<Uint8Array>; madeBy: string; now?: Date }) {
	if (building) error(429, 'A review packet is already being made. Try again in a minute.');
	building = true;
	try {
		const madeAt = opts.now ?? new Date();
		const live = computeLive(eventId);
		const items = packetPlan(eventId, listSessions(eventId));
		const content = new Map<string, Uint8Array | ArrayBuffer | string>();
		const missing: string[] = [];
		for (const item of items.filter((i) => i.page)) {
			try {
				content.set(item.name, await opts.render(item.page!.path, item.page!.landscape));
			} catch (e) {
				console.error('[packet]', item.name, e);
				missing.push(item.name);
			}
		}
		content.set(items[items.length - 1].name, await buildWorkbook(eventId));
		content.set(items[0].name, packetReadme({ live, ruleVersion: currentRuleVersion(eventId).version, items, missing, madeAt, madeBy: opts.madeBy }));
		const zip = new JSZip();
		const date = centralWallClock(madeAt);
		for (const item of items) if (content.has(item.name)) zip.file(item.name, content.get(item.name)!, { date });
		const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
		return { bytes, files: items.filter((i) => content.has(i.name)).map((i) => i.name), missing };
	} finally {
		building = false;
	}
}
