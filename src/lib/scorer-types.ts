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

export interface RoomState {
	room: { id: number; name: string; projectorToken: string };
	event: { id: number; name: string; isTest: boolean };
	matches: ScorerMatch[];
	serverTime: string;
}
