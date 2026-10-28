import type { RuleSettings, ScoreEvent } from '$lib/engine';

export interface RosterPlayer {
	id: string;
	name: string;
	firstName: string;
	lastName: string;
}

export interface ScorerTeam {
	id: number;
	name: string;
	classification: string;
	roster: RosterPlayer[];
	defaultLineup: string[];
}

export interface ScorerMatch {
	id: number;
	sessionId: number;
	sessionName: string;
	roundNo: number;
	time: string | null;
	counts: boolean;
	roomId: number;
	roomName: string;
	teams: { A: ScorerTeam; B: ScorerTeam };
	rules: RuleSettings;
	ruleVersion: number;
	events: ScoreEvent[];
}

/** Which room scoring screen a computer uses: the new screen, or the classic spreadsheet. */
export type ScorerMode = 'screen' | 'sheet';
export const SCORER_MODE_COOKIE = 'sb_scorer_mode';
export const scorerPath = (mode: string | undefined | null) => (mode === 'sheet' ? '/sheet' : '/scorer');

/** Remember this computer's choice of screen (read by the room sign-in page). */
export function rememberScorerMode(mode: ScorerMode) {
	document.cookie = `${SCORER_MODE_COOKIE}=${mode}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

export interface RoomState {
	room: { id: number; name: string; projectorToken: string };
	event: { id: number; name: string; isTest: boolean };
	matches: ScorerMatch[];
	serverTime: string;
}
