/**
 * Schedule generation and validation. Pure functions shared by the server
 * (draft generator, checks on save) and the browser (live grid warnings).
 */

export interface SchedTeam {
	id: number;
	name: string;
	schoolId: number;
	classification: string;
	poolKey: string;
	withdrawn?: boolean;
}

export interface SchedRoom {
	id: number;
	name: string;
}

export interface SchedMatch {
	id?: number;
	roundNo: number;
	roomId: number;
	teamA: number;
	teamB: number;
	counts: boolean;
	poolKey?: string | null;
	/** Scoring has started; the match cannot be moved or deleted. */
	locked?: boolean;
}

export interface PoolDef {
	key: string;
	name: string;
	teamIds: number[];
}

type Pair = [number, number | null];

/** Circle-method round robin. Odd counts get a bye (null opponent) each round. */
export function roundRobin(ids: number[]): Pair[][] {
	if (ids.length === 0) return [];
	const list: (number | null)[] = [...ids];
	if (list.length % 2) list.push(null);
	const n = list.length;
	const rounds: Pair[][] = [];
	for (let r = 0; r < n - 1; r++) {
		const pairs: Pair[] = [];
		for (let i = 0; i < n / 2; i++) {
			const a = list[i];
			const b = list[n - 1 - i];
			if (a === null) pairs.push([b as number, null]);
			else if (b === null) pairs.push([a, null]);
			else pairs.push(r % 2 === 0 || i > 0 ? [a, b] : [b, a]);
		}
		rounds.push(pairs);
		// Keep the first entry fixed and rotate the rest.
		list.splice(1, 0, list.pop()!);
	}
	return rounds;
}

export interface GenerateInput {
	pools: PoolDef[];
	teams: SchedTeam[];
	rooms: SchedRoom[];
	rounds: number;
	fillByesWithNonCounters: boolean;
}

export interface GenerateResult {
	matches: SchedMatch[];
	byes: { roundNo: number; teamId: number }[];
	warnings: string[];
}

export function generateSchedule(input: GenerateInput): GenerateResult {
	const { pools, teams, rooms, rounds } = input;
	const teamById = new Map(teams.map((t) => [t.id, t]));
	const warnings: string[] = [];
	const perRound: { counting: SchedMatch[]; byes: number[] }[] = Array.from({ length: rounds }, () => ({ counting: [], byes: [] }));

	for (const pool of pools) {
		const cycle = roundRobin(pool.teamIds);
		if (!cycle.length) continue;
		for (let r = 0; r < rounds; r++) {
			const pass = Math.floor(r / cycle.length);
			for (const [a, b] of cycle[r % cycle.length]) {
				if (b === null) perRound[r].byes.push(a);
				else {
					const [x, y] = pass % 2 ? [b, a] : [a, b];
					perRound[r].counting.push({ roundNo: r + 1, roomId: 0, teamA: x, teamB: y, counts: true, poolKey: pool.key });
				}
			}
		}
		if (pool.teamIds.length > 2 && rounds < cycle.length)
			warnings.push(`${pool.name}: ${rounds} rounds is not enough for every team to play every other team once (needs ${cycle.length}).`);
		if (pool.teamIds.length === 1)
			warnings.push(`${pool.name}: only one team, so it has no counting games. Consider merging it with another pool.`);
	}

	// Fill byes with cross-pool non-counter games.
	const ncCount = new Map<number, number>();
	const ncPairs = new Set<string>();
	const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
	const allMatches: SchedMatch[] = [];
	const byes: { roundNo: number; teamId: number }[] = [];
	for (let r = 0; r < rounds; r++) {
		const { counting, byes: idle } = perRound[r];
		const nonCounters: SchedMatch[] = [];
		let left = [...idle];
		if (input.fillByesWithNonCounters) {
			left.sort((a, b) => (ncCount.get(a) ?? 0) - (ncCount.get(b) ?? 0));
			const paired = new Set<number>();
			for (const a of left) {
				if (paired.has(a)) continue;
				const options = left.filter((b) => b !== a && !paired.has(b));
				const score = (b: number) =>
					(ncPairs.has(pairKey(a, b)) ? 10 : 0) + (teamById.get(a)?.schoolId === teamById.get(b)?.schoolId ? 5 : 0) + (ncCount.get(b) ?? 0);
				const b = options.sort((x, y) => score(x) - score(y))[0];
				if (b === undefined) continue;
				paired.add(a).add(b);
				ncPairs.add(pairKey(a, b));
				ncCount.set(a, (ncCount.get(a) ?? 0) + 1);
				ncCount.set(b, (ncCount.get(b) ?? 0) + 1);
				nonCounters.push({ roundNo: r + 1, roomId: 0, teamA: a, teamB: b, counts: false, poolKey: null });
			}
			left = left.filter((t) => !paired.has(t));
		}

		const wanted = [...counting, ...nonCounters];
		if (wanted.length > rooms.length) {
			const extraNc = Math.min(nonCounters.length, wanted.length - rooms.length);
			if (extraNc > 0) {
				const dropped = nonCounters.splice(nonCounters.length - extraNc, extraNc);
				for (const m of dropped) left.push(m.teamA, m.teamB);
				warnings.push(`Round ${r + 1}: not enough rooms for every non-counter game; ${extraNc} team pair(s) have a bye instead.`);
			}
		}
		const placed = [...counting, ...nonCounters];
		if (placed.length > rooms.length)
			warnings.push(`Round ${r + 1}: ${placed.length} games but only ${rooms.length} rooms. ${placed.length - rooms.length} counting game(s) were not placed; add rooms or merge pools.`);
		for (const t of left) byes.push({ roundNo: r + 1, teamId: t });
		allMatches.push(...placed.slice(0, rooms.length));
	}

	assignRooms(allMatches, rooms, rounds);
	return { matches: allMatches, byes, warnings };
}

