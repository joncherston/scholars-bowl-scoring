<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';

	let { data } = $props();
	const r = $derived(data.results);
	let tab = $state<number | null>(null);
	const session = $derived(r.sessions.find((s) => s.id === tab) ?? r.sessions[0]);
	let view = $state<'standings' | 'games'>('standings');
	let es: EventSource | null = null;
	let t: ReturnType<typeof setTimeout> | null = null;
	let updated = $state(new Date());
	onMount(() => {
		es = new EventSource(`/api/stream/public/${r.event.id}`);
		const reload = () => {
			if (t) return;
			t = setTimeout(async () => {
				t = null;
				await invalidate('app:public');
				updated = new Date();
			}, 2000);
		};
		es.addEventListener('round', reload);
		es.addEventListener('session', reload);
		es.addEventListener('schedule', reload);
	});
	onDestroy(() => {
		es?.close();
		if (t) clearTimeout(t);
	});
	const score = (g: { state: string; note: string; scoreA: string; scoreB: string }) =>
		g.state === 'upcoming' || g.state === 'planned' ? '—' : g.note === 'forfeit' ? 'forfeit' : `${g.scoreA}–${g.scoreB}`;
	const status = (g: { state: string; note: string; counts: boolean }) =>
		[g.state === 'live' ? 'in progress' : g.state === 'upcoming' ? 'upcoming' : g.state === 'planned' ? 'teams to be decided' : g.note === 'tiebreaker' ? 'won in tiebreaker' : '', g.counts ? '' : 'non-counter']
			.filter(Boolean)
			.join(' · ');
</script>

<svelte:head><title>{r.event.name} · live results</title></svelte:head>

