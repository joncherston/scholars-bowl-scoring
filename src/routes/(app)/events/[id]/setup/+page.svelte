<script lang="ts">
	let { data, form } = $props();
	const e = $derived(data.event);
</script>

<svelte:head><title>Event details · {e.name}</title></svelte:head>

<h2>Event details</h2>
{#if form?.ok}<div class="alert success" role="status">Saved.</div>{/if}
{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}
<form method="POST" class="card" style="max-width: 720px">
	<div class="field">
		<label for="name">Event name</label>
		<input id="name" name="name" type="text" required value={e.name} />
	</div>
	<div class="grid cols-2">
		<div class="field">
			<label for="eventDate">Date</label>
			<input id="eventDate" name="eventDate" type="date" required value={e.eventDate} />
		</div>
		<div class="field">
			<label for="status">Status</label>
			<select id="status" name="status" value={e.status}>
				<option value="setup">Setup</option>
				<option value="active">Active (event day)</option>
				<option value="finalized">Finalized</option>
				<option value="archived">Archived</option>
			</select>
		</div>
	</div>
	<div class="field">
		<label for="classifications">Classifications <span class="hint">(comma-separated, in award order)</span></label>
		<input id="classifications" name="classifications" type="text" value={e.classifications.join(', ')} />
	</div>
	<label class="check"><input type="checkbox" name="isTest" checked={e.isTest} /> Practice / test event</label>
	<label class="check" style="margin-top: 8px">
		<input type="checkbox" name="publicResults" checked={e.publicResults} disabled={e.isTest} />
		Show team standings and match results on the public results page (never student names)
	</label>
	<div style="margin-top: 16px"><button class="btn" type="submit">Save</button></div>
</form>
