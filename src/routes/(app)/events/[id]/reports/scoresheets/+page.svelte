<script lang="ts">
	import Scoresheet from '$lib/components/Scoresheet.svelte';
	let { data } = $props();
</script>

<svelte:head><title>{data.blank ? 'Blank' : 'Completed'} scoresheets · {data.event.name}</title></svelte:head>

<div class="wrap">
	<div class="no-print bar">
		<button class="btn" type="button" onclick={() => window.print()}>Print</button>
		<span class="muted">{data.sheets.length} sheet(s)</span>
	</div>
	{#each data.sheets as s (s.match.id)}
		<Scoresheet eventName={data.event.name} isTest={data.event.isTest} match={s.match} date={s.session.date} moderator={s.moderator} result={s.result} blank={data.blank} />
	{:else}
		<p class="muted">No {data.blank ? 'scheduled' : 'scored'} rounds.</p>
	{/each}
</div>

<style>
	.wrap {
		padding: 16px;
	}
	.bar {
		max-width: 8.5in;
		margin: 0 auto 12px;
		display: flex;
		gap: 12px;
		align-items: center;
	}
	@media print {
		.wrap {
			padding: 0;
		}
	}
</style>
