<script lang="ts">
	let { data, form } = $props();
	const ago = (iso: string | null) => {
		if (!iso) return 'never';
		const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
		return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString();
	};
	let copied = $state<number | null>(null);
	async function copy(text: string, id: number) {
		await navigator.clipboard.writeText(text);
		copied = id;
		setTimeout(() => (copied = null), 1500);
	}
</script>

<svelte:head><title>Rooms and PINs · {data.event.name}</title></svelte:head>

<div class="row between">
	<h2>Rooms and PINs</h2>
	<div class="row">
		<a class="btn secondary" href="/events/{data.event.id}/setup/pins" target="_blank" rel="noopener">Print PIN cards</a>
		<form method="POST" action="?/add"><button class="btn secondary" type="submit">Add a room</button></form>
	</div>
</div>
<p class="muted" id="practice-help">Mark bye rooms as <strong>practice rooms</strong>: the schedule and brackets leave them out, and anything scored there (training scorekeepers, teams practicing during a bye) never reaches standings, awards or results.</p>
<p class="muted">Room scorers sign in at <strong>{data.origin}/room</strong> with the room's PIN. The projector link shows a read-only scoreboard for rooms with a separate display.</p>
{#if form && 'message' in form}<div class="alert success" role="status">{form.message}</div>{/if}
{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}

<div class="table-wrap">
	<table class="data">
		<thead><tr><th>Room</th><th>PIN</th><th>Scoring device</th><th>Projector link</th><th></th></tr></thead>
		<tbody>
			{#each data.rooms as r (r.id)}
				<tr class:inactive={!r.active} class:practice={r.practice} data-room={r.id}>
					<td>
						<form method="POST" action="?/rename" class="row" style="flex-wrap: nowrap">
							<input type="hidden" name="roomId" value={r.id} />
							<input name="name" type="text" value={r.name} aria-label="Room name" style="min-width: 120px" />
							<button class="btn small secondary" type="submit">Rename</button>
						</form>
						<form method="POST" action="?/practice" class="practice-toggle">
							<input type="hidden" name="roomId" value={r.id} />
							<label>
								<input type="checkbox" checked={r.practice} onchange={(e) => e.currentTarget.form?.requestSubmit()} aria-describedby="practice-help" />
								Practice / bye room
							</label>
							{#if r.practice}<span class="badge warn">Scores never count</span>{/if}
							<noscript><button class="btn small ghost" type="submit">Change</button></noscript>
						</form>
					</td>
					<td class="num pin">{r.pin}</td>
					<td class="small">
						{#if r.activeDeviceId}
							In use · last heard {ago(r.lastHeardAt)}
							<form method="POST" action="?/release" style="display: inline"><input type="hidden" name="roomId" value={r.id} /><button class="btn ghost small" type="submit">Release</button></form>
						{:else}<span class="muted">None</span>{/if}
					</td>
					<td>
						<button class="btn small secondary" type="button" onclick={() => copy(`${data.origin}/projector/${r.projectorToken}`, r.id)}>{copied === r.id ? 'Copied' : 'Copy link'}</button>
						<a class="btn small ghost" href="/projector/{r.projectorToken}" target="_blank" rel="noopener">Open</a>
					</td>
					<td class="nowrap">
						<form method="POST" action="?/pin" style="display: inline" onsubmit={(e) => { if (!confirm(`Give ${r.name} a new PIN? Devices signed in with the old PIN will be signed out.`)) e.preventDefault(); }}>
							<input type="hidden" name="roomId" value={r.id} /><button class="btn small secondary" type="submit">New PIN</button>
						</form>
						<form method="POST" action="?/projector" style="display: inline" onsubmit={(e) => { if (!confirm('Replace the projector link? The old link will stop working.')) e.preventDefault(); }}>
							<input type="hidden" name="roomId" value={r.id} /><button class="btn small ghost" type="submit">New projector link</button>
						</form>
						<form method="POST" action="?/toggle" style="display: inline">
							<input type="hidden" name="roomId" value={r.id} /><button class="btn small ghost" type="submit">{r.active ? 'Deactivate' : 'Activate'}</button>
						</form>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.pin {
		font-size: 1.25rem;
		font-weight: 800;
		letter-spacing: 0.08em;
	}
	tr.inactive td {
		opacity: 0.55;
	}
	td form {
		margin: 0;
	}
	.practice-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
		font-size: 0.9rem;
	}
	.practice-toggle label {
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
	}
	tr.practice td:first-child {
		box-shadow: inset 4px 0 0 #e0b100;
	}
</style>
