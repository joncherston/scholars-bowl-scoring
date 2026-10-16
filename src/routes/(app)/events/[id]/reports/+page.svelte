<script lang="ts">
	let { data } = $props();
	const base = $derived(`/events/${data.event.id}/reports`);
	const pdf = (path: string, name: string) => `${base}/pdf?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;
</script>

<svelte:head><title>Reports · {data.event.name}</title></svelte:head>

<div class="container wide">
	<h2>Reports</h2>
	<p class="muted">Every report is calculated from the scoring log when you open it. Sessions that aren't finalized are marked <strong>provisional</strong>.</p>

	<div class="card">
		<h3>Whole event</h3>
		<div class="row">
			<a class="btn" href="{base}/awards">Awards sheet</a>
			<a class="btn secondary" href={pdf(`${base}/awards`, 'awards')}>Awards sheet PDF</a>
			<a class="btn secondary" href="{base}/export.xlsx">Excel workbook (.xlsx)</a>
		</div>
	</div>

	{#each data.sessionList as s (s.id)}
		<div class="card">
			<div class="row between">
				<h3>{s.name}</h3>
				{#if s.finalizedAt}<span class="badge ok">Finalized</span>{:else}<span class="badge warn">Provisional</span>{/if}
			</div>
			<div class="row">
				<a class="btn secondary" href="{base}/awards?session={s.id}">Awards</a>
				<a class="btn secondary" href={pdf(`${base}/awards?session=${s.id}`, `awards-${s.name}`)}>Awards PDF</a>
				<a class="btn secondary" href="{base}/results?session={s.id}">Full results</a>
				<a class="btn secondary" href={pdf(`${base}/results?session=${s.id}`, `results-${s.name}`)}>Full results PDF</a>
				<a class="btn secondary" href="{base}/scoresheets?session={s.id}">Completed scoresheets</a>
				<a class="btn secondary" href={pdf(`${base}/scoresheets?session=${s.id}`, `scoresheets-${s.name}`)}>Completed scoresheets PDF</a>
			</div>
			<p class="small muted" style="margin: 12px 0 4px">Blank paper scoresheets (teams and players filled in), for a paper backup:</p>
			<div class="row">
				{#each Array.from({ length: s.roundCount }, (_, i) => i + 1) as r (r)}
					<a class="btn small secondary" href={pdf(`${base}/scoresheets?session=${s.id}&round=${r}&blank=1`, `blank-scoresheets-${s.name}-round-${r}`)}>Round {r}</a>
				{/each}
				<a class="btn small" href={pdf(`${base}/scoresheets?session=${s.id}&blank=1`, `blank-scoresheets-${s.name}`)}>All rounds</a>
			</div>
		</div>
	{/each}
	<p class="muted small">Per-round audit printouts are on each round's page in the Live dashboard (Print audit sheet).</p>
</div>
