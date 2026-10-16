<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let q = $state('');
	// Opened from the Teams tab with ?team=ID: start on that team.
	// svelte-ignore state_referenced_locally
	let selectedId = $state<number | null>(data.teamParam);
	let editing = $state<string | null>(null);

	const base = $derived(`/events/${data.event.id}/checkin`);
	const notArrived = $derived(data.teams.filter((t) => !t.arrivedAt));
	const filtered = $derived(
		data.teams
			.filter((t) => !q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase()))
			.sort((a, b) => Number(!!a.arrivedAt) - Number(!!b.arrivedAt) || a.name.localeCompare(b.name))
	);
	const selected = $derived(data.teams.find((t) => t.id === selectedId) ?? null);
	const grades = ['', '9', '10', '11', '12', '6', '7', '8'];
	const formError = $derived(
		form && 'error' in form ? { error: String(form.error), teamId: 'teamId' in form ? (form.teamId as number) : null } : null
	);
	const keep = () => async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
		await update({ reset: false });
	};
	const resetOnSuccess = () => async ({ update, result }: { update: (o?: { reset?: boolean }) => Promise<void>; result: { type: string } }) => {
		await update({ reset: result.type === 'success' });
		if (result.type === 'success') (document.getElementById('first-name') as HTMLInputElement | null)?.focus();
	};
</script>

<svelte:head><title>Check-in · {data.event.name}</title></svelte:head>

