<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Room PIN cards · {data.event.name}</title></svelte:head>

<div class="no-print" style="margin-bottom: 16px">
	<button class="btn" type="button" onclick={() => window.print()}>Print</button>
	<span class="muted small">One card per room. Keep these with the room scorer packets.</span>
</div>
<div class="cards">
	{#each data.rooms as r (r.id)}
		<div class="pincard">
			<div class="ev">{data.event.name}{data.event.isTest ? ' — PRACTICE' : ''}</div>
			<div class="room">{r.name}</div>
			{#if r.practice}<div class="practice">Practice / bye room — scores here never count</div>{/if}
			<div class="lbl">Scorer sign-in</div>
			<div class="url">{data.origin.replace(/^https?:\/\//, '')}/room</div>
			<div class="lbl">Room PIN</div>
			<div class="pin">{r.pin}</div>
		</div>
	{/each}
</div>

<style>
	.cards {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 16px;
	}
	.pincard {
		border: 2px solid var(--suscc-navy);
		border-radius: 10px;
		padding: 18px;
		text-align: center;
		break-inside: avoid;
		background: #fff;
	}
	.practice {
		margin-top: 4px;
		font-weight: 700;
		color: #6b5000;
	}
	.ev {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.room {
		font-family: var(--font-head);
		font-size: 2rem;
		font-weight: 800;
		color: var(--suscc-navy);
		margin: 4px 0 10px;
	}
	.lbl {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}
	.url {
		font-weight: 700;
		margin-bottom: 8px;
	}
	.pin {
		font-family: var(--font-num);
		font-size: 2.6rem;
		font-weight: 800;
		letter-spacing: 0.15em;
	}
</style>
