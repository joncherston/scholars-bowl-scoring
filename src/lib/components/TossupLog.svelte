<script lang="ts">
	import type { RoundResult } from '$lib/engine';
	import { formatPoints } from '$lib/engine/points';

	interface Props {
		result: RoundResult;
		playerName: (id: string | null) => string;
		teamNames: { A: string; B: string };
		newestFirst?: boolean;
		limit?: number;
		large?: boolean;
	}
	let { result, playerName, teamNames, newestFirst = false, limit = 0, large = false }: Props = $props();
	const rows = $derived.by(() => {
		const r = newestFirst ? [...result.tossups].reverse() : result.tossups;
		return limit ? r.slice(0, limit) : r;
	});
</script>

<table class="log" class:large aria-label="Tossup log">
	<thead>
		<tr>
			<th class="n">#</th>
			<th>Tossup</th>
			<th>Bonus</th>
			<th class="s" title={teamNames.A}>A</th>
			<th class="s" title={teamNames.B}>B</th>
		</tr>
	</thead>
	<tbody>
		{#each rows as t (`${t.tiebreaker ? 'T' : 'R'}${t.number}`)}
			<tr class:tb={t.tiebreaker}>
				<td class="n">{t.tiebreaker ? `TB${t.number}` : t.number}</td>
				<td>
					{#each t.answers as a, i (a.eventId)}
						{#if i > 0}<span class="sep" aria-hidden="true">→</span>{/if}
						<span class="ans {a.correct ? 'ok' : 'no'}">
							<span class="side side-{a.side}">{a.side}</span>
							{a.playerId ? playerName(a.playerId) : 'Team'}
							<strong>{a.correct ? '✓ correct' : '✗ wrong'}</strong>{#if a.power}&nbsp;(power){/if}{#if a.interrupt}&nbsp;(interrupt){/if}{#if a.points < 0}&nbsp;{formatPoints(a.points)}{/if}{#if a.amended}&nbsp;<em>(corrected)</em>{/if}
						</span>
					{/each}
					{#if t.dead || (!t.correctSide && t.answers.length >= 2)}<span class="dead">{t.answers.length ? '— no one got it' : 'Dead (no answer)'}</span>{/if}
				</td>
				<td>
					{#each t.bonuses as b (b.eventId)}
						<span class="bonus">
							<span class="side side-{b.side}">{b.side}</span>
							{b.partsCorrect}/{b.parts.length} of {formatPoints(b.value)} = <strong>{formatPoints(b.points)}</strong>{#if b.partsBounceback}&nbsp;(+{formatPoints(b.bouncebackPoints)} bounceback){/if}{#if b.fractional}&nbsp;<span class="frac" title="Fractional bonus share">½</span>{/if}
						</span>
					{/each}
					{#if t.state === 'awaiting_bonus'}<span class="muted">bonus…</span>{/if}
				</td>
				<td class="s num">{formatPoints(t.running.A)}</td>
				<td class="s num">{formatPoints(t.running.B)}</td>
			</tr>
		{:else}
			<tr><td colspan="5" class="empty">No tossups yet.</td></tr>
		{/each}
	</tbody>
</table>

<style>
	.log {
		width: 100%;
		border-collapse: collapse;
		background: var(--surface);
		font-size: 0.95rem;
	}
	.log.large {
		font-size: 1.15rem;
	}
	th,
	td {
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}
	th {
		font: 700 0.8rem var(--font-head);
		text-transform: uppercase;
		color: var(--muted);
		background: var(--surface-2);
	}
	.n {
		width: 48px;
		font-weight: 800;
		font-family: var(--font-num);
	}
	.s {
		width: 70px;
		text-align: right;
		font-weight: 800;
		font-family: var(--font-num);
	}
	.ans {
		white-space: nowrap;
	}
	.ans.ok strong {
		color: var(--success);
	}
	.ans.no strong {
		color: var(--danger);
	}
	.sep {
		margin: 0 6px;
		color: var(--muted);
	}
	.side {
		display: inline-block;
		min-width: 1.4em;
		text-align: center;
		font: 800 0.75rem/1.5 var(--font-head);
		border-radius: 3px;
		color: #fff;
		margin-right: 3px;
	}
	.side-A {
		background: var(--team-a);
	}
	.side-B {
		background: var(--team-b);
	}
	.dead {
		color: var(--muted);
		font-style: italic;
		margin-left: 6px;
	}
	.frac {
		display: inline-block;
		background: var(--warning-bg);
		color: var(--warning);
		border: 1px solid #f0d38a;
		border-radius: 3px;
		padding: 0 4px;
		font-weight: 800;
	}
	tr.tb td {
		background: #fff8e1;
	}
	.empty {
		color: var(--muted);
		text-align: center;
		padding: 16px;
	}
</style>
