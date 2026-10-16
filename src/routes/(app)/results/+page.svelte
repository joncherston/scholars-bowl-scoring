<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Results · Scholars' Bowl</title></svelte:head>

<div class="container">
	<h1>Scholars' Bowl results</h1>
	{#each data.list as e (e.id)}
		<a class="card ev" href="/results/{e.id}"><h2>{e.name}</h2><span class="muted">{new Date(`${e.eventDate}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span></a>
	{:else}
		<p class="muted">No results have been posted yet.</p>
	{/each}
</div>

<style>
	.ev {
		display: block;
		text-decoration: none;
		color: inherit;
	}
	.ev h2 {
		margin: 0;
	}
</style>
