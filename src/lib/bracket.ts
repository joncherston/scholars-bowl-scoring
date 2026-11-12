/**
 * Bracket plans: which games follow pool play in a bracket division, and where each team
 * comes from ("seed:1", "winner:SF1", "loser:SF2"). Pure, shared by the server and the browser.
 */
import type { BracketSize, DivisionFormat } from './engine/rules';

export interface PlannedSlot {
	slot: string;
	label: string;
	/** Rounds after pool play: 1 = the first bracket round. */
	bracketRound: number;
	sourceA: string;
	sourceB: string;
	counts: boolean;
}

/** Largest supported bracket that fits the teams (a 4-team bracket with 3 teams becomes a final). */
export function effectiveBracketSize(size: BracketSize, teamCount: number): BracketSize | 0 {
	for (const s of [8, 4, 2] as const) if (s <= size && s <= teamCount) return s;
	return 0;
}

export function bracketRounds(size: BracketSize | 0): number {
	return size === 8 ? 3 : size === 4 ? 2 : size === 2 ? 1 : 0;
}

const seed = (n: number) => `seed:${n}`;
const W = (s: string) => `winner:${s}`;
const L = (s: string) => `loser:${s}`;

export function bracketPlan(fmt: DivisionFormat, teamCount: number): PlannedSlot[] {
	const size = effectiveBracketSize(fmt.bracketSize, teamCount);
	const out: PlannedSlot[] = [];
	if (!size) return out;
	const add = (slot: string, label: string, bracketRound: number, a: string, b: string, counts = true) => out.push({ slot, label, bracketRound, sourceA: a, sourceB: b, counts });
	const finals = (r: number, sfA: string, sfB: string) => {
		add('F', 'Championship', r, W(sfA), W(sfB));
		if (fmt.thirdPlaceGame) add('3P', '3rd-place game', r, L(sfA), L(sfB));
	};
	if (size === 2) add('F', 'Championship', 1, seed(1), seed(2));
	if (size === 4) {
		add('SF1', 'Semifinal 1', 1, seed(1), seed(4));
		add('SF2', 'Semifinal 2', 1, seed(2), seed(3));
		finals(2, 'SF1', 'SF2');
	}
	if (size === 8) {
		add('QF1', 'Quarterfinal 1', 1, seed(1), seed(8));
		add('QF2', 'Quarterfinal 2', 1, seed(4), seed(5));
		add('QF3', 'Quarterfinal 3', 1, seed(3), seed(6));
		add('QF4', 'Quarterfinal 4', 1, seed(2), seed(7));
		add('SF1', 'Semifinal 1', 2, W('QF1'), W('QF2'));
		add('SF2', 'Semifinal 2', 2, W('QF3'), W('QF4'));
		finals(3, 'SF1', 'SF2');
	}
	// Teams outside the bracket play non-counters, a different opponent each round where possible.
	if (fmt.fillNonCounters) {
		const rest = Array.from({ length: teamCount - size }, (_, i) => size + 1 + i);
		for (let r = 1; r <= bracketRounds(size); r++) {
			const order = rotate(rest, r - 1);
			for (let i = 0; i + 1 < order.length; i += 2)
				add(`X${r}-${i / 2 + 1}`, `Non-counter: seed ${order[i]} v seed ${order[i + 1]}`, r, seed(order[i]), seed(order[i + 1]), false);
		}
	}
	return out;
}

/** Round-robin style rotation of the non-bracket seeds so opponents change between rounds. */
function rotate(list: number[], k: number): number[] {
	if (list.length < 3 || k === 0) return list;
	const fixed = list[0];
	const rest = list.slice(1);
	for (let i = 0; i < k; i++) rest.unshift(rest.pop()!);
	const out = [fixed, ...rest];
	// Pair first with last, second with second-to-last… so a rotated list gives new pairs.
	const paired: number[] = [];
	for (let i = 0; i < Math.floor(out.length / 2); i++) paired.push(out[i], out[out.length - 1 - i]);
	if (out.length % 2) paired.push(out[Math.floor(out.length / 2)]);
	return paired;
}

/** "seed:3" → "Seed 3", "winner:SF1" → "Winner of Semifinal 1". */
export function describeSource(src: string, slots: { slot: string; label: string }[] = []): string {
	const [kind, ref] = src.split(':');
	if (kind === 'seed') return `Seed ${ref}`;
	const label = slots.find((s) => s.slot === ref)?.label ?? ref;
	return `${kind === 'winner' ? 'Winner' : 'Loser'} of ${label}`;
}