<div class="container wide">
	<div class="row between">
		<nav class="row" aria-label="Session">
			{#each data.sessions as s (s.id)}
				<a class="btn {s.id === data.sessionId ? '' : 'secondary'}" href="{base}?session={s.id}" aria-current={s.id === data.sessionId ? 'page' : undefined}>{s.name}</a>
			{/each}
		</nav>
		<div class="summary">
			<strong>{data.teams.length - notArrived.length}</strong> of <strong>{data.teams.length}</strong> teams checked in
		</div>
	</div>

	{#if notArrived.length && data.teams.length}
		<div class="alert warning" style="margin-top: 14px">
			<strong>Not checked in yet:</strong> {notArrived.map((t) => t.name).join(', ')}
		</div>
	{/if}

	<div class="desk">
		<div class="list card">
			<input type="search" placeholder="Search schools" bind:value={q} aria-label="Search schools" />
			<ul>
				{#each filtered as t (t.id)}
					<li>
						<button type="button" class="team" class:sel={t.id === selectedId} onclick={() => ((selectedId = t.id), (editing = null))}>
							<span class="dot" class:in={!!t.arrivedAt} aria-hidden="true"></span>
							<span class="nm">{t.name}<span class="muted small"> · {t.classification}</span></span>
							<span class="small {t.roster.length === 0 ? 'warnc' : 'muted'}">{t.roster.length}/{data.maxPlayers}</span>
							<span class="sr-only">{t.arrivedAt ? 'checked in' : 'not checked in'}</span>
						</button>
					</li>
				{:else}
					<li class="muted" style="padding: 12px">No teams in this session.</li>
				{/each}
			</ul>
		</div>

		<div class="detail">
			{#if !selected}
				<div class="card muted">Choose a school on the left to check it in and enter its players.</div>
			{:else}
				<div class="card">
					<div class="row between">
						<div>
							<h2 style="margin: 0">{selected.name}</h2>
							<div class="muted">{selected.classification} · {selected.contactName ?? 'No contact listed'}{selected.competingStudents ? ` · registered ${selected.competingStudents} students` : ''}</div>
						</div>
						<form method="POST" action="?/arrive" use:enhance={keep}>
							<input type="hidden" name="teamId" value={selected.id} />
							<input type="hidden" name="arrived" value={selected.arrivedAt ? '0' : '1'} />
							{#if selected.arrivedAt}
								<span class="badge ok" style="font-size: 1rem; padding: 6px 12px">✓ Checked in</span>
								<button class="btn ghost small" type="submit">Undo</button>
							{:else}
								<button class="btn large" type="submit">Mark arrived</button>
							{/if}
						</form>
					</div>
					{#if formError && formError.teamId === selected.id}<div class="alert error" role="alert" style="margin-top: 12px">{formError.error}</div>{/if}

					<h3 style="margin-top: 18px">Players <span class="muted small">{selected.roster.length} of {data.maxPlayers} · 4 play at a time</span></h3>
					{#if selected.roster.length}
						<table class="data">
							<thead><tr><th>#</th><th>Name</th><th>Goes by</th><th>Grade</th><th></th></tr></thead>
							<tbody>
								{#each selected.roster as p, i (p.id)}
									{#if editing === p.id}
										<tr>
											<td colspan="5">
												<form method="POST" action="?/updatePlayer" class="prow" use:enhance={() => async ({ update, result }) => { await update({ reset: false }); if (result.type === 'success') editing = null; }}>
													<input type="hidden" name="teamId" value={selected.id} />
													<input type="hidden" name="playerId" value={p.id} />
													<input name="firstName" type="text" value={p.firstName} required aria-label="First name" />
													<input name="lastName" type="text" value={p.lastName} required aria-label="Last name" />
													<input name="preferredName" type="text" value={p.preferredName ?? ''} placeholder="Goes by" aria-label="Preferred name" />
													<select name="grade" value={p.grade ?? ''} aria-label="Grade">{#each grades as g (g)}<option value={g}>{g || '—'}</option>{/each}</select>
													<button class="btn small" type="submit">Save</button>
													<button class="btn small ghost" type="button" onclick={() => (editing = null)}>Cancel</button>
												</form>
											</td>
										</tr>
									{:else}
										<tr>
											<td class="muted">{i + 1}</td>
											<td><strong>{p.firstName} {p.lastName}</strong></td>
											<td>{p.preferredName ?? ''}</td>
											<td>{p.grade ?? ''}</td>
											<td class="nowrap">
												<button class="btn small secondary" type="button" onclick={() => (editing = p.id)}>Fix spelling</button>
												<form method="POST" action="?/removePlayer" style="display: inline" use:enhance={keep} onsubmit={(e) => { if (!confirm(`Remove ${p.firstName} ${p.lastName} from the roster? Scores already recorded are kept.`)) e.preventDefault(); }}>
													<input type="hidden" name="teamId" value={selected.id} />
													<input type="hidden" name="playerId" value={p.id} />
													<button class="btn small ghost" type="submit">Remove</button>
												</form>
											</td>
										</tr>
									{/if}
								{/each}
							</tbody>
						</table>
					{:else}
						<p class="muted">No players entered yet.</p>
					{/if}

					{#if selected.roster.length < data.maxPlayers}
						<form method="POST" action="?/addPlayer" class="prow add" use:enhance={resetOnSuccess}>
							<input type="hidden" name="teamId" value={selected.id} />
							<input id="first-name" name="firstName" type="text" placeholder="First name" required aria-label="First name" autocomplete="off" />
							<input name="lastName" type="text" placeholder="Last name" required aria-label="Last name" autocomplete="off" />
							<input name="preferredName" type="text" placeholder="Goes by (optional)" aria-label="Preferred name" autocomplete="off" />
							<select name="grade" aria-label="Grade (optional)">{#each grades as g (g)}<option value={g}>{g ? `Grade ${g}` : 'Grade —'}</option>{/each}</select>
							<button class="btn" type="submit">Add player</button>
						</form>
					{:else}
						<p class="muted small" style="margin-top: 10px">This team has the maximum of {data.maxPlayers} players. Remove one to add another.</p>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.summary {
		font-size: 1.05rem;
	}
	.desk {
		display: grid;
		grid-template-columns: 340px 1fr;
		gap: 16px;
		margin-top: 16px;
		align-items: start;
	}
	@media (max-width: 860px) {
		.desk {
			grid-template-columns: 1fr;
		}
	}
	.list {
		padding: 12px;
	}
	.list ul {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
		max-height: 70vh;
		overflow: auto;
	}
	.team {
		width: 100%;
		display: grid;
		grid-template-columns: 14px 1fr auto;
		gap: 10px;
		align-items: center;
		text-align: left;
		padding: 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		font: inherit;
		cursor: pointer;
		min-height: 44px;
	}
	.team:hover {
		background: var(--surface-2);
	}
	.team.sel {
		background: var(--info-bg);
		box-shadow: inset 3px 0 0 var(--suscc-blue);
	}
	.dot {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid var(--border-strong);
	}
	.dot.in {
		background: var(--success);
		border-color: var(--success);
	}
	.warnc {
		color: var(--warning);
		font-weight: 700;
	}
	.prow {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr 120px auto auto;
		gap: 8px;
		align-items: center;
	}
	.prow.add {
		margin-top: 12px;
		grid-template-columns: 1fr 1fr 1fr 130px auto;
		padding-top: 12px;
		border-top: 1px dashed var(--border);
	}
	@media (max-width: 860px) {
		.prow,
		.prow.add {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
