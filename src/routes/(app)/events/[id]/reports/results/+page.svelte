<script lang="ts">
	let { data } = $props();
	const r = $derived(data.results);
	const rounds = $derived([...new Set(r.matches.map((m) => m.roundNo))]);
	const statusText: Record<string, string> = { not_started: 'not played', in_progress: 'in progress', ended: 'not submitted', submitted: 'awaiting approval', approved: '', forfeit: '' };
</script>

<svelte:head><title>Full results · {r.session.name} · {r.event.name}</title></svelte:head>

<div class="report">
	<div class="no-print bar"><button class="btn" type="button" onclick={() => window.print()}>Print</button></div>
	<header>
		<img src="/suscc-logo-navy.svg" alt="Southern Union State Community College" />
		<div>
			<h1>{r.event.name}{r.event.isTest ? ' — PRACTICE' : ''}</h1>
			<div>{r.session.name} session · Full results {r.mode === 'final' ? '(final)' : '(PROVISIONAL)'}</div>
		</div>
	</header>

	<h2>Standings by award division</h2>
	<p class="small">Points are the sum of each team's scores in its counting games. Tiebreaker points never count.</p>
	{#each r.divisions as g (g.label)}
		<h3>{g.label}{g.soleTeam ? ' (only team in division)' : ''}{g.spans ? ` (ranked across the ${g.spans} sessions)` : ''}{g.provisional && r.mode === 'final' ? ' (provisional)' : ''}</h3>
		<table class="t">
			<thead><tr><th>Place</th><th>Team</th><th>Class.</th><th>W</th><th>L</th><th>Games</th><th>Points</th><th>Against</th></tr></thead>
			<tbody>
				{#each g.rows as row (row.team)}
					<tr><td>{row.place}{row.tied ? ' (tie)' : ''}{row.resolved ? ' *' : ''}</td><td class="l">{row.team}</td><td>{row.classification}</td><td>{row.wins}</td><td>{row.losses}</td><td>{row.played}</td><td>{row.points}</td><td>{row.against}</td></tr>
				{/each}
			</tbody>
		</table>
		{#each g.rows.filter((x) => x.resolved) as row (row.team)}<p class="fn">* {row.team}: tie decided — {row.resolved}</p>{/each}
	{/each}

	{#if r.pools.length !== r.divisions.length}
		<h2>Pool standings</h2>
		{#each r.pools as g (g.label)}
			<h3>{g.label}</h3>
			<table class="t">
				<thead><tr><th>Place</th><th>Team</th><th>W</th><th>L</th><th>Points</th></tr></thead>
				<tbody>{#each g.rows as row (row.team)}<tr><td>{row.place}</td><td class="l">{row.team}</td><td>{row.wins}</td><td>{row.losses}</td><td>{row.points}</td></tr>{/each}</tbody>
			</table>
		{/each}
	{/if}

	<h2>Every game</h2>
	{#each rounds as rn (rn)}
		<h3>Round {rn}</h3>
		<table class="t">
			<thead><tr><th>Room</th><th>Team A</th><th>Score</th><th>Team B</th><th>Winner</th><th>Note</th></tr></thead>
			<tbody>
				{#each r.matches.filter((m) => m.roundNo === rn) as m (m.id)}
					<tr>
						<td>{m.room}</td><td class="l">{m.teamA}</td><td>{m.status === 'not_started' ? '' : m.status === 'forfeit' ? 'forfeit' : `${m.scoreA}–${m.scoreB}`}</td><td class="l">{m.teamB}</td>
						<td class="l">{m.status === 'not_started' ? '' : (m.winner ?? 'tie')}</td>
						<td class="l small">{[m.counts ? '' : 'non-counter', m.note, statusText[m.status]].filter(Boolean).join(', ')}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/each}

	<h2>Individual scores</h2>
	<p class="small">Counting games only. For staff; not for public posting.</p>
	{#each r.individuals as g (g.label)}
		<h3>{g.label}</h3>
		<table class="t">
			<thead><tr><th>Place</th><th>Player</th><th>Team</th><th>Games</th><th>Tossups</th><th>Negs</th><th>Points</th></tr></thead>
			<tbody>{#each g.rows as p (p.name + p.team)}<tr><td>{p.place}{p.tied ? ' (tie)' : ''}</td><td class="l">{p.name}</td><td class="l">{p.team}</td><td>{p.games}</td><td>{p.corrects}</td><td>{p.negs}</td><td>{p.points}</td></tr>{/each}</tbody>
		</table>
	{/each}
</div>

<style>
	.report {
		max-width: 8.5in;
		margin: 0 auto;
		padding: 16px;
		background: #fff;
		color: #000;
	}
	.bar {
		margin-bottom: 12px;
	}
	header {
		display: flex;
		gap: 16px;
		align-items: center;
		border-bottom: 3px solid var(--suscc-navy);
		padding-bottom: 8px;
	}
	header img {
		height: 32px;
	}
	h1 {
		margin: 0;
		font-size: 17pt;
	}
	h2 {
		font-size: 14pt;
		margin: 18px 0 6px;
		border-bottom: 1px solid #999;
	}
	h3 {
		font-size: 11.5pt;
		margin: 10px 0 4px;
	}
	.t {
		width: 100%;
		border-collapse: collapse;
		font-size: 9.5pt;
		break-inside: avoid;
	}
	.t th,
	.t td {
		border: 1px solid #888;
		padding: 2px 5px;
		text-align: center;
	}
	.t th {
		background: #e8ecf5;
	}
	.t .l {
		text-align: left;
	}
	.fn {
		font-size: 8.5pt;
		margin: 2px 0;
	}
	@media print {
		.report {
			padding: 0;
			max-width: none;
		}
	}
</style>
