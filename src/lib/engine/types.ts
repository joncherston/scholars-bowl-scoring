import type { Hundredths } from './points';

export type Side = 'A' | 'B';
export const other = (s: Side): Side => (s === 'A' ? 'B' : 'A');

/** One bonus part: answered by the controlling team, missed, or taken on a bounceback. */
export type BonusPart = 'correct' | 'incorrect' | 'bounceback';

/** Events that change points. These can be undone, voided, or amended. */
export type ScoringBody =
	| {
			type: 'tossup_answer';
			tossup: number;
			tiebreaker?: boolean;
			side: Side;
			/** null when the scorer could not tell which player buzzed. */
			playerId: string | null;
			correct: boolean;
			interrupt?: boolean;
			power?: boolean;
	  }
	| { type: 'tossup_dead'; tossup: number; tiebreaker?: boolean }
	| {
			type: 'bonus';
			tossup: number;
			side: Side;
			/** Pre-stated bonus value, in hundredths. */
			value: Hundredths;
			parts: BonusPart[];
	  };

export type EventBody =
	| ScoringBody
	| { type: 'round_started'; lineups: Record<Side, string[]> }
	| { type: 'lineup_set'; side: Side; players: string[] }
	| { type: 'tiebreaker_started' }
	| { type: 'round_ended'; reason: string; note?: string }
	| { type: 'submitted'; scoreA: Hundredths; scoreB: Hundredths }
	| { type: 'approved' }
	| { type: 'unapproved'; reason: string }
	| { type: 'undo'; target: string }
	| { type: 'correction'; action: 'void'; target: string; reason: string }
	| { type: 'correction'; action: 'amend'; target: string; replacement: ScoringBody; reason: string }
	| { type: 'correction'; action: 'add'; replacement: ScoringBody; reason: string }
	| { type: 'note'; text: string }
	| { type: 'device_takeover'; previousDevice: string | null }
	/** Head scorekeeper: `side` forfeits. The other team wins; neither team scores. Void it with a correction. */
	| { type: 'forfeit'; side: Side; reason: string };

export type EventType = EventBody['type'];

/** One append-only entry in a round's log. */
export interface ScoreEvent {
	/** Client-generated UUID; duplicates are ignored on ingest. */
	id: string;
	/** Authoritative order within the round (server-assigned; local order on the scorer). */
	seq: number;
	body: EventBody;
	/** Who did it: "room:<id>" or "user:<id>". */
	actor: string;
	actorName?: string;
	deviceId?: string | null;
	/** Per-round counter on the sending device, for gap detection. */
	deviceSeq?: number | null;
	clientTs?: string;
	serverTs?: string;
}

export const SCORING_TYPES = new Set<EventType>(['tossup_answer', 'tossup_dead', 'bonus']);
export const isScoringBody = (b: EventBody): b is ScoringBody => SCORING_TYPES.has(b.type);

export type RoundStatus = 'not_started' | 'in_progress' | 'ended' | 'submitted' | 'approved' | 'forfeit';

/** Approved rounds and forfeits are final: they count in final standings and allow finalizing. */
export const isFinalStatus = (s: RoundStatus) => s === 'approved' || s === 'forfeit';

export type FlagKind =
	| 'fractional_bonus'
	| 'inexact_bonus'
	| 'multiple_correct'
	| 'answer_after_correct'
	| 'same_side_twice'
	| 'dead_with_correct'
	| 'bonus_without_correct'
	| 'bonus_wrong_team'
	| 'multiple_bonuses'
	| 'bonus_in_tiebreaker'
	| 'bounceback_disabled'
	| 'unattributed_answer'
	| 'player_not_in_lineup'
	| 'unknown_target'
	| 'already_voided'
	| 'invalid_event'
	| 'tied_without_tiebreaker'
	| 'tiebreaker_not_needed'
	| 'forfeit_scoring_ignored'
	| 'edited_after_submission'
	| 'submitted_score_mismatch'
	| 'below_min_tossups'
	| 'over_max_tossups';

export interface Flag {
	kind: FlagKind;
	message: string;
	tossup?: number;
	tiebreaker?: boolean;
	eventId?: string;
}
