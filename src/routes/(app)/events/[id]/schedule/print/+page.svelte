<script lang="ts">
	let { data } = $props();
	const name = (id: number) => data.teams.find((t) => t.id === id)?.name ?? '?';
	const rounds = $derived(Array.from({ length: data.session.roundCount }, (_, i) => i + 1));
	const cell = (r: number, roomId: number) => data.matches.find((m) => m.roundNo === r && m.roomId === roomId);
	const fmtTime = (t?: string) => {
		if (!t) return '';
		const [h, m] = t.split(':').map(Number);
		return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	};
	const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
</script>

<svelte:head><title>{data.session.name} schedule · {data.event.name}</title></svelte:head>

<div class="sheet">
	<div class="no-print bar">
		<button class="btn" type="button" onclick={() => window.print()}>Print</button>
		<span class="muted small">{data.session.scheduleStatus === 'published' ? 'Published schedule' : 'DRAFT — not yet published'}</span>
	</div>

	{#if !data.roomSheets}
		<header>
			<img src="/suscc-logo-navy.svg" alt="Southern Union State Community College" />
			<div>
				<h1>{data.event.name}{data.event.isTest ? ' (PRACTICE)' : ''}</h1>
				<div>{data.session.name} session · {fmtDate(data.session.date)} · Arrival {fmtTime(data.session.startTime)}</div>
				{#if data.session.scheduleStatus !== 'published'}<div class="draft">DRAFT</div>{/if}
			</div>
		</header>
		<table class="print">
			<thead>
				<tr>
					<th>Round</th>
					{#each data.rooms as r (r.id)}<th>{r.name}{#if r.moderator}<div class="sub">{r.moderator}</div>{/if}</th>{/each}
				</tr>
			</thead>
			<tbody>
				{#each rounds as rn (rn)}
					<tr>
						<th>{rn}<div class="sub">{fmtTime(data.session.roundTimes[rn - 1])}</div></th>
						{#each data.rooms as room (room.id)}
							{@const m = cell(rn, room.id)}
							<td>
								{#if m}{name(m.teamA)}<div class="sub">vs</div>{name(m.teamB)}{#if !m.counts}<div class="nc">non-counter</div>{/if}{/if}
							</td>
						{/each}
					</tr>
					{#if data.byes[rn]?.length}
						<tr class="byes"><td colspan={data.rooms.length + 1}>Round {rn} bye: {data.byes[rn].map(name).join(', ')}</td></tr>
					{/if}
				{/each}
			</tbody>
		</table>
	{:else}
		{#each data.rooms as room (room.id)}
			<section class="room-sheet">
				<header>
					<img src="/suscc-logo-navy.svg" alt="Southern Union State Community College" />
					<div>
						<h1>{room.name}</h1>
						<div>{data.event.name}{data.event.isTest ? ' (PRACTICE)' : ''} · {data.session.name} session · {fmtDate(data.session.date)}</div>
						<div>Moderator: <strong>{room.moderator ?? '______________________'}</strong></div>
					</div>
				</header>
				<table class="print">
					<thead><tr><th>Round</th><th>Time</th><th>Team A</th><th>Team B</th><th>Type</th></tr></thead>
					<tbody>
						{#each rounds as rn (rn)}
							{@const m = cell(rn, room.id)}
							<tr>
								<th>{rn}</th>
								<td>{fmtTime(data.session.roundTimes[rn - 1])}</td>
								{#if m}
									<td>{name(m.teamA)}</td>
									<td>{name(m.teamB)}</td>
									<td>{m.counts ? 'Counts' : 'Non-counter'}</td>
								{:else}
									<td colspan="3" class="sub">No game this round</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="sub">Announce the score after tossup 12. If a round ends tied, play sudden-death tiebreaker tossups.</p>
			</section>
		{/each}
	{/if}
</div>

<style>
	:global(body) {
		background: #fff;
	}
	.sheet {
		max-width: 1100px;
		margin: 0 auto;
		padding: 20px;
		color: #000;
	}
	.bar {
		margin-bottom: 16px;
		display: flex;
		gap: 12px;
		align-items: center;
	}
	header {
		display: flex;
		gap: 18px;
		align-items: center;
		border-bottom: 3px solid var(--suscc-navy);
		padding-bottom: 10px;
		margin-bottom: 14px;
	}
	header img {
		height: 34px;
	}
	h1 {
		margin: 0;
		font-size: 1.4rem;
	}
	.draft {
		color: #b42318;
		font-weight: 800;
		letter-spacing: 0.1em;
	}
	table.print {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	table.print th,
	table.print td {
		border: 1px solid #555;
		padding: 6px;
		text-align: center;
		vertical-align: middle;
	}
	table.print thead th {
		background: #e8ecf5;
	}
	.sub {
		font-size: 0.75rem;
		color: #444;
		font-weight: 400;
	}
	.nc {
		font-size: 0.72rem;
		font-style: italic;
	}
	tr.byes td {
		text-align: left;
		font-size: 0.8rem;
		background: #f7f7f7;
	}
	.room-sheet {
		break-after: page;
		margin-bottom: 40px;
	}
	.room-sheet td,
	.room-sheet th {
		font-size: 1.05rem;
		padding: 10px;
	}
	@page {
		margin: 0.5in;
	}
</style>
