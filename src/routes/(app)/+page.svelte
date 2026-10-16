<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Scholars' Bowl Scoring</title></svelte:head>

<div class="container">
	<h1>Scholars' Bowl Scoring</h1>
	<p class="muted">Southern Union State Community College</p>

	{#if data.needsSetup}
		<div class="alert info">This system has no accounts yet. <a href="/setup">Create the first administrator account</a>.</div>
	{/if}

	<div class="grid cols-2" style="margin-top: 24px">
		<a class="choice card" href="/room">
			<h2>Room scorer</h2>
			<p>Sign in with your room's PIN to score rounds.</p>
		</a>
		<a class="choice card" href="/login">
			<h2>Staff sign in</h2>
			<p>Administrators, head scorekeepers, check-in staff, and bracket builders.</p>
		</a>
	</div>
</div>

<style>
	.choice {
		display: block;
		text-decoration: none;
		color: inherit;
		border-left: 6px solid var(--suscc-blue);
		transition: transform 0.08s;
	}
	.choice:hover {
		transform: translateY(-2px);
		color: inherit;
	}
	.choice p {
		margin: 0;
		color: var(--muted);
	}
</style>
