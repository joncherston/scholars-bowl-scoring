<script lang="ts">
	let { data, form } = $props();

	function fillTimes(formEl: HTMLFormElement) {
		const start = (formEl.elements.namedItem('firstRound') as HTMLInputElement).value || (formEl.elements.namedItem('startTime') as HTMLInputElement).value;
		const every = Number((formEl.elements.namedItem('every') as HTMLInputElement).value || 35);
		const n = Number((formEl.elements.namedItem('roundCount') as HTMLInputElement).value || 6);
		const [h, m] = start.split(':').map(Number);
		const out: string[] = [];
		for (let i = 0; i < n; i++) {
			const t = h * 60 + m + i * every;
			out.push(`${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
		}
		(formEl.elements.namedItem('roundTimes') as HTMLInputElement).value = out.join(', ');
	}
</script>

<svelte:head><title>Sessions · {data.event.name}</title></svelte:head>

<div class="row between">
	<h2>Sessions</h2>
	<form method="POST" action="?/add"><button class="btn secondary" type="submit">Add a session</button></form>
</div>
{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}

{#each data.sessions as s (s.id)}
	<form method="POST" action="?/save" class="card" id="session-{s.id}">
		<input type="hidden" name="sessionId" value={s.id} />
		{#if form && 'savedSession' in form && form.savedSession === s.id}<div class="alert success" role="status">Saved.</div>{/if}
		<div class="grid cols-3">
			<div class="field"><label for="name-{s.id}">Name</label><input id="name-{s.id}" name="name" type="text" value={s.name} required /></div>
			<div class="field"><label for="date-{s.id}">Date</label><input id="date-{s.id}" name="date" type="date" value={s.date} required /></div>
			<div class="field"><label for="start-{s.id}">Arrival / start time</label><input id="start-{s.id}" name="startTime" type="time" value={s.startTime} required /></div>
		</div>
		<fieldset class="field">
			<legend><strong>Classifications in this session</strong></legend>
			<div class="row">
				{#each data.event.classifications as c (c)}
					<label class="check"><input type="checkbox" name="classifications" value={c} checked={s.classifications.includes(c)} /> {c}</label>
				{/each}
			</div>
		</fieldset>
		<div class="grid cols-3">
			<div class="field"><label for="rounds-{s.id}">Rounds <span class="hint">(up to {data.maxRounds})</span></label><input id="rounds-{s.id}" name="roundCount" type="number" min="1" max={data.maxRounds} value={s.roundCount} /></div>
			<div class="field" style="grid-column: span 2">
				<label for="times-{s.id}">Round start times <span class="hint">(optional, for printed schedules)</span></label>
				<input id="times-{s.id}" name="roundTimes" type="text" value={s.roundTimes.join(', ')} placeholder="09:00, 09:35, 10:10" />
				<div class="row small" style="margin-top: 6px">
					First round <input name="firstRound" type="time" style="width: auto" aria-label="First round start" />
					every <input name="every" type="number" min="10" max="90" value="35" style="width: 70px" aria-label="Minutes between rounds" /> min
					<button class="btn small secondary" type="button" onclick={(e) => fillTimes((e.currentTarget as HTMLButtonElement).form!)}>Fill times</button>
				</div>
			</div>
		</div>
		<fieldset class="field">
			<legend><strong>Rooms and moderators</strong></legend>
			<div class="rooms">
				{#each data.rooms as r (r.id)}
					{@const sr = s.rooms.find((x) => x.roomId === r.id)}
					<div class="room">
						<label class="check"><input type="checkbox" name="roomIds" value={r.id} checked={!!sr} /> {r.name}</label>
						<input name="moderator_{r.id}" type="text" placeholder="Moderator (optional)" value={sr?.moderator ?? ''} aria-label="Moderator for {r.name}" />
					</div>
				{/each}
			</div>
		</fieldset>
		<div class="row between">
			<span class="muted small">{s.teamCount} teams · {s.matchCount} scheduled games</span>
			<div class="row">
				{#if s.teamCount === 0 && s.matchCount === 0}
					<button class="btn ghost small" type="submit" formaction="?/remove" onclick={(e) => { if (!confirm(`Remove the ${s.name} session?`)) e.preventDefault(); }}>Remove session</button>
				{/if}
				<button class="btn" type="submit">Save {s.name}</button>
			</div>
		</div>
	</form>
{/each}

<style>
	fieldset {
		border: 0;
		padding: 0;
		margin: 0 0 14px;
	}
	.rooms {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 8px 16px;
		margin-top: 6px;
	}
	.room {
		display: grid;
		grid-template-columns: 110px 1fr;
		gap: 8px;
		align-items: center;
	}
</style>
