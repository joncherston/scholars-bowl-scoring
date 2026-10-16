<script lang="ts">
	let { data, form } = $props();
	const roleLabel = (r: string) => data.roles.find((x) => x.value === r)?.label ?? r;
	const people = $derived(
		Object.values(
			data.staff.reduce(
				(acc, s) => {
					(acc[s.email] ??= { email: s.email, name: s.name, account: s.account, isAdmin: s.isAdmin, rows: [] as typeof data.staff }).rows.push(s);
					return acc;
				},
				{} as Record<string, { email: string; name: string; account: string; isAdmin: boolean; rows: typeof data.staff }>
			)
		)
	);
	let pwFor = $state<string | null>(null);
</script>

<svelte:head><title>Staff · {data.event.name}</title></svelte:head>

<h2>Staff for this event</h2>
<p class="muted">Staff are listed per event, so they can change from year to year. People sign in with their email; an account is created the first time you give them a temporary password.</p>
{#if form && 'message' in form}<div class="alert success" role="status">{form.message}</div>{/if}
{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}

<form method="POST" action="?/add" class="card">
	<h3>Add a person</h3>
	<div class="grid cols-3">
		<div class="field"><label for="name">Name</label><input id="name" name="name" type="text" required value={form && 'name' in form ? form.name : ''} /></div>
		<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required value={form && 'email' in form ? form.email : ''} /></div>
		<fieldset class="field" style="border: 0; padding: 0; margin: 0">
			<legend><strong>Roles</strong></legend>
			{#each data.roles as r (r.value)}<label class="check"><input type="checkbox" name="role" value={r.value} /> {r.label}</label>{/each}
		</fieldset>
	</div>
	<button class="btn" type="submit">Add</button>
</form>

<div class="card">
	{#if people.length === 0}
		<p class="muted">No staff yet.</p>
	{:else}
		<table class="data">
			<thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Sign-in</th><th></th></tr></thead>
			<tbody>
				{#each people as p (p.email)}
					<tr>
						<td>{p.name}</td>
						<td>{p.email}</td>
						<td>
							{#each p.rows as row (row.id)}
								<form method="POST" action="?/remove" class="role">
									<input type="hidden" name="id" value={row.id} />
									<span class="badge info">{roleLabel(row.role)}</span>
									<button class="x" type="submit" aria-label="Remove {roleLabel(row.role)} role from {p.name}">×</button>
								</form>
							{/each}
						</td>
						<td>
							{#if p.isAdmin}<span class="badge ok">Administrator</span>
							{:else if p.account === 'active'}<span class="badge ok">Has a login</span>
							{:else if p.account === 'temporary'}<span class="badge warn">Temporary password</span>
							{:else if p.account === 'disabled'}<span class="badge bad">Disabled</span>
							{:else}<span class="badge">No login yet</span>{/if}
						</td>
						<td>
							{#if !p.isAdmin}
								{#if pwFor === p.email}
									<form method="POST" action="?/password" class="row" style="flex-wrap: nowrap">
										<input type="hidden" name="email" value={p.email} />
										<input name="password" type="text" autocomplete="off" minlength="10" required placeholder="Temporary password" aria-label="Temporary password for {p.name}" />
										<button class="btn small" type="submit">Set</button>
										<button class="btn small ghost" type="button" onclick={() => (pwFor = null)}>Cancel</button>
									</form>
								{:else}
									<button class="btn small secondary" type="button" onclick={() => (pwFor = p.email)}>{p.account === 'none' ? 'Create login' : 'Reset password'}</button>
								{/if}
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.role {
		display: inline-flex;
		align-items: center;
		margin: 2px 4px 2px 0;
	}
	.x {
		border: 0;
		background: none;
		cursor: pointer;
		color: var(--muted);
		font-size: 1.1rem;
		padding: 0 4px;
	}
	.x:hover {
		color: var(--danger);
	}
</style>
