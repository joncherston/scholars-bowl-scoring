<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	type Row = NonNullable<Extract<typeof form, { stage: 'preview' }>>['preview'][number];
	let rows = $state<Row[]>([]);
	let showSkipped = $state(false);
	let busy = $state(false);

	$effect(() => {
		if (form && 'stage' in form && form.stage === 'preview') rows = structuredClone(form.preview);
	});

	const actionLabel: Record<string, string> = { new: 'New team', update: 'Changed', withdraw: 'Withdraw', unchanged: 'No change', skip: 'Skipped' };
	const actionBadge: Record<string, string> = { new: 'info', update: 'warn', withdraw: 'bad', unchanged: '', skip: '' };
	const visible = $derived(rows.filter((r) => showSkipped || r.action !== 'skip'));
	const approved = $derived(rows.filter((r) => r.include && (r.action === 'new' || r.action === 'update' || r.action === 'withdraw')));
	const missingClass = $derived(approved.filter((r) => r.action !== 'withdraw' && !r.classification));
	const counts = $derived({
		new: approved.filter((r) => r.action === 'new').length,
		update: approved.filter((r) => r.action === 'update').length,
		withdraw: approved.filter((r) => r.action === 'withdraw').length,
		skipped: rows.filter((r) => r.action === 'skip').length,
		unchanged: rows.filter((r) => r.action === 'unchanged').length
	});
	const payload = $derived(
		JSON.stringify({
			filename: form && 'filename' in form ? form.filename : '',
			sha256: form && 'sha256' in form ? form.sha256 : '',
			rows: approved.map((r) => ({
				action: r.action,
				existingTeamId: r.existingTeamId,
				registrationId: r.registrationId,
				schoolName: r.schoolName,
				classification: r.classification,
				sessionId: r.sessionId,
				status: r.status,
				contactName: r.contactName,
				contactEmail: r.contactEmail,
				contactPhone: r.contactPhone,
				competingStudents: r.competingStudents,
				coaches: r.coaches
			}))
		})
	);
	const submitting = () => {
		busy = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = false;
		};
	};
</script>

<svelte:head><title>Import registrations · {data.event.name}</title></svelte:head>