/**
 * Give each game a room, spreading use evenly across rooms and keeping a team
 * in the same room as its previous round when possible (fewer moves between rounds).
 */
function assignRooms(matches: SchedMatch[], rooms: SchedRoom[], rounds: number) {
	const usage = new Map(rooms.map((r) => [r.id, 0]));
	const lastRoom = new Map<number, number>();
	for (let r = 1; r <= rounds; r++) {
		const these = matches.filter((m) => m.roundNo === r).sort((a, b) => Number(b.counts) - Number(a.counts));
		const free = new Set(rooms.map((x) => x.id));
		for (const m of these) {
			const stay = [lastRoom.get(m.teamA), lastRoom.get(m.teamB)].find((id) => id !== undefined && free.has(id));
			const pick = stay ?? [...free].sort((a, b) => usage.get(a)! - usage.get(b)! || rooms.findIndex((x) => x.id === a) - rooms.findIndex((x) => x.id === b))[0];
			m.roomId = pick;
			free.delete(pick);
			usage.set(pick, usage.get(pick)! + 1);
			lastRoom.set(m.teamA, pick);
			lastRoom.set(m.teamB, pick);
		}
	}
}

export interface Issue {
	level: 'error' | 'warning' | 'notice';
	message: string;
	roundNo?: number;
	teamIds?: number[];
	matchIds?: number[];
}

export interface ValidateInput {
	teams: SchedTeam[];
	rooms: SchedRoom[];
	roundCount: number;
	matches: SchedMatch[];
}

