<script lang="ts">
	let { data } = $props();
	const fmt = (d: string) =>
		new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
</script>

<svelte:head><title>Events · Scholars' Bowl Scoring</title></svelte:head>

<div class="container">
	<div class="row between">
		<h1>Events</h1>
		{#if data.isAdmin}<a class="btn" href="/events/new">Start a new event</a>{/if}
	</div>
	{#if data.events.length === 0}
		<div class="card">
			<p>No events yet.</p>
			{#if !data.isAdmin}<p class="muted">You'll see events here once an administrator adds you to an event's staff.</p>{/if}
		</div>
	{:else}
		<div class="stack">
			{#each data.events as e (e.id)}
				<a class="card event" href="/events/{e.id}">
					<div class="row between">
						<h2>{e.name}</h2>
						<div class="row">
							{#if e.isTest}<span class="badge test">PRACTICE / TEST</span>{/if}
							<span class="badge">{e.status}</span>
						</div>
					</div>
					<div class="muted">{fmt(e.eventDate)}</div>
				</a>
			{/each}
		</div>
	{/if}
</div>

<style>
	.event {
		display: block;
		text-decoration: none;
		color: inherit;
	}
	.event h2 {
		margin: 0;
	}
	.event:hover {
		border-color: var(--suscc-blue);
		color: inherit;
	}
</style>
