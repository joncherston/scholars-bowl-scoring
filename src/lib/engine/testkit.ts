import { HIGH_SCHOOL_DEFAULTS, type RuleSettings } from './rules';
import type { BonusPart, EventBody, ScoreEvent, Side } from './types';

/** Builds a round's event log for tests and simulation. */
export class LogBuilder {
	events: ScoreEvent[] = [];
	private n = 0;

	add(body: EventBody, actor = 'room:1'): string {
		const id = `e${++this.n}`;
		this.events.push({ id, seq: this.n, body, actor });
		return id;
	}
	start(a = ['a1', 'a2', 'a3', 'a4'], b = ['b1', 'b2', 'b3', 'b4']) {
		return this.add({ type: 'round_started', lineups: { A: a, B: b } });
	}
	correct(tossup: number, side: Side, playerId: string | null, opts: { power?: boolean; interrupt?: boolean; tiebreaker?: boolean } = {}) {
		return this.add({ type: 'tossup_answer', tossup, side, playerId, correct: true, ...opts });
	}
	wrong(tossup: number, side: Side, playerId: string | null, opts: { interrupt?: boolean; tiebreaker?: boolean } = {}) {
		return this.add({ type: 'tossup_answer', tossup, side, playerId, correct: false, ...opts });
	}
	dead(tossup: number, tiebreaker = false) {
		return this.add({ type: 'tossup_dead', tossup, tiebreaker });
	}
	bonus(tossup: number, side: Side, valuePoints: number, parts: BonusPart[]) {
		return this.add({ type: 'bonus', tossup, side, value: Math.round(valuePoints * 100), parts });
	}
	undo(target: string) {
		return this.add({ type: 'undo', target });
	}
	end(reason = 'Time called') {
		return this.add({ type: 'round_ended', reason });
	}
}

export const rulesWith = (patch: (r: RuleSettings) => void): RuleSettings => {
	const r = structuredClone(HIGH_SCHOOL_DEFAULTS);
	patch(r);
	return r;
};
