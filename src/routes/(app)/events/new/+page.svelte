<script lang="ts">
	let { data, form } = $props();
	// svelte-ignore state_referenced_locally
	let source = $state(form?.source ?? 'template:high-school');
	const year = new Date().getFullYear();
</script>

<svelte:head><title>Start a new event · Scholars' Bowl Scoring</title></svelte:head>

<div class="container" style="max-width: 760px">
	<h1>Start a new event</h1>
	{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}

	<form method="POST" action="?/create" class="card">
		<h2>1. The event</h2>
		<div class="field">
			<label for="name">Event name</label>
			<input id="name" name="name" type="text" required value={form?.name ?? `High School Scholars' Bowl ${year}`} />
		</div>
		<div class="grid cols-2">
			<div class="field">
				<label for="eventDate">Date</label>
				<input id="eventDate" name="eventDate" type="date" required value={form?.eventDate ?? ''} />
			</div>
			<div class="field">
				<label for="roomCount">Number of rooms <span class="hint">(named Room 1, Room 2, …)</span></label>
				<input id="roomCount" name="roomCount" type="number" min="1" max="40" required value={form?.roomCount ?? 8} />
			</div>
		</div>
		<label class="check"><input type="checkbox" name="isTest" checked={form?.isTest ?? false} /> Practice / test event (labeled everywhere and never shown publicly)</label>

		<h2 style="margin-top: 24px">2. Scoring settings</h2>
		<p class="muted small">Settings belong to this event only. You can change them on the event's Settings page.</p>
		<fieldset class="choices">
			<legend class="sr-only">Start settings from</legend>
			{#each data.templates as t (t.id)}
				<label class="check"><input type="radio" name="source" value="template:{t.id}" bind:group={source} /> Template: {t.name}</label>
			{/each}
			{#each data.events as e (e.id)}
				<label class="check">
					<input type="radio" name="source" value="event:{e.id}" bind:group={source} />
					Copy from {e.name} ({e.eventDate}){#if e.isTest}&nbsp;<span class="badge test">TEST</span>{/if}
				</label>
			{/each}
		</fieldset>
		{#if source.startsWith('event:')}
			<div class="alert info small">
				Copies scoring rules, award settings, sessions, and classifications. Schools, students, room PINs, and scores are never copied.
				<label class="check" style="margin-top: 8px"><input type="checkbox" name="copyRooms" checked /> Also copy room names</label>
			</div>
		{/if}

		<h2 style="margin-top: 24px">3. Teams</h2>
		<p class="muted small">After creating the event you can upload the registration CSV, add teams by hand, or (after the plugin update) pull registrations from the website.</p>

		<button class="btn large" type="submit">Create event</button>
	</form>

	<form method="POST" action="?/practice" class="card">
		<h2>Practice event with fictional data</h2>
		<p class="muted">Creates a test event filled with fictional schools and students, a schedule, and room PINs, for training and the dry run. It is labeled as a test everywhere and never appears on public pages.</p>
		<button class="btn secondary" type="submit">Create practice event</button>
	</form>
</div>

<style>
	.choices {
		border: 0;
		padding: 0;
		margin: 0 0 12px;
		display: grid;
		gap: 8px;
	}
</style>