<div class="container wide">
	<header class="hero">
		<div>
			<h1>{r.event.name}</h1>
			<p class="muted">Live results · updates automatically · last updated {updated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
		</div>
		<span class="live-dot" aria-hidden="true"></span>
	</header>

	<nav class="row tabs" aria-label="Session and view">
		{#each r.sessions as s (s.id)}
			<button class="btn {s.id === session?.id ? '' : 'secondary'}" type="button" aria-pressed={s.id === session?.id} onclick={() => (tab = s.id)}>{s.name}</button>
		{/each}
		<span class="sep"></span>
		<button class="btn {view === 'standings' ? '' : 'secondary'}" type="button" aria-pressed={view === 'standings'} onclick={() => (view = 'standings')}>Rankings</button>
		<button class="btn {view === 'games' ? '' : 'secondary'}" type="button" aria-pressed={view === 'games'} onclick={() => (view = 'games')}>Match by match</button>
	</nav>

	{#if session}
		<p>{#if session.final}<span class="badge ok">Final</span>{:else}<span class="badge warn">Unofficial until the session is finalized</span>{/if}</p>

		{#if view === 'standings'}
			{#each session.divisions as d (d.label)}
				<section class="card division">
					<h2>{d.label} <span class="muted small">{d.format === 'bracket' ? 'pool play, then a bracket' : 'round robin'}</span></h2>
					<div class="cols">
						<div>
							<h3>Team rankings</h3>
							<table class="data">
								<thead><tr><th>Place</th><th>Team</th><th>Class</th><th class="num">W–L</th><th class="num">Points</th>{#if d.format === 'bracket'}<th>Bracket</th>{/if}</tr></thead>
								<tbody>
									{#each d.rows as row (row.team)}
										<tr class:top={row.place <= 3 && !row.pending}>
											<td class="num">{row.pending ? '–' : row.place}{row.tied ? ' (tie)' : ''}</td>
											<td><strong>{row.team}</strong></td>
											<td>{row.classification}</td>
											<td class="num">{row.wins}–{row.losses}</td>
											<td class="num">{row.points}</td>
											{#if d.format === 'bracket'}<td class="small">{row.result ?? (row.seed ? `Seed ${row.seed}` : '')}</td>{/if}
										</tr>
									{/each}
								</tbody>
							</table>
							{#if d.format === 'bracket' && d.bracket.length}
								<h3>Bracket</h3>
								<ul class="bracket">
									{#each d.bracket as g (g.id)}
										<li>
											<span class="lbl">{g.label}</span>
											<span class:win={g.winner === 'A'}>{g.teamA}</span>
											<span class="num sc">{score(g)}</span>
											<span class:win={g.winner === 'B'}>{g.teamB}</span>
											<span class="small muted">{g.room}{status(g) ? ` · ${status(g)}` : ''}</span>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
						<div>
							<h3>By classification</h3>
							<div class="classes">
								{#each d.classes as c (c.classification)}
									<table class="data small-table">
										<caption>{c.classification}</caption>
										<tbody>
											{#each c.rows as row (row.team)}
												<tr><td class="num">{row.pending ? '–' : row.place}</td><td>{row.team}</td><td class="num">{row.wins}–{row.losses}</td><td class="num">{row.points}</td></tr>
											{/each}
										</tbody>
									</table>
								{/each}
							</div>
							{#if d.individuals.length}
								<h3>Top individual scorers</h3>
								<table class="data">
									<thead><tr><th>Rank</th><th>Player</th><th>School</th><th class="num">Points</th></tr></thead>
									<tbody>{#each d.individuals as p (p.name + p.team)}<tr><td class="num">{p.place}{p.tied ? ' (tie)' : ''}</td><td>{p.name}</td><td>{p.team}</td><td class="num">{p.points}</td></tr>{/each}</tbody>
								</table>
							{/if}
							{#if d.format === 'bracket' && d.seeds.length}
								<details>
									<summary class="small">Pool-play seeding</summary>
									<table class="data small-table">
										<thead><tr><th>Seed</th><th>Team</th><th class="num">W–L</th><th class="num">Points</th></tr></thead>
										<tbody>{#each d.seeds as sd (sd.team)}<tr><td class="num">{sd.seed}{sd.tied ? ' (tie)' : ''}</td><td>{sd.team}</td><td class="num">{sd.wins}–{sd.losses}</td><td class="num">{sd.points}</td></tr>{/each}</tbody>
									</table>
								</details>
							{/if}
						</div>
					</div>
				</section>
			{/each}
		{:else}
			{#each [...session.rounds].reverse() as rd (rd.roundNo)}
				<section class="card division">
					<h2>Round {rd.roundNo}</h2>
					<table class="data">
						<tbody>
							{#each rd.games as g (g.id)}
								<tr>
									<td class="small muted nowrap">{g.room}</td>
									<td class:win={g.winner === 'A'}>{g.teamA}</td>
									<td class="num nowrap sc">{score(g)}</td>
									<td class:win={g.winner === 'B'}>{g.teamB}</td>
									<td class="small">{g.label ? `${g.label}${status(g) ? ' · ' : ''}` : ''}{status(g)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</section>
			{/each}
		{/if}
	{/if}
</div>

<style>
	.hero {
		display: flex;
		justify-content: space-between;
		align-items: center;
		border-bottom: 4px solid var(--suscc-gold);
		margin-bottom: 14px;
	}
	.live-dot {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--success);
		box-shadow: 0 0 0 4px var(--success-bg);
	}
	@media (prefers-reduced-motion: no-preference) {
		.live-dot {
			animation: pulse 2s infinite;
		}
		@keyframes pulse {
			50% {
				box-shadow: 0 0 0 8px var(--success-bg);
			}
		}
	}
	.tabs {
		flex-wrap: wrap;
		gap: 8px;
	}
	.sep {
		width: 12px;
	}
	.division {
		margin-top: 14px;
		padding: 16px;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: 20px;
	}
	@media (max-width: 860px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	h3 {
		margin-top: 12px;
		font-size: 1rem;
	}
	tr.top td {
		background: var(--surface-2);
	}
	.win {
		font-weight: 800;
	}
	.sc {
		font-family: var(--font-num);
		font-weight: 700;
		text-align: center;
	}
	.bracket {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.bracket li {
		display: grid;
		grid-template-columns: 8.5em 1fr auto 1fr;
		gap: 6px 10px;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
		align-items: baseline;
	}
	.bracket li .small {
		grid-column: 2 / -1;
	}
	.lbl {
		font-weight: 700;
		color: var(--suscc-navy);
	}
	.classes {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 10px;
	}
	.small-table caption {
		text-align: left;
		font-weight: 700;
		color: var(--suscc-navy);
	}
</style>