/** Errors block publishing; warnings and notices are shown to the bracket builder. */
export function validateSchedule({ teams, rooms, roundCount, matches }: ValidateInput): Issue[] {
	const issues: Issue[] = [];
	const name = (id: number) => teams.find((t) => t.id === id)?.name ?? `Team ${id}`;
	const roomName = (id: number) => rooms.find((r) => r.id === id)?.name ?? `Room ${id}`;
	const teamById = new Map(teams.map((t) => [t.id, t]));
	const ids = (m: SchedMatch) => (m.id !== undefined ? [m.id] : []);

	for (let r = 1; r <= Math.max(roundCount, ...matches.map((m) => m.roundNo)); r++) {
		const these = matches.filter((m) => m.roundNo === r);
		const seenTeam = new Map<number, SchedMatch>();
		const seenRoom = new Map<number, SchedMatch>();
		for (const m of these) {
			if (r > roundCount) issues.push({ level: 'error', message: `Round ${r} is past the session's ${roundCount} rounds.`, roundNo: r, matchIds: ids(m) });
			if (m.teamA === m.teamB) issues.push({ level: 'error', message: `Round ${r}: ${name(m.teamA)} is scheduled against itself.`, roundNo: r, matchIds: ids(m) });
			for (const t of [m.teamA, m.teamB]) {
				const prev = seenTeam.get(t);
				if (prev && prev !== m)
					issues.push({ level: 'error', message: `Round ${r}: ${name(t)} is booked in two games.`, roundNo: r, teamIds: [t], matchIds: [...ids(prev), ...ids(m)] });
				seenTeam.set(t, m);
				const team = teamById.get(t);
				if (!team) issues.push({ level: 'error', message: `Round ${r}: a scheduled team is not in this session.`, roundNo: r, matchIds: ids(m) });
				else if (team.withdrawn) issues.push({ level: 'error', message: `Round ${r}: ${team.name} has withdrawn.`, roundNo: r, teamIds: [t], matchIds: ids(m) });
			}
			const prevRoom = seenRoom.get(m.roomId);
			if (prevRoom) issues.push({ level: 'error', message: `Round ${r}: ${roomName(m.roomId)} has two games.`, roundNo: r, matchIds: [...ids(prevRoom), ...ids(m)] });
			seenRoom.set(m.roomId, m);
			if (!rooms.some((x) => x.id === m.roomId)) issues.push({ level: 'warning', message: `Round ${r}: game is in a room this session doesn't use.`, roundNo: r, matchIds: ids(m) });
			const a = teamById.get(m.teamA);
			const b = teamById.get(m.teamB);
			if (a && b && a.schoolId === b.schoolId)
				issues.push({
					level: 'notice',
					message: `Round ${r}: ${a.name} and ${b.name} are from the same school${m.counts ? '' : ' (non-counter)'}.`,
					roundNo: r,
					teamIds: [a.id, b.id],
					matchIds: ids(m)
				});
			if (m.counts && a && b && a.poolKey !== b.poolKey)
				issues.push({ level: 'warning', message: `Round ${r}: ${a.name} vs ${b.name} counts, but they are in different pools.`, roundNo: r, matchIds: ids(m) });
		}
	}

	// Balance within each pool.
	const pools = new Map<string, SchedTeam[]>();
	for (const t of teams.filter((t) => !t.withdrawn)) pools.set(t.poolKey, [...(pools.get(t.poolKey) ?? []), t]);
	for (const [, members] of pools) {
		if (members.length < 2) continue;
		const games = new Map(members.map((t) => [t.id, 0]));
		const pairCount = new Map<string, number>();
		for (const m of matches.filter((m) => m.counts)) {
			if (games.has(m.teamA) && games.has(m.teamB)) {
				games.set(m.teamA, games.get(m.teamA)! + 1);
				games.set(m.teamB, games.get(m.teamB)! + 1);
				const k = m.teamA < m.teamB ? `${m.teamA}-${m.teamB}` : `${m.teamB}-${m.teamA}`;
				pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
			}
		}
		const counts = [...games.values()];
		if (Math.max(...counts) - Math.min(...counts) > 1)
			issues.push({
				level: 'warning',
				message: `${members[0].classification} pool: teams have unequal numbers of counting games (${members.map((t) => `${t.name} ${games.get(t.id)}`).join(', ')}).`,
				teamIds: members.map((t) => t.id)
			});
		const pairs: [SchedTeam, SchedTeam][] = [];
		for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pairs.push([members[i], members[j]]);
		const totalGames = counts.reduce((a, b) => a + b, 0) / 2;
		const missing = pairs.filter(([a, b]) => !pairCount.get(a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`));
		if (missing.length && totalGames >= pairs.length)
			issues.push({
				level: 'warning',
				message: `Some teams in the same pool never play each other: ${missing.map(([a, b]) => `${a.name} / ${b.name}`).join('; ')}.`,
				teamIds: missing.flat().map((t) => t.id)
			});
		const pc = [...pairCount.values()];
		if (pc.length && Math.max(...pc) - Math.min(...pc, missing.length ? 0 : Infinity) > 1)
			issues.push({ level: 'warning', message: 'Some pairs in a pool meet two or more times more often than others (unbalanced pairings).', teamIds: members.map((t) => t.id) });
	}
	return issues;
}

/** Teams with no game in a round. */
export function byesByRound(teams: SchedTeam[], matches: SchedMatch[], roundCount: number): Map<number, number[]> {
	const out = new Map<number, number[]>();
	for (let r = 1; r <= roundCount; r++) {
		const busy = new Set(matches.filter((m) => m.roundNo === r).flatMap((m) => [m.teamA, m.teamB]));
		out.set(
			r,
			teams.filter((t) => !t.withdrawn && !busy.has(t.id)).map((t) => t.id)
		);
	}
	return out;
}
