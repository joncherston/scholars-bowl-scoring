<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	const base = $derived(`/events/${data.event.id}`);
	const totalNew = $derived(form && 'rounds' in form && form.rounds ? form.rounds.reduce((a, r) => a + r.fresh.length, 0) : 0);
</script>

<svelte:head><title>Import a results file · {data.event.name}</title></svelte:head>

<div class="container" style="max-width: 900px">
	<a class="small" href="{base}/live">← Live dashboard</a>
	<h2>Import a scorer's results file</h2>
	<p class="muted">When a room computer couldn't reach the server, the scorer can save a results file to a flash drive (Menu → Download results file). Upload it here; actions already on the server are skipped automatically.</p>
	{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}

	{#if form && 'stage' in form && form.stage === 'done'}
		<div class="alert success" role="status">Imported {form.accepted} new action(s). {form.duplicate} were already on the server{form.rejected ? `, ${form.rejected} could not be added` : ''}. A backup was taken first.</div>
		<a class="btn" href="{base}/live">Back to the dashboard</a>
	{:else if form && 'stage' in form && form.stage === 'preview'}
		<div class="card">
			<p><strong>{form.filename}</strong> · {form.roomName} · saved {new Date(form.exportedAt).toLocaleString()}</p>
			{#if !form.checksumOk}<div class="alert warning">The file's checksum doesn't match its contents, so it may have been edited. Review carefully before importing.</div>{/if}
			{#each form.rounds as r (r.matchId)}
				<div class="round">
					<h3>{r.label}</h3>
					<p class="small muted">{r.total} action(s) in the file · {r.onServer} already on the server · <strong>{r.fresh.length} new</strong></p>
					{#if r.fresh.length && (r.status === 'submitted' || r.status === 'approved')}
						<div class="alert warning small">This round was already {r.status}. Adding these actions changes it and it will need to be approved again.</div>
					{/if}
					{#if r.fresh.length}
						<ol class="small">{#each r.fresh as e (e.id)}<li>{e.text}{#if e.rejected}&nbsp;<span class="badge warn">previously rejected: {e.rejected}</span>{/if}</li>{/each}</ol>
					{/if}
				</div>
			{/each}
		</div>
		<form method="POST" action="?/apply" use:enhance class="row" style="margin-top: 12px">
			<input type="hidden" name="text" value={form.text} />
			<button class="btn large" type="submit" disabled={totalNew === 0}>Import {totalNew} new action(s)</button>
			<a class="btn secondary" href="{base}/live/import">Choose a different file</a>
		</form>
	{:else}
		<form method="POST" action="?/preview" enctype="multipart/form-data" class="card" use:enhance>
			<div class="field"><label for="file">Results file (.json)</label><input id="file" name="file" type="file" accept=".json,application/json" required /></div>
			<button class="btn" type="submit">Preview</button>
		</form>
	{/if}
</div>

<style>
	.round + .round {
		border-top: 1px solid var(--border);
		margin-top: 12px;
		padding-top: 12px;
	}
</style>
