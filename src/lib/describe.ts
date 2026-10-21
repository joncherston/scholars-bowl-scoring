import type { EventBody, ScoringBody } from '$lib/engine';
import { formatPoints } from '$lib/engine/points';

/** Plain-language description of a log entry, for audit views and printouts. */
export function describeEvent(b: EventBody, nameOf: (id: string | null) => string, teams: { A: string; B: string }): string {
	const tu = (n: number, tb?: boolean) => `${tb ? 'Tiebreaker' : 'Tossup'} ${n}`;
	const scoring = (s: ScoringBody): string => {
		switch (s.type) {
			case 'tossup_answer':
				return `${tu(s.tossup, s.tiebreaker)}: ${s.playerId ? nameOf(s.playerId) : `${teams[s.side]} (player not recorded)`} (${s.side}) ${s.correct ? 'correct' : 'wrong'}${s.interrupt ? ', interrupt' : ''}${s.power ? ', power' : ''}`;
			case 'tossup_dead':
				return `${tu(s.tossup, s.tiebreaker)}: dead`;
			case 'bonus':
				return `${tu(s.tossup)} bonus for ${teams[s.side]}: ${formatPoints(s.value)} points, parts ${s.parts.map((p) => (p === 'correct' ? '✓' : p === 'bounceback' ? '↩' : '✗')).join(' ')}`;
		}
	};
	switch (b.type) {
		case 'tossup_answer':
		case 'tossup_dead':
		case 'bonus':
			return scoring(b);
		case 'round_started':
			return `Round started. A: ${b.lineups.A.map(nameOf).join(', ') || '—'}. B: ${b.lineups.B.map(nameOf).join(', ') || '—'}`;
		case 'lineup_set':
			return `Lineup for ${teams[b.side]} set to ${b.players.map(nameOf).join(', ') || '—'}`;
		case 'tiebreaker_started':
			return 'Tiebreaker started';
		case 'round_ended':
			return `Round ended: ${b.reason}${b.note ? ` (${b.note})` : ''}`;
		case 'submitted':
			return `Submitted with final score ${formatPoints(b.scoreA)}–${formatPoints(b.scoreB)}`;
		case 'approved':
			return 'Approved';
		case 'unapproved':
			return `Approval withdrawn: ${b.reason}`;
		case 'undo':
			return 'Undo';
		case 'correction':
			if (b.action === 'void') return `Correction: voided an entry. Reason: ${b.reason}`;
			if (b.action === 'amend') return `Correction: changed an entry to "${scoring(b.replacement)}". Reason: ${b.reason}`;
			return `Correction: added "${scoring(b.replacement)}". Reason: ${b.reason}`;
		case 'note':
			return `Note: ${b.text}`;
		case 'device_takeover':
			return 'Scoring moved to another computer (takeover)';
		case 'forfeit':
			return `Forfeit: ${teams[b.side]} (${b.side}) forfeits. Reason: ${b.reason}`;
	}
}