<div class="container wide">
	<a href="/events/{data.event.id}/teams" class="small">← Teams</a>
	<h2>Import registrations</h2>
	{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}

	{#if form && 'stage' in form && form.stage === 'done'}
		<div class="alert success" role="status">
			Import complete: {form.result.created} new team(s), {form.result.updated} updated, {form.result.withdrawn} withdrawn. A backup was saved first.
		</div>
		<a class="btn" href="/events/{data.event.id}/teams">Go to Teams</a>
	{:else if form && 'stage' in form && form.stage === 'mapping'}
		<form method="POST" action="?/preview" class="card" use:enhance={submitting}>
			<h3>Match the columns</h3>
			<p class="muted">This file isn't the website's standard export, so tell us which column is which.</p>
			<input type="hidden" name="fileText" value={form.fileText} />
			<input type="hidden" name="filename" value={form.filename} />
			<input type="hidden" name="cutoff" value={form.cutoff ?? ''} />
			<input type="hidden" name="manualMapping" value="1" />
			<div class="grid cols-3">
				{#each Object.entries(data.fields) as [key, label] (key)}
					<div class="field">
						<label for="map_{key}">{label}{key === 'schoolName' ? ' *' : ''}</label>
						<select id="map_{key}" name="map_{key}" value={form.mapping[key as keyof typeof form.mapping] ?? ''}>
							<option value="">(not in file)</option>
							{#each form.headers as h (h)}<option value={h}>{h}</option>{/each}
						</select>
					</div>
				{/each}
			</div>
			<button class="btn" type="submit" disabled={busy}>Preview</button>
		</form>
	{:else if form && 'stage' in form && form.stage === 'preview'}
		<div class="card">
			<div class="row between">
				<div>
					<strong>{form.filename}</strong>
					{#if form.pluginLayout}<span class="badge ok">Website export detected</span>{/if}
					{#if form.cutoff}<span class="muted small"> · registrations on or after {form.cutoff}</span>{/if}
				</div>
				<label class="check small"><input type="checkbox" bind:checked={showSkipped} /> Show {counts.skipped} skipped row(s)</label>
			</div>
			{#if form.parseErrors.length}<div class="alert warning" style="margin-top: 10px">Some rows could not be read: {form.parseErrors.join('; ')}</div>{/if}
		</div>

		<div class="table-wrap" style="margin-top: 16px">
			<table class="data">
				<thead>
					<tr><th>Use</th><th>What happens</th><th>Team</th><th>Class</th><th>Session</th><th>Status</th><th class="num">Students</th><th>Notes</th></tr>
				</thead>
				<tbody>
					{#each visible as r (r.rowNumber)}
						<tr class:off={!r.include}>
							<td>
								<input type="checkbox" bind:checked={r.include} disabled={r.action === 'skip' || r.action === 'unchanged'} aria-label="Use registration {r.registrationId ?? r.rowNumber}" />
							</td>
							<td><span class="badge {actionBadge[r.action]}">{actionLabel[r.action]}</span></td>
							<td>
								{#if r.action === 'new'}
									<input type="text" bind:value={r.schoolName} aria-label="Team name" />
								{:else}{r.schoolName}{/if}
								<div class="muted small">#{r.registrationId ?? '—'} · {r.contactName ?? ''} {r.registeredAt ? `· ${r.registeredAt.slice(0, 10)}` : ''}</div>
								{#if r.changes.length}
									<ul class="changes">{#each r.changes as c (c.field)}<li>{c.field}: <s>{c.from}</s> → {c.to}</li>{/each}</ul>
								{/if}
							</td>
							<td>
								{#if r.action === 'new' || r.action === 'update'}
									<select bind:value={r.classification} aria-label="Classification" class:missing={r.include && !r.classification}>
										<option value="">Choose…</option>
										{#each data.event.classifications as c (c)}<option value={c}>{c}</option>{/each}
									</select>
								{:else}{r.classification}{/if}
							</td>
							<td>
								{#if r.action === 'new' || r.action === 'update'}
									<select bind:value={r.sessionId} aria-label="Session">
										<option value={null}>None</option>
										{#each data.sessions as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
									</select>
								{/if}
							</td>
							<td class="small">{r.status}</td>
							<td class="num">{r.competingStudents ?? ''}</td>
							<td class="small">{r.notes.join('. ')}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<form method="POST" action="?/apply" class="card sticky" use:enhance={submitting}>
			<input type="hidden" name="payload" value={payload} />
			<div class="row between">
				<div>
					Will add <strong>{counts.new}</strong>, update <strong>{counts.update}</strong>, withdraw <strong>{counts.withdraw}</strong>.
					<span class="muted small">{counts.unchanged} unchanged, {counts.skipped} skipped.</span>
					{#if missingClass.length}<div class="small" style="color: var(--danger)">Choose a classification for {missingClass.map((r) => r.schoolName).join(', ')}.</div>{/if}
				</div>
				<div class="row">
					<a class="btn ghost" href="/events/{data.event.id}/teams/import">Start over</a>
					<button class="btn large" type="submit" disabled={busy || approved.length === 0 || missingClass.length > 0}>Apply approved changes</button>
				</div>
			</div>
		</form>
	{:else}
		<form method="POST" action="?/preview" enctype="multipart/form-data" class="card" style="max-width: 720px" use:enhance={submitting}>
			<h3>Upload the registration CSV</h3>
			<ol class="small">
				<li>On the website, go to <strong>WP Admin → Scholars' Bowl → Registrations</strong> and click <strong>Export to CSV</strong>.</li>
				<li>Upload that file here. Nothing changes until you review and approve the preview.</li>
				<li>Re-importing a newer export later is safe: registrations are matched by their ID.</li>
			</ol>
			<div class="field"><label for="file">CSV file</label><input id="file" name="file" type="file" accept=".csv,text/csv" required /></div>
			<div class="field">
				<label for="cutoff">Only registrations on or after <span class="hint">(the export includes earlier years)</span></label>
				<input id="cutoff" name="cutoff" type="date" value={data.defaultCutoff} style="max-width: 220px" />
			</div>
			<button class="btn" type="submit" disabled={busy}>Preview</button>
		</form>
		<div class="card" style="max-width: 720px">
			<h3>Pull from the website</h3>
			<p class="muted small">Available after the registration plugin is updated to version 1.0.7 and connected in Admin settings.</p>
		</div>
	{/if}
</div>

<style>
	tr.off td {
		opacity: 0.55;
	}
	.changes {
		margin: 4px 0 0;
		padding-left: 18px;
		font-size: 0.85rem;
	}
	.missing {
		border-color: var(--danger);
		box-shadow: 0 0 0 1px var(--danger);
	}
	.sticky {
		position: sticky;
		bottom: 0;
		margin-top: 16px;
		border-top: 3px solid var(--suscc-blue);
	}
	td input[type='text'] {
		min-width: 220px;
	}
	td select {
		min-width: 120px;
	}
</style>
