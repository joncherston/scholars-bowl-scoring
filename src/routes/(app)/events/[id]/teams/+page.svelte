<script lang="ts">
	let { data, form } = $props();
	let editing = $state<number | null>(null);
	let filter = $state('');
	let showAdd = $state(false);

	const sessionName = (id: number | null) => data.sessionList.find((s) => s.id === id)?.name ?? 'No session';
	const groups = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		const visible = data.teams.filter((t) => !q || t.name.toLowerCase().includes(q) || t.schoolName.toLowerCase().includes(q));
		const order = data.event.classifications;
		const keys = [...data.sessionList.map((s) => s.id as number | null), null];
		return keys
			.map((sid) => ({
				sessionId: sid,
				name: sessionName(sid),
				teams: visible
					.filter((t) => t.sessionId === sid)
					.sort((a, b) => order.indexOf(a.classification) - order.indexOf(b.classification) || a.name.localeCompare(b.name))
			}))
			.filter((g) => g.teams.length || g.sessionId !== null);
	});
	const active = $derived(data.teams.filter((t) => !t.withdrawn).length);
</script>

<svelte:head><title>Teams · {data.event.name}</title></svelte:head>

<div class="container wide">
	<div class="row between">
		<h2>Teams <span class="muted small">{active} active</span></h2>
		<div class="row">
			<input type="search" placeholder="Find a team" bind:value={filter} aria-label="Find a team" style="width: 220px" />
			<button class="btn secondary" type="button" onclick={() => (showAdd = !showAdd)}>Add a team by hand</button>
			{#if data.can.admin}<a class="btn" href="/events/{data.event.id}/teams/import">Import registrations</a>{/if}
		</div>
	</div>
	{#if form && 'message' in form}<div class="alert success" role="status">{form.message}</div>{/if}
	{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}

	{#if showAdd}
		<form method="POST" action="?/add" class="card">
			<h3>Add a team</h3>
			<p class="muted small">For walk-ins and events that don't use the website registration. For two teams from one school, end the names with A and B (e.g. "Riverbend Christian A").</p>
			<div class="grid cols-3">
				<div class="field"><label for="add-name">Team name</label><input id="add-name" name="name" type="text" required /></div>
				<div class="field">
					<label for="add-class">Classification</label>
					<select id="add-class" name="classification" required>
						<option value="">Choose…</option>
						{#each data.event.classifications as c (c)}<option value={c}>{c}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="add-session">Session</label>
					<select id="add-session" name="sessionId">
						{#each data.sessionList as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
					</select>
				</div>
				<div class="field"><label for="add-contact">Coach / contact <span class="hint">(optional)</span></label><input id="add-contact" name="contactName" type="text" /></div>
				<div class="field"><label for="add-email">Contact email <span class="hint">(optional)</span></label><input id="add-email" name="contactEmail" type="email" /></div>
			</div>
			<button class="btn" type="submit">Add team</button>
		</form>
	{/if}

	{#if data.teams.length === 0}
		<div class="card">
			<p>No teams yet.</p>
			<p class="muted">Upload the registration CSV from the website (WordPress → Scholars' Bowl → Registrations → Export to CSV), or add teams by hand.</p>
		</div>
	{/if}

	{#each groups as g (g.sessionId)}
		<h3 style="margin-top: 20px">{g.name} <span class="muted small">{g.teams.filter((t) => !t.withdrawn).length} teams</span></h3>
		{#if g.teams.length}
			<div class="table-wrap">
				<table class="data">
					<thead>
						<tr><th>Team</th><th>Class</th><th>Contact</th><th class="num">Registered students</th><th class="num">Players entered</th><th>Status</th><th></th></tr>
					</thead>
					<tbody>
						{#each g.teams as t (t.id)}
							{#if editing === t.id}
								<tr>
									<td colspan="7">
										<form method="POST" action="?/update" class="edit" onsubmit={() => setTimeout(() => (editing = null), 50)}>
											<input type="hidden" name="teamId" value={t.id} />
											<div class="grid cols-3">
												<div class="field"><label for="n-{t.id}">Team name</label><input id="n-{t.id}" name="name" type="text" value={t.name} required /></div>
												<div class="field">
													<label for="sd-{t.id}">School short name <span class="hint">(used on printouts)</span></label>
													<input id="sd-{t.id}" name="schoolDisplayName" type="text" value={t.schoolDisplayName} />
												</div>
												<div class="field">
													<label for="c-{t.id}">Classification</label>
													<select id="c-{t.id}" name="classification" value={t.classification}>
														{#each data.event.classifications as c (c)}<option value={c}>{c}</option>{/each}
													</select>
												</div>
												<div class="field">
													<label for="s-{t.id}">Session</label>
													<select id="s-{t.id}" name="sessionId" value={t.sessionId ?? ''}>
														<option value="">No session</option>
														{#each data.sessionList as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
													</select>
												</div>
											</div>
											<label class="check"><input type="checkbox" name="withdrawn" checked={t.withdrawn} /> Withdrawn (not coming)</label>
											{#if t.registrationName && t.registrationName !== t.name}<p class="muted small">Registered as "{t.registrationName}".</p>{/if}
											<div class="row" style="margin-top: 10px">
												<button class="btn" type="submit">Save</button>
												<button class="btn ghost" type="button" onclick={() => (editing = null)}>Cancel</button>
											</div>
										</form>
									</td>
								</tr>
							{:else}
								<tr class:withdrawn={t.withdrawn}>
									<td>
										<strong>{t.name}</strong>
										{#if t.source !== 'manual'}<div class="muted small">Registration #{t.registrationId}</div>{/if}
									</td>
									<td>{t.classification}</td>
									<td class="small">{t.contactName ?? ''}{#if t.contactEmail}<div class="muted">{t.contactEmail}</div>{/if}</td>
									<td class="num">{t.competingStudents ?? '—'}</td>
									<td class="num">{t.players}</td>
									<td>
										{#if t.withdrawn}<span class="badge bad">Withdrawn</span>
										{:else if t.arrivedAt}<span class="badge ok">Checked in</span>
										{:else if t.registrationStatus === 'pending'}<span class="badge warn">Registration pending</span>
										{:else}<span class="badge">Not arrived</span>{/if}
									</td>
									<td><button class="btn small secondary" type="button" onclick={() => (editing = t.id)}>Edit</button></td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="muted">No teams in this session yet.</p>
		{/if}
	{/each}
</div>

<style>
	tr.withdrawn td {
		color: var(--muted);
	}
	tr.withdrawn strong {
		text-decoration: line-through;
	}
	.edit {
		padding: 8px 0;
	}
</style>
