<script lang="ts">
	let { data } = $props();
	const base = $derived(`/events/${data.event.id}`);
	const fmtTime = (t: string) => {
		const [h, m] = t.split(':').map(Number);
		return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	};
</script>

<svelte:head><title>{data.event.name} · Scholars' Bowl Scoring</title></svelte:head>

<div class="container wide">
	<div class="grid cols-3">
		{#if data.can.admin}
			<a class="card tile" href="{base}/setup/settings">
				<h2>Scoring settings</h2>
				<p>
					{#if data.confirmed < data.confirmTotal}
						<span class="badge warn">{data.confirmTotal - data.confirmed} to confirm before event</span>
					{:else}
						<span class="badge ok">All confirmed</span>
					{/if}
				</p>
			</a>
			<a class="card tile" href="{base}/setup/rooms">
				<h2>Rooms and PINs</h2>
				<p>{data.rooms} rooms</p>
			</a>
			<a class="card tile" href="{base}/setup/staff">
				<h2>Staff</h2>
				<p>
					{data.staff.head} head scorekeeper{data.staff.head === 1 ? '' : 's'} · {data.staff.checkin} check-in · {data.staff.bracket} bracket builder{data.staff.bracket === 1 ? '' : 's'}
				</p>
			</a>
		{/if}
	</div>

	<h2 style="margin-top: 24px">Sessions</h2>
	{#if data.unassignedTeams}
		<div class="alert warning">{data.unassignedTeams} team(s) are not assigned to a session. <a href="{base}/teams">Fix on the Teams page</a>.</div>
	{/if}
	<div class="grid cols-2">
		{#each data.sessions as s (s.id)}
			<div class="card">
				<div class="row between">
					<h3>{s.name} <span class="muted small">{fmtTime(s.startTime)}</span></h3>
					{#if s.finalized}<span class="badge ok">Finalized</span>{/if}
				</div>
				<p class="muted small">{s.classifications.join(', ')}</p>
				<ul class="facts">
					<li><strong>{s.teams}</strong> teams · <strong>{s.arrived}</strong> checked in</li>
					<li>
						Schedule: {#if s.matches === 0}<span class="badge warn">not built</span>{:else if s.scheduleStatus === 'published'}<span class="badge ok">published</span> {s.matches} games{:else}<span class="badge info">draft</span> {s.matches} games{/if}
					</li>
				</ul>
				<div class="row">
					{#if data.can.checkin}<a class="btn small secondary" href="{base}/checkin?session={s.id}">Check-in</a>{/if}
					{#if data.can.schedule}<a class="btn small secondary" href="{base}/schedule?session={s.id}">Schedule</a>{/if}
					{#if data.can.live}<a class="btn small secondary" href="{base}/live?session={s.id}">Live</a>{/if}
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.tile {
		display: block;
		text-decoration: none;
		color: inherit;
	}
	.tile:hover {
		border-color: var(--suscc-blue);
		color: inherit;
	}
	.tile p {
		margin: 0;
	}
	.facts {
		list-style: none;
		padding: 0;
		margin: 0 0 12px;
	}
</style>
