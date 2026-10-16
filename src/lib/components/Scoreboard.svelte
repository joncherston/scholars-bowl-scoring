<script lang="ts">
	import { formatPoints } from '$lib/engine/points';

	interface Props {
		nameA: string;
		nameB: string;
		scoreA: number;
		scoreB: number;
		label: string;
		sublabel?: string;
		counts: boolean;
		winner?: 'A' | 'B' | null;
		compact?: boolean;
	}
	let { nameA, nameB, scoreA, scoreB, label, sublabel = '', counts, winner = null, compact = false }: Props = $props();
</script>

<section class="board" class:compact aria-label="Scoreboard">
	{#if !counts}<div class="nc" role="note">NON-COUNTER — this game does not count toward standings</div>{/if}
	<div class="teams">
		<div class="team a" class:win={winner === 'A'}>
			<div class="tag">A</div>
			<div class="name">{nameA}</div>
			<div class="score num" aria-label="{nameA} score">{formatPoints(scoreA)}</div>
			{#if winner === 'A'}<div class="w">Winner</div>{/if}
		</div>
		<div class="mid">
			<div class="label">{label}</div>
			{#if sublabel}<div class="sub">{sublabel}</div>{/if}
		</div>
		<div class="team b" class:win={winner === 'B'}>
			<div class="tag">B</div>
			<div class="name">{nameB}</div>
			<div class="score num" aria-label="{nameB} score">{formatPoints(scoreB)}</div>
			{#if winner === 'B'}<div class="w">Winner</div>{/if}
		</div>
	</div>
</section>

<style>
	.board {
		background: var(--suscc-navy);
		color: #fff;
		border-radius: var(--radius);
		padding: 14px 18px 18px;
		border-bottom: 6px solid var(--suscc-gold);
	}
	.nc {
		background: #fff;
		color: var(--suscc-navy);
		font-weight: 800;
		text-align: center;
		border-radius: 4px;
		padding: 4px 8px;
		margin-bottom: 10px;
		letter-spacing: 0.04em;
		font-family: var(--font-head);
	}
	.teams {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		gap: 16px;
		align-items: center;
	}
	.team {
		text-align: center;
		min-width: 0;
		position: relative;
	}
	.tag {
		display: inline-block;
		font: 800 0.95rem var(--font-head);
		border: 2px solid currentColor;
		border-radius: 4px;
		padding: 0 8px;
		color: var(--suscc-gold);
	}
	.name {
		font: 800 clamp(1.4rem, 3vw, 2.6rem) / 1.1 var(--font-head);
		margin: 6px 0 2px;
		overflow-wrap: anywhere;
	}
	.score {
		font: 800 clamp(4rem, 11vw, 9.5rem) / 1 var(--font-num);
		color: var(--suscc-gold);
		font-variant-numeric: tabular-nums;
	}
	.win .score {
		text-shadow: 0 0 24px rgb(250 211 71 / 50%);
	}
	.w {
		font: 800 1rem var(--font-head);
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}
	.mid {
		text-align: center;
		padding: 0 8px;
	}
	.label {
		font: 800 clamp(1.3rem, 2.6vw, 2.4rem) / 1.1 var(--font-head);
		white-space: nowrap;
	}
	.sub {
		font-size: clamp(0.9rem, 1.4vw, 1.2rem);
		opacity: 0.85;
	}
	.compact .score {
		font-size: clamp(3rem, 7vw, 6rem);
	}
	.compact .name {
		font-size: clamp(1.1rem, 2.2vw, 1.9rem);
	}
</style>
