<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';

	let { data } = $props();
	const r = $derived(data.results);
	let tab = $state<number | null>(null);
	const session = $derived(r.sessions.find((s) => s.id === tab) ?? r.sessions[0]);
	let es: EventSource | null = null;
	let t: ReturnType<typeof setTimeout> | null = null;
	onMount(() => {
		es = new EventSource(`/api/stream/public/${r.event.id}`);
		const reload = () => {
			if (t) return;
			t = setTimeout(() => {
				t = null;
				invalidate('app:public');
			}, 2000);
		};
		es.addEventListener('round', reload);
		es.addEventListener('session', reload);
	});
	onDestroy(() => {
		es?.close();
		if (t) clearTimeout(t);
	});
</script>

<svelte:head><title>{r.event.name} results</title></svelte:head>

<div class="container wide">
	<h1>{r.event.name}</h1>
	<p class="muted">Team standings and game results. Updates automatically.</p>
	{#if r.sessions.length > 1}
		<nav class="row" aria-label="Session">
			{#each r.sessions as s (s.id)}
				<button class="btn {s.id === session?.id ? '' : 'secondary'}" type="button" onclick={() => (tab = s.id)}>{s.name}</button>
			{/each}
		</nav>
	{/if}
	{#if session}
		<p>{#if session.final}<span class="badge ok">Final</span>{:else}<span class="badge warn">Unofficial until the session is finalized</span>{/if}</p>
		<div class="grid cols-2">
			<div>
				<h2>Standings</h2>
				{#each session.standings as g (g.label)}
					<div class="card st">
						<h3>{g.label}</h3>
						<table class="data">
							<thead><tr><th>Place</th><th>Team</th><th class="num">W–L</th><th class="num">Points</th></tr></thead>
							<tbody>{#each g.rows as row (row.team)}<tr><td>{row.place}{row.tied ? ' (tie)' : ''}</td><td>{row.team}</td><td class="num">{row.wins}–{row.losses}</td><td class="num">{row.points}</td></tr>{/each}</tbody>
						</table>
					</div>
				{/each}
			</div>
			<div>
				<h2>Games</h2>
				{#each [...session.rounds].reverse() as rd (rd.roundNo)}
					<div class="card st">
						<h3>Round {rd.roundNo}</h3>
						<table class="data">
							<tbody>
								{#each rd.games as g (g.id)}
									<tr>
										<td class:win={g.winner === 'A'}>{g.teamA}</td>
										<td class="num nowrap">{g.state === 'upcoming' ? '—' : `${g.scoreA}–${g.scoreB}`}</td>
										<td class:win={g.winner === 'B'}>{g.teamB}</td>
										<td class="small">{g.state === 'live' ? 'in progress' : g.state === 'upcoming' ? 'upcoming' : ''}{g.counts ? '' : ' non-counter'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.st {
		padding: 12px;
	}
	.st + .st {
		margin-top: 10px;
	}
	.win {
		font-weight: 800;
	}
</style>
