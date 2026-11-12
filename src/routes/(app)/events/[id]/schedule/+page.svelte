<script lang="ts">
	import { applyAction, deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { tick } from 'svelte';

	let { data, form } = $props();

	const base = $derived(`/events/${data.event.id}/schedule`);
	const canEdit = $derived(data.can.editSchedule && data.sessionId !== null);
	const published = $derived(data.session?.scheduleStatus === 'published');
	const editable = $derived(canEdit && !published);
	const teamName = (id: number) => data.teams?.find((t) => t.id === id)?.name ?? '?';
	const teamOf = (id: number) => data.teams?.find((t) => t.id === id);
	const rounds = $derived(data.session ? Array.from({ length: data.session.roundCount }, (_, i) => i + 1) : []);
	const errors = $derived(data.issues?.filter((i) => i.level === 'error') ?? []);
	const warnings = $derived(data.issues?.filter((i) => i.level === 'warning') ?? []);
	const notices = $derived(data.issues?.filter((i) => i.level === 'notice') ?? []);
	const badMatch = $derived(new Set(errors.flatMap((i) => i.matchIds ?? [])));
	const sameSchool = $derived(new Set(notices.flatMap((i) => i.matchIds ?? [])));
	const cell = (r: number, roomId: number) => data.matches?.find((m) => m.roundNo === r && m.roomId === roomId);
	/** A planned bracket game whose teams aren't known yet. */
	const slotCell = (r: number, roomId: number) => data.slots?.find((x) => !x.matchId && x.roundNo === r && x.roomId === roomId);
	const slotOfMatch = (id: number | undefined) => data.slots?.find((x) => x.matchId === id);
	const src = (v: string) => {
		const [k, ref] = v.split(':');
		if (k === 'seed') return `Seed ${ref}`;
		const l = data.slots?.find((x) => x.slot === ref)?.label ?? ref;
		return `${k === 'winner' ? 'W' : 'L'} ${l.replace('Semifinal', 'SF').replace('Quarterfinal', 'QF')}`;
	};
	const unplacedSlots = $derived(data.slots?.filter((x) => !x.matchId && !x.roomId) ?? []);
	const fmtTime = (t?: string) => {
		if (!t) return '';
		const [h, m] = t.split(':').map(Number);
		return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	};

	// Pools grouped by name for the pools panel.
	const poolAssign = $derived(
		Object.fromEntries((data.classifications ?? []).map((c) => [c, data.pools?.find((p) => p.classifications.includes(c))?.name ?? c]))
	);
	const teamsByClass = (c: string) => data.teams?.filter((t) => t.classification === c && !t.withdrawn).length ?? 0;

	// ---- Edit dialog ----
	let dialog: HTMLDialogElement | undefined = $state();
	let edit = $state<{ matchId: number | null; roundNo: number; roomId: number; teamA: number; teamB: number; counts: boolean; locked: boolean }>({
		matchId: null,
		roundNo: 1,
		roomId: 0,
		teamA: 0,
		teamB: 0,
		counts: true,
		locked: false
	});
	function openEdit(roundNo: number, roomId: number) {
		const m = cell(roundNo, roomId);
		edit = m
			? { matchId: m.id!, roundNo, roomId, teamA: m.teamA, teamB: m.teamB, counts: m.counts, locked: !!m.locked }
			: { matchId: null, roundNo, roomId, teamA: 0, teamB: 0, counts: true, locked: false };
		dialog?.showModal();
	}

	// ---- Same-school pop-up ----
	let notice: HTMLDialogElement | undefined = $state();
	let noticeLines = $state<string[]>([]);
	let noticeConfirm: (() => void) | null = $state(null);
	function showNotice(lines: string[], onConfirm: (() => void) | null = null) {
		noticeLines = lines;
		noticeConfirm = onConfirm;
		notice?.showModal();
	}

	function submitEdit(e: SubmitEvent) {
		const a = teamOf(edit.teamA);
		const b = teamOf(edit.teamB);
		if (a && b && a.schoolId === b.schoolId && !(e.submitter as HTMLButtonElement | null)?.dataset.confirmed) {
			e.preventDefault();
			const formEl = e.currentTarget as HTMLFormElement;
			showNotice([`${a.name} and ${b.name} are from the same school.`], () => {
				const btn = formEl.querySelector<HTMLButtonElement>('button[data-save]')!;
				btn.dataset.confirmed = '1';
				btn.click();
			});
		}
	}

	// After generating, announce same-school games.
	$effect(() => {
		if (form && 'generated' in form && form.generated) {
			tick().then(() => {
				const lines = (data.issues ?? []).filter((i) => i.level === 'notice').map((i) => i.message);
				if (lines.length) showNotice(lines);
			});
		}
	});

	// ---- Drag and drop ----
	let dragging = $state<number | null>(null);
	let dropTarget = $state<string | null>(null);
	let flash = $state<{ ok: boolean; text: string } | null>(null);
	async function drop(roundNo: number, roomId: number) {
		const matchId = dragging;
		dragging = null;
		dropTarget = null;
		if (!matchId) return;
		const m = data.matches?.find((x) => x.id === matchId);
		if (!m || (m.roundNo === roundNo && m.roomId === roomId)) return;
		const fd = new FormData();
		fd.set('sessionId', String(data.sessionId));
		fd.set('matchId', String(matchId));
		fd.set('roundNo', String(roundNo));
		fd.set('roomId', String(roomId));
		const res = await fetch('?/move', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		const result = deserialize(await res.text());
		if (result.type === 'failure') flash = { ok: false, text: String((result.data as { error?: string })?.error ?? 'Could not move the game.') };
		else flash = { ok: true, text: String((result.type === 'success' && (result.data as { message?: string })?.message) || 'Moved.') };
		await invalidateAll();
		if (result.type === 'redirect' || result.type === 'error') await applyAction(result);
		setTimeout(() => (flash = null), 4000);
	}
</script>

<svelte:head><title>Schedule · {data.event.name}</title></svelte:head>

<div class="container wide">
	<div class="row between">
		<nav class="row" aria-label="Session">
			{#each data.sessions as s (s.id)}
				<a class="btn {s.id === data.sessionId ? '' : 'secondary'}" href="{base}?session={s.id}" aria-current={s.id === data.sessionId ? 'page' : undefined}>{s.name}</a>
			{/each}
		</nav>
		{#if data.session}
			<div class="row">
				{#if published}<span class="badge ok">Published</span>{:else}<span class="badge info">Draft</span>{/if}
				<a class="btn secondary" href="{base}/print?session={data.sessionId}" target="_blank" rel="noopener">Print schedule</a>
				<a class="btn secondary" href="{base}/print?session={data.sessionId}&rooms=1" target="_blank" rel="noopener">Print room sheets</a>
				{#if canEdit}
					<form method="POST" action="?/publish" use:enhance>
						<input type="hidden" name="sessionId" value={data.sessionId} />
						<input type="hidden" name="publish" value={published ? '0' : '1'} />
						{#if published}
							<button class="btn secondary" type="submit">Unlock to edit</button>
						{:else}
							<button class="btn" type="submit" disabled={errors.length > 0 || !data.matches?.length}>Publish and lock</button>
						{/if}
					</form>
				{/if}
			</div>
		{/if}
	</div>

	{#if form?.error}<div class="alert error" role="alert" style="margin-top: 12px">{form.error}</div>{/if}
	{#if form && 'message' in form}<div class="alert success" role="status" style="margin-top: 12px">{form.message}</div>{/if}
	{#if flash}<div class="alert {flash.ok ? 'success' : 'error'}" role="status" style="margin-top: 12px">{flash.text}</div>{/if}
	{#if form && 'warnings' in form && form.warnings?.length}
		<div class="alert warning" style="margin-top: 12px">
			<strong>Draft created with notes:</strong>
			<ul>{#each form.warnings as w (w)}<li>{w}</li>{/each}</ul>
		</div>
	{/if}

	{#if !data.session}
		<div class="card" style="margin-top: 16px">This event has no sessions yet.</div>
	{:else}
		{#if editable}
			<div class="grid cols-2" style="margin-top: 16px">
				<form method="POST" action="?/pools" class="card" use:enhance>
					<input type="hidden" name="sessionId" value={data.sessionId} />
					<h3>Pools</h3>
					<p class="muted small">Teams play counting games within their pool. Give small classifications the same pool name to merge them. Awards follow the award divisions in Scoring settings, not the pools.</p>
					<div class="pools">
						{#each data.classifications as c (c)}
							<label for="pool_{c}">{c} <span class="muted small">({teamsByClass(c)} teams)</span></label>
							<input id="pool_{c}" name="pool_{c}" type="text" value={poolAssign[c]} />
						{/each}
					</div>
					<button class="btn secondary" type="submit">Save pools</button>
				</form>

				<details class="card team-pools">
					<summary><h3 style="display: inline">Split a classification into pools</h3> <span class="muted small">(optional, e.g. Private Pools A, B, C)</span></summary>
					<form method="POST" action="?/teamPools" use:enhance>
						<input type="hidden" name="sessionId" value={data.sessionId} />
						<p class="muted small">Type a pool name for each team to split. Leave blank to use the classification's pool above. Teams with the same pool name play each other.</p>
						<div class="pools">
							{#each data.teams.filter((t) => !t.withdrawn) as t (t.id)}
								<label for="tp_{t.id}">{t.name} <span class="muted small">({t.classification})</span></label>
								<input id="tp_{t.id}" name="teamPool_{t.id}" type="text" maxlength="40" value={data.pools.find((p) => p.id === t.poolId && !p.classifications.length)?.name ?? ''} />
							{/each}
						</div>
						<button class="btn secondary" type="submit">Save team pools</button>
					</form>
				</details>

				<form method="POST" action="?/generate" class="card" use:enhance onsubmit={(e) => { if (data.matches?.length && !confirm('Replace the current draft with a newly generated one?')) e.preventDefault(); }}>
					<input type="hidden" name="sessionId" value={data.sessionId} />
					<h3>Generate a draft</h3>
					<div class="field">
						<label for="rounds">Rounds <span class="hint">(up to {data.maxRounds})</span></label>
						<input id="rounds" name="rounds" type="number" min="1" max={data.maxRounds} value={data.session.roundCount} style="max-width: 120px" />
					</div>
					{#if data.pools.length > 1}
						<div class="field">
							<span class="label">Rounds for each pool <span class="hint">(blank = every round)</span></span>
							{#each data.pools as p (p.id)}
								<label class="check small">
									<input name="poolRounds_{p.id}" type="number" min="1" max={data.maxRounds} value={p.rounds ?? ''} placeholder="all" style="max-width: 80px" aria-label="Rounds for {p.name}" />
									{p.name}
								</label>
							{/each}
						</div>
					{/if}
					<label class="check"><input type="checkbox" name="onlyArrived" checked={data.teams.some((t) => t.arrived)} /> Only teams that have checked in ({data.teams.filter((t) => t.arrived && !t.withdrawn).length} of {data.teams.filter((t) => !t.withdrawn).length})</label>
					<label class="check"><input type="checkbox" name="fillByes" checked /> Fill byes with non-counter games (across classifications)</label>
					<p class="muted small" style="margin-top: 8px">Round-robin within each pool, repeated to fill the pool's rounds. Every team in a pool gets the same number of counting games; a game that would put one team ahead becomes a bye. Rooms: {data.rooms.length}.</p>
					<button class="btn" type="submit">{data.matches.length ? 'Regenerate draft' : 'Generate draft'}</button>
				</form>
			</div>
		{/if}

		{#if errors.length || warnings.length || notices.length}
			<div class="card issues" style="margin-top: 16px">
				{#each errors as i (i.message)}<div class="issue err"><span class="badge bad">Error</span> {i.message}</div>{/each}
				{#each notices as i (i.message)}<div class="issue"><span class="badge warn">Same school</span> {i.message}</div>{/each}
				{#each warnings as i (i.message)}<div class="issue"><span class="badge">Warning</span> {i.message}</div>{/each}
			</div>
		{/if}

		<div class="table-wrap" style="margin-top: 16px">
			<table class="grid-table">
				<thead>
					<tr>
						<th class="rh">Round</th>
						{#each data.rooms as r (r.id)}<th>{r.name}{#if r.moderator}<div class="mod">{r.moderator}</div>{/if}</th>{/each}
						<th>Bye</th>
					</tr>
				</thead>
				<tbody>
					{#each rounds as rn (rn)}
						<tr>
							<th class="rh">{rn}<div class="mod">{fmtTime(data.session.roundTimes[rn - 1])}</div></th>
							{#each data.rooms as room (room.id)}
								{@const m = cell(rn, room.id)}
								{@const key = `${rn}-${room.id}`}
								<td
									class="slot"
									class:target={dropTarget === key}
									ondragover={(e) => { if (editable && dragging) { e.preventDefault(); dropTarget = key; } }}
									ondragleave={() => { if (dropTarget === key) dropTarget = null; }}
									ondrop={(e) => { e.preventDefault(); drop(rn, room.id); }}
								>
									{#if m}
										<button
											type="button"
											class="game"
											class:nc={!m.counts}
											class:bad={badMatch.has(m.id)}
											class:same={sameSchool.has(m.id)}
											class:locked={m.locked}
											draggable={editable && !m.locked}
											ondragstart={() => (dragging = m.id ?? null)}
											ondragend={() => { dragging = null; dropTarget = null; }}
											onclick={() => editable && openEdit(rn, room.id)}
											disabled={!editable}
											aria-label="Round {rn}, {room.name}: {teamName(m.teamA)} versus {teamName(m.teamB)}{m.counts ? '' : ', non-counter'}"
										>
											<span class="t">{teamName(m.teamA)}</span>
											<span class="vs">vs</span>
											<span class="t">{teamName(m.teamB)}</span>
											<span class="tags">
												{#if slotOfMatch(m.id)}<span class="badge info">{slotOfMatch(m.id)?.label}</span>{/if}
												{#if !m.counts}<span class="badge">Non-counter</span>{/if}
												{#if m.locked}<span class="badge info">Scored</span>{/if}
											</span>
										</button>
									{:else if slotCell(rn, room.id)}
										{@const sl = slotCell(rn, room.id)!}
										<div class="game planned" class:nc={!sl.counts} aria-label="Round {rn}, {room.name}: {sl.label}, {src(sl.sourceA)} versus {src(sl.sourceB)}">
											<span class="t">{sl.label}</span>
											<span class="vs">{src(sl.sourceA)} v {src(sl.sourceB)}</span>
											<span class="tags"><span class="badge info">{sl.division}</span></span>
										</div>
									{:else if editable}
										<button type="button" class="empty" onclick={() => openEdit(rn, room.id)} aria-label="Add a game in round {rn}, {room.name}">+</button>
									{/if}
								</td>
							{/each}
							<td class="byes small">{(data.byes[rn] ?? []).map(teamName).join(', ')}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if editable}<p class="muted small">Drag a game onto another cell to move it (or swap with the game there). Click a game to edit it.</p>{/if}

		{#if data.slots?.length}
			<section class="card" style="margin-top: 16px">
				<div class="row between">
					<h3>Bracket games</h3>
					<div class="row">
						{#if canEdit}
							<form method="POST" action="?/planBracket" use:enhance onsubmit={(e) => { if (!confirm('Re-plan the bracket games that have not started (rounds and rooms)?')) e.preventDefault(); }}>
								<input type="hidden" name="sessionId" value={data.sessionId} />
								<button class="btn secondary small" type="submit">Re-plan bracket</button>
							</form>
						{/if}
						<form method="POST" action="?/seedNow" use:enhance onsubmit={(e) => { if (!confirm('Create the bracket games now from the current standings, even if some pool games are not finished?')) e.preventDefault(); }}>
							<input type="hidden" name="sessionId" value={data.sessionId} />
							<button class="btn secondary small" type="submit">Create bracket games now</button>
						</form>
					</div>
				</div>
				<p class="muted small">Bracket games are created automatically once their teams are known: seeds when the division's pool games are in, winners and losers when each bracket game is submitted. You can still edit any game that hasn't started.</p>
				{#if unplacedSlots.length}<div class="alert error" role="alert">{unplacedSlots.length} bracket game(s) have no room. Pick a room below.</div>{/if}
				<table class="data">
					<thead><tr><th>Division</th><th>Game</th><th>Teams</th><th>Round</th><th>Room</th><th>Status</th></tr></thead>
					<tbody>
						{#each data.slots as sl (sl.id)}
							{@const m = data.matches.find((x) => x.id === sl.matchId)}
							<tr>
								<td>{sl.division}</td>
								<td>{sl.label}</td>
								<td>{m ? `${teamName(m.teamA)} v ${teamName(m.teamB)}` : `${src(sl.sourceA)} v ${src(sl.sourceB)}`}</td>
								<td colspan="2">
									{#if canEdit && !m?.locked}
										<form method="POST" action="?/saveSlot" use:enhance class="row slot-form">
											<input type="hidden" name="sessionId" value={data.sessionId} />
											<input type="hidden" name="slotId" value={sl.id} />
											<select name="roundNo" value={sl.roundNo} aria-label="Round for {sl.label}">{#each rounds as r (r)}<option value={r}>{r}</option>{/each}</select>
											<select name="roomId" value={sl.roomId ?? ''} aria-label="Room for {sl.label}"><option value="">—</option>{#each data.rooms as r (r.id)}<option value={r.id}>{r.name}</option>{/each}</select>
											<button class="btn secondary small" type="submit">Save</button>
										</form>
									{:else}
										Round {sl.roundNo} · {data.rooms.find((r) => r.id === sl.roomId)?.name ?? 'no room'}
									{/if}
								</td>
								<td>{m ? (m.locked ? 'Started' : 'Ready') : 'Waiting for results'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}

		{#if data.practiceRooms?.length}
			<section class="card" style="margin-top: 16px">
				<h3>Practice rooms</h3>
				<p class="muted small">
					{data.practiceRooms.map((r) => r.name).join(', ')} {data.practiceRooms.length === 1 ? 'is a practice room' : 'are practice rooms'}: the schedule and brackets leave {data.practiceRooms.length === 1 ? 'it' : 'them'} out, and games scored there never count. The room's scorer can start a practice game on the room computer, or you can add one here.
				</p>
				{#if data.practiceMatches?.length}
					<table class="data">
						<thead><tr><th>Room</th><th>Game</th><th>Teams</th><th>Status</th><th></th></tr></thead>
						<tbody>
							{#each data.practiceMatches as pm (pm.id)}
								<tr>
									<td>{data.practiceRooms.find((r) => r.id === pm.roomId)?.name ?? '—'}</td>
									<td>Practice {pm.roundNo}</td>
									<td>{teamName(pm.teamA)} v {teamName(pm.teamB)}</td>
									<td>{pm.started ? 'Scored (practice)' : 'Not started'}</td>
									<td>
										<form method="POST" action="?/deleteMatch" use:enhance onsubmit={(e) => { if (!confirm('Remove this practice game?')) e.preventDefault(); }}>
											<input type="hidden" name="sessionId" value={data.sessionId} />
											<input type="hidden" name="matchId" value={pm.id} />
											<button class="btn ghost small" type="submit">Remove</button>
										</form>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{:else}<p class="muted small">No practice games in this session yet.</p>{/if}
				<form method="POST" action="?/addPractice" use:enhance class="row" style="margin-top: 8px">
					<input type="hidden" name="sessionId" value={data.sessionId} />
					<select name="roomId" aria-label="Practice room">{#each data.practiceRooms as r (r.id)}<option value={r.id}>{r.name}</option>{/each}</select>
					<select name="teamA" aria-label="Practice team A" required><option value="">Team A…</option>{#each (data.teams ?? []).filter((t) => !t.withdrawn) as t (t.id)}<option value={t.id}>{t.name}</option>{/each}</select>
					<select name="teamB" aria-label="Practice team B" required><option value="">Team B…</option>{#each (data.teams ?? []).filter((t) => !t.withdrawn) as t (t.id)}<option value={t.id}>{t.name}</option>{/each}</select>
					<button class="btn secondary small" type="submit">Add practice game</button>
				</form>
			</section>
		{/if}
	{/if}
</div>

<dialog bind:this={dialog} class="modal" aria-labelledby="edit-title">
	<form method="POST" action="?/saveMatch" use:enhance={() => async ({ update, result }) => { await update(); if (result.type === 'success') dialog?.close(); }} onsubmit={submitEdit}>
		<h2 id="edit-title">{edit.matchId ? 'Edit game' : 'Add a game'}</h2>
		{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}
		<input type="hidden" name="sessionId" value={data.sessionId} />
		<input type="hidden" name="matchId" value={edit.matchId ?? ''} />
		<div class="grid cols-2">
			<div class="field">
				<label for="e-round">Round</label>
				<select id="e-round" name="roundNo" bind:value={edit.roundNo}>{#each rounds as r (r)}<option value={r}>{r}</option>{/each}</select>
			</div>
			<div class="field">
				<label for="e-room">Room</label>
				<select id="e-room" name="roomId" bind:value={edit.roomId}>{#each data.rooms ?? [] as r (r.id)}<option value={r.id}>{r.name}</option>{/each}</select>
			</div>
			<div class="field">
				<label for="e-a">Team A</label>
				<select id="e-a" name="teamA" bind:value={edit.teamA}>
					<option value={0}>Choose…</option>
					{#each data.teams?.filter((t) => !t.withdrawn) ?? [] as t (t.id)}<option value={t.id}>{t.name} ({t.classification})</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="e-b">Team B</label>
				<select id="e-b" name="teamB" bind:value={edit.teamB}>
					<option value={0}>Choose…</option>
					{#each data.teams?.filter((t) => !t.withdrawn) ?? [] as t (t.id)}<option value={t.id}>{t.name} ({t.classification})</option>{/each}
				</select>
			</div>
		</div>
		<label class="check"><input type="checkbox" name="counts" bind:checked={edit.counts} /> Counts toward standings (uncheck for a non-counter)</label>
		{#if edit.teamA && edit.teamB && teamOf(edit.teamA)?.classification !== teamOf(edit.teamB)?.classification && edit.counts}
			<p class="small" style="color: var(--warning)">These teams are in different classifications. Counting games across classifications only make sense in a merged pool.</p>
		{/if}
		<div class="row between" style="margin-top: 16px">
			<div>
				{#if edit.matchId && !edit.locked}
					<button class="btn ghost" type="submit" formaction="?/deleteMatch" formnovalidate onclick={(e) => { if (!confirm('Remove this game?')) e.preventDefault(); else (e.currentTarget as HTMLButtonElement).dataset.confirmed = '1'; }}>Remove game</button>
				{/if}
			</div>
			<div class="row">
				<button class="btn secondary" type="button" onclick={() => dialog?.close()}>Cancel</button>
				<button class="btn" type="submit" data-save>Save</button>
			</div>
		</div>
	</form>
</dialog>

<dialog bind:this={notice} class="modal" aria-labelledby="notice-title">
	<h2 id="notice-title">Teams from the same school</h2>
	<p>{noticeConfirm ? 'You are scheduling two teams from the same school to play each other:' : 'This schedule has teams from the same school playing each other:'}</p>
	<ul>{#each noticeLines as l (l)}<li>{l}</li>{/each}</ul>
	<p class="muted small">This is allowed; both teams can still place. Just make sure it's intended.</p>
	<div class="row" style="justify-content: flex-end">
		{#if noticeConfirm}
			<button class="btn secondary" type="button" onclick={() => notice?.close()}>Go back</button>
			<button class="btn" type="button" onclick={() => { notice?.close(); noticeConfirm?.(); }}>Schedule it anyway</button>
		{:else}
			<button class="btn" type="button" onclick={() => notice?.close()}>OK</button>
		{/if}
	</div>
</dialog>

<style>
	.pools {
		display: grid;
		grid-template-columns: 150px 1fr;
		gap: 6px 12px;
		align-items: center;
		margin-bottom: 12px;
	}
	.pools label {
		margin: 0;
	}
	.issues {
		display: grid;
		gap: 6px;
	}
	.issue.err {
		color: var(--danger);
	}
	.grid-table {
		width: 100%;
		border-collapse: collapse;
		background: var(--surface);
		table-layout: fixed;
		min-width: 900px;
	}
	.grid-table th,
	.grid-table td {
		border: 1px solid var(--border);
		padding: 4px;
		vertical-align: top;
	}
	.grid-table thead th {
		background: var(--surface-2);
		font-family: var(--font-head);
		font-size: 0.85rem;
		padding: 8px 4px;
	}
	.rh {
		width: 70px;
		text-align: center;
		background: var(--surface-2);
		font-family: var(--font-head);
	}
	.mod {
		font-weight: 400;
		font-size: 0.75rem;
		color: var(--muted);
	}
	.slot {
		height: 74px;
	}
	.slot.target {
		background: var(--info-bg);
		outline: 2px dashed var(--suscc-blue);
	}
	.game {
		width: 100%;
		height: 100%;
		min-height: 64px;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		padding: 6px 8px;
		border: 1px solid #c4cde3;
		border-left: 4px solid var(--suscc-blue);
		border-radius: 5px;
		background: #f6f8fd;
		font: 600 0.85rem var(--font-body);
		text-align: left;
		cursor: grab;
		color: var(--text);
	}
	.game:disabled {
		cursor: default;
		opacity: 1;
	}
	.game.nc {
		border-left-color: var(--border-strong);
		background: #fafafa;
		border-style: dashed;
		border-left-style: solid;
	}
	.game.same {
		box-shadow: inset 0 0 0 2px var(--suscc-gold-dark);
	}
	.game.bad {
		border-color: var(--danger);
		background: var(--danger-bg);
	}
	.game.locked {
		cursor: default;
	}
	.game .vs {
		font-size: 0.7rem;
		color: var(--muted);
		font-weight: 400;
	}
	.game .tags {
		display: flex;
		gap: 4px;
		margin-top: 2px;
	}
	.empty {
		width: 100%;
		height: 64px;
		border: 1px dashed var(--border);
		background: none;
		color: var(--muted);
		font-size: 1.4rem;
		cursor: pointer;
		border-radius: 5px;
	}
	.empty:hover {
		background: var(--surface-2);
	}
	.byes {
		width: 160px;
		color: var(--muted);
	}
	.modal {
		border: 0;
		border-radius: var(--radius);
		padding: 24px;
		width: min(640px, 94vw);
		box-shadow: 0 20px 60px rgb(0 0 0 / 30%);
	}
	.modal::backdrop {
		background: rgb(18 32 71 / 45%);
	}
	.game.planned {
		border-style: dashed;
		background: var(--surface-2);
		color: var(--muted);
	}
	.slot-form select {
		max-width: 140px;
	}
	.team-pools summary {
		cursor: pointer;
	}
</style>
