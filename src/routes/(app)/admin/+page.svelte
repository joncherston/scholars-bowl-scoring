<script lang="ts">
	let { data, form } = $props();
	let resetFor = $state<number | null>(null);
	const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
	const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
</script>

<svelte:head><title>Admin · Scholars' Bowl Scoring</title></svelte:head>

<div class="container">
	<h1>Administration</h1>
	{#if form && 'message' in form}<div class="alert success" role="status">{form.message}</div>{/if}
	{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}

	<div class="card">
		<div class="row between">
			<h2>Backups</h2>
			<div class="row">
				<form method="POST" action="?/backup"><button class="btn secondary" type="submit">Back up now</button></form>
				<a class="btn" href="/admin/backups/latest">Download full backup</a>
			</div>
		</div>
		<p class="muted small">Automatic snapshots every 5 minutes on event days and nightly otherwise. A backup is also taken before every deploy and every import. For a spreadsheet of everything, use an event's Reports → Excel workbook.</p>
		{#if data.events.length}
			<div class="row" style="margin: 8px 0 14px">
				<strong>Export everything to Excel now:</strong>
				{#each data.events as e (e.id)}<a class="btn small secondary" href="/events/{e.id}/reports/export.xlsx">{e.name}{e.isTest ? ' (test)' : ''}</a>{/each}
			</div>
		{/if}
		{#if data.backups.length}
			<table class="data">
				<thead><tr><th>File</th><th>When</th><th class="num">Size</th><th></th></tr></thead>
				<tbody>
					{#each data.backups as b (b.file)}
						<tr><td class="small">{b.file}</td><td>{when(b.mtime)}</td><td class="num">{size(b.size)}</td><td><a href="/admin/backups/{b.file}">Download</a></td></tr>
					{/each}
				</tbody>
			</table>
		{:else}<p class="muted">No backups yet.</p>{/if}
	</div>

	<div class="card">
		<h2>Accounts</h2>
		<p class="muted small">Event staff are usually added from an event's Setup → Staff page. Use this list to reset passwords and manage administrators.</p>
		<table class="data">
			<thead><tr><th>Name</th><th>Email</th><th>Access</th><th></th></tr></thead>
			<tbody>
				{#each data.users as u (u.id)}
					<tr>
						<td>{u.name}</td>
						<td>{u.email}</td>
						<td>
							{#if u.isAdmin}<span class="badge ok">Administrator</span>{/if}
							{#if !u.active}<span class="badge bad">Disabled</span>{/if}
							{#if u.must}<span class="badge warn">Temporary password</span>{/if}
						</td>
						<td class="nowrap">
							{#if resetFor === u.id}
								<form method="POST" action="?/resetPassword" class="row" style="flex-wrap: nowrap">
									<input type="hidden" name="id" value={u.id} />
									<input name="password" type="text" minlength="10" required placeholder="New temporary password" aria-label="New password for {u.name}" />
									<button class="btn small" type="submit">Set</button>
									<button class="btn small ghost" type="button" onclick={() => (resetFor = null)}>Cancel</button>
								</form>
							{:else}
								<button class="btn small secondary" type="button" onclick={() => (resetFor = u.id)}>Reset password</button>
								<form method="POST" action="?/toggle" style="display: inline"><input type="hidden" name="id" value={u.id} /><input type="hidden" name="field" value="active" /><button class="btn small ghost" type="submit">{u.active ? 'Disable' : 'Enable'}</button></form>
								<form method="POST" action="?/toggle" style="display: inline"><input type="hidden" name="id" value={u.id} /><input type="hidden" name="field" value="admin" /><button class="btn small ghost" type="submit">{u.isAdmin ? 'Remove admin' : 'Make admin'}</button></form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<form method="POST" action="?/addUser" style="margin-top: 16px">
			<h3>Add an account</h3>
			<div class="grid cols-3">
				<div class="field"><label for="u-name">Name</label><input id="u-name" name="name" type="text" required /></div>
				<div class="field"><label for="u-email">Email</label><input id="u-email" name="email" type="email" required /></div>
				<div class="field"><label for="u-pw">Temporary password</label><input id="u-pw" name="password" type="text" minlength="10" required autocomplete="off" /></div>
			</div>
			<label class="check"><input type="checkbox" name="isAdmin" /> Administrator</label>
			<div style="margin-top: 10px"><button class="btn" type="submit">Add account</button></div>
		</form>
	</div>
</div>
