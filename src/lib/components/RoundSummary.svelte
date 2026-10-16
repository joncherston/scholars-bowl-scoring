<script lang="ts">
	import type { RoundResult } from '$lib/engine';
	import { formatPoints } from '$lib/engine/points';
	import type { RosterPlayer } from '$lib/scorer-types';
	import TossupLog from './TossupLog.svelte';

	interface Props {
		result: RoundResult;
		teams: { A: { name: string; roster: RosterPlayer[] }; B: { name: string; roster: RosterPlayer[] } };
		playerName: (id: string | null) => string;
		includeBonusInIndividual?: boolean;
	}
	let { result, teams, playerName, includeBonusInIndividual = false }: Props = $props();

	const playersFor = (side: 'A' | 'B') => {
		const ids = [...new Set([...result.lineups[side], ...result.players.filter((p) => p.side === side).map((p) => p.playerId)])];
		return ids.map((id) => {
			const p = result.players.find((x) => x.side === side && x.playerId === id);
			return { id, name: playerName(id), corrects: p?.corrects ?? 0, incorrects: p?.incorrects ?? 0, tossupPoints: (p?.tossupPoints ?? 0) + (p?.negPoints ?? 0), bonusPoints: p?.bonusPoints ?? 0, total: p?.individualTotal ?? 0 };
		});
	};
</script>

<div class="summary">
	<div class="grid cols-2">
		{#each ['A', 'B'] as const as side (side)}
			{@const t = result.teams[side]}
			<div class="card team">
				<h3><span class="side side-{side}">{side}</span> {teams[side].name} <span class="total num">{formatPoints(t.roundScore)}</span></h3>
				<table class="data">
					<tbody>
						<tr><td>Tossups correct</td><td class="num">{t.tossupsCorrect} ({formatPoints(t.tossupPoints)} pts)</td></tr>
						{#if t.negPoints}<tr><td>Negs</td><td class="num">{formatPoints(t.negPoints)}</td></tr>{/if}
						<tr><td>Bonus points</td><td class="num">{formatPoints(t.bonusPoints)} <span class="muted small">({t.bonusPartsCorrect}/{t.bonusPartsHeard} parts, {t.bonusesHeard} bonuses)</span></td></tr>
						{#if t.bouncebackPoints}<tr><td>Bounceback points</td><td class="num">{formatPoints(t.bouncebackPoints)}</td></tr>{/if}
						{#if t.tiebreakerPoints}<tr><td>Tiebreaker</td><td class="num">{formatPoints(t.tiebreakerPoints)}</td></tr>{/if}
						<tr class="tot"><td>Round score</td><td class="num">{formatPoints(t.roundScore)}</td></tr>
					</tbody>
				</table>
				<table class="data players">
					<thead><tr><th>Player</th><th class="num">Right</th><th class="num">Wrong</th><th class="num">Tossup pts</th>{#if includeBonusInIndividual}<th class="num">Individual</th>{/if}</tr></thead>
					<tbody>
						{#each playersFor(side) as p (p.id)}
							<tr><td>{p.name}</td><td class="num">{p.corrects}</td><td class="num">{p.incorrects}</td><td class="num">{formatPoints(p.tossupPoints)}</td>{#if includeBonusInIndividual}<td class="num">{formatPoints(p.total)}</td>{/if}</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/each}
	</div>
	{#if result.flags.length}
		<div class="alert warning" style="margin-top: 12px">
			<strong>Please check:</strong>
			<ul>{#each result.flags as f, i (i)}<li>{f.message}</li>{/each}</ul>
		</div>
	{/if}
	<div class="card" style="margin-top: 12px; padding: 0; overflow: hidden">
		<TossupLog {result} {playerName} teamNames={{ A: teams.A.name, B: teams.B.name }} />
	</div>
</div>

<style>
	.team h3 {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.total {
		margin-left: auto;
		font-size: 1.6rem;
		color: var(--suscc-navy);
	}
	.players {
		margin-top: 10px;
	}
	.tot td {
		font-weight: 800;
	}
	.side {
		display: inline-block;
		min-width: 1.6em;
		text-align: center;
		font: 800 0.8rem/1.6 var(--font-head);
		border-radius: 3px;
		color: #fff;
	}
	.side-A {
		background: var(--team-a);
	}
	.side-B {
		background: var(--team-b);
	}
</style>
