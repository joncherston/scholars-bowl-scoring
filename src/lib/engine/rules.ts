/**
 * Scoring settings for one event. Every point value is stored in integer
 * hundredths (10 points = 1000) so no floating-point math ever touches a score.
 *
 * Settings belong to an event and are versioned: each round records the
 * version it was scored under, so later edits never silently change results.
 */

export type RoundingMode = 'exact' | 'half_up' | 'down';
export type StandingsCriterion = 'roundsWon' | 'totalPoints' | 'headToHead';
export type IndividualGrouping = 'division' | 'classification' | 'session' | 'overall';

export interface RuleSettings {
	/** Points for a correct tossup, in hundredths. */
	tossupPoints: number;
	/** Power: a correct early buzz earns `points` (total, replacing tossupPoints). */
	power: { enabled: boolean; points: number };
	/** Neg: penalty (positive magnitude, hundredths) for an incorrect answer. */
	neg: { enabled: boolean; points: number; onlyOnInterrupt: boolean };
	bonus: {
		/** Parts missed by the controlling team may be answered by the other team. */
		bounceback: boolean;
		/** How a proportional share that is not whole points is handled. */
		rounding: RoundingMode;
		/** Quick-pick values offered to the scorer, in hundredths. */
		quickValues: number[];
		defaultParts: number;
	};
	individual: {
		/** Credit bonus points to the player who answered the tossup. */
		includeBonus: boolean;
		/** Credit tiebreaker tossup points to the player. */
		includeTiebreaker: boolean;
	};
	tiebreaker: {
		/** Tiebreaker tossup points count toward the team's round score. */
		countsInRoundScore: boolean;
		/** Tiebreaker tossup points count toward the team's standings total. */
		countsInTotalPoints: boolean;
	};
	round: {
		maxTossups: number;
		/** Scorer is reminded to announce the score after this tossup (0 = never). */
		announceAfterTossup: number;
		timeLimitMinutes: number;
		/** Minimum tossups for a round to be complete (null = no minimum). */
		minTossups: number | null;
		endReasons: string[];
	};
	roster: { maxPlayers: number; activePlayers: number };
	standings: { order: StandingsCriterion[] };
	awards: {
		teamPlaces: number;
		individualPlaces: number;
		individualGrouping: IndividualGrouping;
		/**
		 * Award division for each classification. Team awards (and individual awards when grouped
		 * by division) are ranked within a division across the whole event. A classification not
		 * listed is its own division.
		 */
		divisions: Record<string, string>;
	};
	maxRoundsPerSession: number;
}

/** Settings that must be confirmed by an admin before the event. */
export const CONFIRM_ITEMS = [
	{ key: 'tossup', label: 'Tossup value, powers, and negs' },
	{ key: 'bonus', label: 'Bonus split across parts, and bounceback' },
	{ key: 'individual', label: 'Individual scores count tossups only' },
	{ key: 'tiebreaker', label: 'Tiebreaker points decide the game but never count toward total points or individual scores.' },
	{ key: 'round', label: 'Round time limit and minimum tossups' },
	{ key: 'teamAwards', label: 'Team award places' },
	{ key: 'divisions', label: 'Award divisions: which classifications are awarded together (team and individual)' },
	{ key: 'individualAwards', label: 'Individual award grouping and number of places' },
	{ key: 'individualTies', label: 'Individual tie-breaking method' }
] as const;
export type ConfirmKey = (typeof CONFIRM_ITEMS)[number]['key'];

/** Awards are given for Private, Public 1A–3A, and Public 4A–7A (confirmed Oct 21, 2026). */
export const DEFAULT_DIVISIONS: Record<string, string> = {
	Private: 'Private',
	'1A': 'Public 1A–3A',
	'2A': 'Public 1A–3A',
	'3A': 'Public 1A–3A',
	'4A': 'Public 4A–7A',
	'5A': 'Public 4A–7A',
	'6A': 'Public 4A–7A',
	'7A': 'Public 4A–7A'
};

/** The award division a classification belongs to. */
export const divisionOf = (rules: RuleSettings, classification: string) => rules.awards.divisions[classification]?.trim() || classification;

export const HIGH_SCHOOL_DEFAULTS: RuleSettings = {
	tossupPoints: 1000,
	power: { enabled: false, points: 1500 },
	neg: { enabled: false, points: 500, onlyOnInterrupt: true },
	bonus: {
		bounceback: false,
		rounding: 'exact',
		quickValues: [1000, 2000, 2500, 3000],
		defaultParts: 1
	},
	individual: { includeBonus: false, includeTiebreaker: false },
	tiebreaker: { countsInRoundScore: true, countsInTotalPoints: false },
	round: {
		maxTossups: 25,
		announceAfterTossup: 12,
		timeLimitMinutes: 30,
		minTossups: null,
		endReasons: ['Time called', 'All tossups read', 'Other']
	},
	roster: { maxPlayers: 6, activePlayers: 4 },
	standings: { order: ['roundsWon', 'totalPoints', 'headToHead'] },
	awards: { teamPlaces: 1, individualPlaces: 3, individualGrouping: 'division', divisions: { ...DEFAULT_DIVISIONS } },
	maxRoundsPerSession: 12
};

export const RULE_TEMPLATES: { id: string; name: string; settings: RuleSettings }[] = [
	{ id: 'high-school', name: 'SUSCC High School (default)', settings: HIGH_SCHOOL_DEFAULTS }
];

/** Deep-merge saved settings over the defaults so older saved versions stay readable. */
export function normalizeRules(partial: unknown): RuleSettings {
	return mergeDeep(structuredClone(HIGH_SCHOOL_DEFAULTS), partial) as RuleSettings;
}

function mergeDeep(base: unknown, over: unknown): unknown {
	if (over === undefined || over === null) return base;
	if (Array.isArray(base) || Array.isArray(over)) return over;
	if (typeof base === 'object' && base !== null && typeof over === 'object') {
		const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
		for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
			out[k] = k in out ? mergeDeep(out[k], v) : v;
		}
		return out;
	}
	return over;
}
