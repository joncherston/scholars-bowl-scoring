<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { formatPoints } from '$lib/engine/points';
	import { onDestroy, onMount } from 'svelte';

	let { data, form } = $props();
	const base = $derived(`/events/${data.event.id}`);
	let now = $state(Date.now());
	let live = $state(false);
	let showPools = $state(false);

	const ago = (iso: string | null) => {
		if (!iso) return 'never';
		const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
		return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : 'over an hour ago';
	};
	const health = (iso: string | null) => {
		if (!iso) return 'none';
		const s = (now - Date.parse(iso)) / 1000;
		return s < 30 ? 'ok' : s < 120 ? 'warn' : 'bad';
	};
	const rounds = $derived(Array.from({ length: data.roundCount ?? 0 }, (_, i) => i + 1));
	const cell = (r: number, roomId: number) => data.matches?.find((m) => m.roundNo === r && m.roomId === roomId);
	const statusLabel: Record<string, string> = { not_started: 'Not started', in_progress: 'In progress', ended: 'Reviewing', submitted: 'Awaiting approval', approved: 'Approved', forfeit: 'Forfeit' };
	const statusBadge: Record<string, string> = { not_started: '', in_progress: 'info', ended: 'warn', submitted: 'warn', approved: 'ok', forfeit: 'ok' };
	const errorFlags = $derived(data.flags?.filter((f) => f.level === 'error') ?? []);
	const warnFlags = $derived(data.flags?.filter((f) => f.level === 'warning') ?? []);
	const infoFlags = $derived(data.flags?.filter((f) => f.level === 'info') ?? []);

	// Tie resolution dialog
	let tieDialog: HTMLDialogElement | undefined = $state();
	let tie = $state<{ kind: 'team' | 'individual'; groupKey: string; ids: string[] } | null>(null);
	const tieName = (id: string) => (tie?.kind === 'team' ? data.teamNames?.[id] : data.playerNames?.[id]) ?? id;
	function openTie(t: { kind: 'team' | 'individual'; groupKey: string; ids: string[] }) {
		tie = { ...t, ids: [...t.ids] };
		tieDialog?.showModal();
	}
	function move(i: number, d: number) {
		if (!tie) return;
		const j = i + d;
		if (j < 0 || j >= tie.ids.length) return;
		[tie.ids[i], tie.ids[j]] = [tie.ids[j], tie.ids[i]];
	}

	let es: EventSource | null = null;
	let pendingReload: ReturnType<typeof setTimeout> | null = null;
	let clock: ReturnType<typeof setInterval>;
	let poll: ReturnType<typeof setInterval>;
	const reload = () => {
		if (pendingReload) return;
		pendingReload = setTimeout(() => {
			pendingReload = null;
			invalidate('app:live');
		}, 800);
	};
	onMount(() => {
		es = new EventSource(`/api/stream/event/${data.event.id}`);
		es.onopen = () => (live = true);
		es.onerror = () => (live = false);
		for (const t of ['round', 'room', 'session', 'schedule', 'teams']) es.addEventListener(t, reload);
		clock = setInterval(() => (now = Date.now()), 1000);
		poll = setInterval(() => !live && invalidate('app:live'), 10000);
	});
	onDestroy(() => {
		es?.close();
		clearInterval(clock);
		clearInterval(poll);
		if (pendingReload) clearTimeout(pendingReload);
	});
</script>

<svelte:head><title>Live · {data.event.name}</title></svelte:head>

<div class="container wide">
	<div class="row between">
		<nav class="row" aria-label="Session">
			{#each data.sessions as s (s.id)}
				<a class="btn {s.id === data.sessionId ? '' : 'secondary'}" href="{base}/live?session={s.id}" aria-current={s.id === data.sessionId ? 'page' : undefined}>{s.name}</a>
			{/each}
			<span class="badge {live ? 'ok' : 'warn'}" title="Live updates">{live ? '● Live' : 'Reconnecting…'}</span>
		</nav>
		<div class="row">
			<a class="btn secondary" href="{base}/live/import">Import a results file</a>
			{#if data.session}
				{#if data.session.finalizedAt}
					<span class="badge ok">Finalized by {data.session.finalizedBy}</span>
					{#if data.can.admin}
						<form method="POST" action="?/reopen" use:enhance class="row" onsubmit={(e) => { const r = prompt('Why reopen this session?'); if (!r) { e.preventDefault(); return; } (e.currentTarget.querySelector('[name=reason]') as HTMLInputElement).value = r; }}>
							<input type="hidden" name="sessionId" value={data.sessionId} /><input type="hidden" name="reason" />
							<button class="btn secondary small" type="submit">Reopen</button>
						</form>
					{/if}
				{:else}
					<form method="POST" action="?/finalize" use:enhance onsubmit={(e) => { if (!confirm(`Finalize the ${data.session?.name} session? Results will be locked for awards.`)) e.preventDefault(); }}>
						<input type="hidden" name="sessionId" value={data.sessionId} />
						<button class="btn" type="submit" disabled={data.unapprovedCounting > 0}>Finalize session</button>
					</form>
				{/if}
			{/if}
		</div>
	</div>
	{#if form?.error}<div class="alert error" role="alert" style="margin-top: 10px">{form.error}</div>{/if}
	{#if form && 'message' in form}<div class="alert success" role="status" style="margin-top: 10px">{form.message}</div>{/if}

	{#if !data.session}
		<div class="card" style="margin-top: 16px">No sessions yet.</div>
	{:else}
		{#if data.event.isTest && data.can.admin}
			<div class="card sim">
				<div class="row between">
					<div>
						<strong>Simulation</strong> <span class="muted small">(practice events only)</span>
						{#if data.simulation?.running}<span class="badge info">Running · round {data.simulation.round} of {data.simulation.rounds} · {data.simulation.done}/{data.simulation.total} games</span>
						{:else if data.simulation}<span class="badge">{data.simulation.error ? `Stopped: ${data.simulation.error}` : `Finished ${data.simulation.done} games`}</span>{/if}
					</div>
					{#if data.simulation?.running}
						<form method="POST" action="?/stopSimulation" use:enhance><input type="hidden" name="sessionId" value={data.sessionId} /><button class="btn secondary" type="submit">Stop</button></form>
					{:else}
						<form method="POST" action="?/simulate" use:enhance class="row">
							<input type="hidden" name="sessionId" value={data.sessionId} />
							<select name="stepMs" aria-label="Speed">
								<option value="400">Watchable (one action per room every 0.4 s)</option>
								<option value="60">Fast</option>
								<option value="0">Instant</option>
							</select>
							<label class="check small"><input type="checkbox" name="approve" checked /> Approve each round</label>
							<button class="btn" type="submit">Auto-play unscored games</button>
						</form>
					{/if}
				</div>
			</div>
		{/if}
		<h2 class="sec">Rooms</h2>
		<div class="rooms">
			{#each data.rooms as r (r.id)}
				{@const m = r.current ? data.matches.find((x) => x.id === r.current!.id) : null}
				<a class="room card" href={m ? `${base}/live/match/${m.id}` : undefined}>
					<div class="row between">
						<strong>{r.name}</strong>
						<span class="hb {r.hasDevice ? health(r.lastHeardAt) : 'none'}" title="Scoring computer last heard from">
							<span class="dot" aria-hidden="true"></span>{r.hasDevice ? ago(r.lastHeardAt) : 'no computer signed in'}
						</span>
					</div>
					{#if m}
						<div class="small muted">Round {m.roundNo}{m.counts ? '' : ' · non-counter'}</div>
						<div class="teams">{m.teamA} <span class="muted">vs</span> {m.teamB}</div>
						<div class="row between">
							<span class="badge {statusBadge[m.status]}">{statusLabel[m.status]}{m.status === 'in_progress' ? ` · ${m.tossup.tiebreaker ? 'TB' : 'TU'} ${m.tossup.number}` : ''}</span>
							{#if m.status !== 'not_started' && m.status !== 'forfeit'}<span class="score num">{formatPoints(m.scoreA)}–{formatPoints(m.scoreB)}</span>{/if}
						</div>
					{:else}
						<div class="muted small">No games</div>
					{/if}
					{#if r.pending}<div class="badge warn" style="margin-top: 6px">{r.pending} action(s) waiting on that computer</div>{/if}
				</a>
			{/each}
		</div>

		<h2 class="sec">Rounds</h2>
		<div class="table-wrap">
			<table class="rounds">
				<thead><tr><th>Round</th>{#each data.rooms as r (r.id)}<th>{r.name}</th>{/each}</tr></thead>
				<tbody>
					{#each rounds as rn (rn)}
						<tr>
							<th>{rn}</th>
							{#each data.rooms as room (room.id)}
								{@const m = cell(rn, room.id)}
								<td>
									{#if m}
										<a class="rcell {m.status}" href="{base}/live/match/{m.id}">
											<span class="t">{m.teamA} <span class="muted">v</span> {m.teamB}</span>
											<span class="row between">
												<span class="badge {statusBadge[m.status]}">{statusLabel[m.status]}</span>
												{#if m.status !== 'not_started' && m.status !== 'forfeit'}<span class="num">{formatPoints(m.scoreA)}–{formatPoints(m.scoreB)}</span>{/if}
											</span>
											{#if !m.counts}<span class="small muted">non-counter</span>{/if}
											{#if m.flagCount}<span class="small flagc">⚑ {m.flagCount} to check</span>{/if}
										</a>
										{#if m.status === 'submitted'}
											<form method="POST" action="?/approve" use:enhance>
												<input type="hidden" name="matchId" value={m.id} />
												<button class="btn small" type="submit" style="width: 100%; margin-top: 4px">Approve</button>
											</form>
										{/if}
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<div class="cols">
			<div>
				<div class="row between">
					<h2 class="sec">Standings <span class="muted small">(provisional: submitted and approved rounds)</span></h2>
					<label class="check small"><input type="checkbox" bind:checked={showPools} /> Show pools</label>
				</div>
				{#each showPools ? data.poolStandings : data.divisionStandings as g (g.key)}
					<div class="card stand">
						<h3>{g.label}{#if g.soleTeam}&nbsp;<span class="badge">only team in {showPools ? 'pool' : 'division'}</span>{/if}{#if !showPools && g.spansSessions}&nbsp;<span class="badge warn">ranked across sessions</span>{/if}</h3>
						<table class="data">
							<thead><tr><th>Place</th><th>Team</th><th class="num">W–L</th><th class="num">Points</th></tr></thead>
							<tbody>
								{#each g.rows as r (r.teamId)}
									<tr class:award={!showPools && r.place <= data.teamPlaces}>
										<td>{r.place}{#if r.tied}&nbsp;<span class="badge bad">tie</span>{/if}{#if r.resolved}&nbsp;<span class="badge info" title={r.resolved}>tie decided</span>{/if}</td>
										<td>{r.name}{#if r.bracketResult}&nbsp;<span class="badge info">{r.bracketResult}</span>{:else if r.seed}&nbsp;<span class="muted small">seed {r.seed}</span>{/if}</td>
										<td class="num">{r.wins}–{r.losses}{r.ties ? `–${r.ties}` : ''}</td>
										<td class="num">{formatPoints(r.points)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
			</div>
			<div>
				{#if data.bracketWaiting.length}
					<div class="card stand">
						<h3>Bracket games waiting for teams</h3>
						<p class="muted small">Created automatically when their teams are known. To create them early, use Schedule → Create bracket games now.</p>
						<ul class="small">{#each data.bracketWaiting as b (b.id)}<li>{b.label} — round {b.roundNo}, {b.room}</li>{/each}</ul>
					</div>
				{/if}
				<h2 class="sec">Needs attention</h2>
				{#each data.withdrawn as w (w.teamId)}
					<div class="card withdrawn">
						<strong>{w.name} has withdrawn.</strong> Counting games not played yet:
						<ul>{#each w.games as g (g.matchId)}<li><a href="{base}/live/match/{g.matchId}">Round {g.roundNo}, {g.roomName}, vs {g.opponent}</a></li>{/each}</ul>
						<form method="POST" action="?/forfeitAll" use:enhance onsubmit={(e) => { const r = prompt(`Why does ${w.name} forfeit its remaining games?`); if (!r) { e.preventDefault(); return; } (e.currentTarget.querySelector('[name=reason]') as HTMLInputElement).value = r; }}>
							<input type="hidden" name="teamId" value={w.teamId} /><input type="hidden" name="reason" />
							<button class="btn small" type="submit">Record forfeits for all remaining games</button>
						</form>
						<p class="muted small">Each opponent gets a win; neither team scores points.</p>
					</div>
				{/each}
				<div class="card flags">
					{#if !errorFlags.length && !warnFlags.length}<p class="muted">Nothing needs attention right now.</p>{/if}
					{#each errorFlags as f, i (i)}
						<div class="flag err">
							<span class="badge bad">!</span>
							<span>{#if f.matchId}<a href="{base}/live/match/{f.matchId}">{f.message}</a>{:else}{f.message}{/if}</span>
							{#if f.tie}<button class="btn small" type="button" onclick={() => openTie(f.tie!)}>Resolve tie</button>{/if}
						</div>
					{/each}
					{#each warnFlags as f, i (i)}
						<div class="flag"><span class="badge warn">⚑</span><span>{#if f.matchId}<a href="{base}/live/match/{f.matchId}">{f.message}</a>{:else}{f.message}{/if}</span></div>
					{/each}
					{#if infoFlags.length}
						<details>
							<summary class="small">{infoFlags.length} note(s)</summary>
							{#each infoFlags as f, i (i)}
								<div class="flag small"><span class="badge">i</span><span>{#if f.matchId}<a href="{base}/live/match/{f.matchId}">{f.message}</a>{:else}{f.message}{/if}</span></div>
							{/each}
						</details>
					{/if}
				</div>

				<h2 class="sec">Individual leaders <span class="muted small">(staff only)</span></h2>
				{#each data.individuals as g (g.key)}
					<div class="card stand">
						<h3>{g.label}</h3>
						<table class="data">
							<thead><tr><th>Place</th><th>Player</th><th>Team</th><th class="num">Tossups</th><th class="num">Points</th></tr></thead>
							<tbody>
								{#each g.rows as r (r.playerId)}
									<tr class:award={r.place <= data.individualPlaces}>
										<td>{r.place}{#if r.tied}&nbsp;<span class="badge {r.place <= data.individualPlaces ? 'bad' : ''}">tie</span>{/if}{#if r.resolved}&nbsp;<span class="badge info" title={r.resolved}>tie decided</span>{/if}</td>
										<td>{r.name}</td>
										<td class="small">{r.team}</td>
										<td class="num">{r.corrects}</td>
										<td class="num">{formatPoints(r.total)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="muted">No individual scores yet.</p>
				{/each}
			</div>
		</div>
	{/if}
</div>

<dialog bind:this={tieDialog} class="modal" aria-labelledby="tie-title">
	{#if tie}
		<form method="POST" action="?/resolveTie" use:enhance={() => async ({ update, result }) => { await update(); if (result.type === 'success') tieDialog?.close(); }}>
			<h2 id="tie-title">Resolve a tie</h2>
			<p class="muted">Put the tied {tie.kind === 'team' ? 'teams' : 'players'} in the order you decided, best first, and record how it was decided. This is shown on the awards sheet and in the audit log.</p>
			<ol class="order">
				{#each tie.ids as id, i (id)}
					<li>
						<span>{tieName(id)}</span>
						<button class="btn small ghost" type="button" onclick={() => move(i, -1)} disabled={i === 0} aria-label="Move {tieName(id)} up">↑</button>
						<button class="btn small ghost" type="button" onclick={() => move(i, 1)} disabled={i === tie.ids.length - 1} aria-label="Move {tieName(id)} down">↓</button>
					</li>
				{/each}
			</ol>
			<input type="hidden" name="kind" value={tie.kind} />
			<input type="hidden" name="groupKey" value={tie.groupKey} />
			<input type="hidden" name="ordered" value={tie.ids.join(',')} />
			<div class="field">
				<label for="tie-note">How was it decided?</label>
				<input id="tie-note" name="note" type="text" required placeholder="e.g. Sudden-death question read at the awards table" />
			</div>
			<div class="row" style="justify-content: flex-end">
				<button class="btn secondary" type="button" onclick={() => tieDialog?.close()}>Cancel</button>
				<button class="btn" type="submit">Record decision</button>
			</div>
		</form>
	{/if}
</dialog>

<style>
	.sec {
		margin: 22px 0 10px;
	}
	.sim {
		margin-top: 14px;
		border-left: 6px solid var(--suscc-gold);
	}
	.rooms {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
		gap: 10px;
	}
	.room {
		display: block;
		text-decoration: none;
		color: inherit;
		padding: 12px;
	}
	.room + .room {
		margin-top: 0;
	}
	.room .teams {
		font-weight: 700;
		margin: 2px 0 6px;
	}
	.score {
		font-weight: 800;
		font-size: 1.15rem;
	}
	.hb {
		font-size: 0.8rem;
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.hb .dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--border-strong);
	}
	.hb.ok .dot {
		background: var(--success);
	}
	.hb.warn .dot {
		background: #d99a00;
	}
	.hb.bad .dot {
		background: var(--danger);
	}
	.hb.bad {
		color: var(--danger);
		font-weight: 700;
	}
	.rounds {
		width: 100%;
		border-collapse: collapse;
		background: var(--surface);
		table-layout: fixed;
		min-width: 800px;
	}
	.rounds th,
	.rounds td {
		border: 1px solid var(--border);
		padding: 4px;
		vertical-align: top;
		font-size: 0.85rem;
	}
	.rounds thead th,
	.rounds tbody th {
		background: var(--surface-2);
		font-family: var(--font-head);
	}
	.rounds tbody th {
		width: 56px;
		text-align: center;
	}
	.rcell {
		display: flex;
		flex-direction: column;
		gap: 3px;
		text-decoration: none;
		color: inherit;
		padding: 4px;
		border-radius: 4px;
		border-left: 4px solid var(--border);
	}
	.rcell:hover {
		background: var(--surface-2);
	}
	.rcell.in_progress {
		border-left-color: var(--suscc-blue);
	}
	.rcell.ended,
	.rcell.submitted {
		border-left-color: #d99a00;
	}
	.rcell.approved {
		border-left-color: var(--success);
	}
	.rcell .t {
		font-weight: 700;
	}
	.flagc {
		color: var(--warning);
		font-weight: 700;
	}
	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 20px;
	}
	@media (max-width: 1000px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	.stand {
		padding: 12px;
	}
	.stand + .stand {
		margin-top: 10px;
	}
	tr.award td {
		background: #fffbea;
	}
	.flags {
		display: grid;
		gap: 8px;
	}
	.withdrawn {
		margin-bottom: 10px;
		border-left: 4px solid var(--warn, #b54708);
	}
	.withdrawn ul {
		margin: 6px 0 10px;
	}
	.flag {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 8px;
		align-items: start;
	}
	.flag.err a,
	.flag.err span {
		color: var(--danger);
	}
	.modal {
		border: 0;
		border-radius: var(--radius);
		padding: 24px;
		width: min(560px, 94vw);
	}
	.modal::backdrop {
		background: rgb(18 32 71 / 45%);
	}
	.order li {
		display: flex;
		gap: 8px;
		align-items: center;
		padding: 4px 0;
	}
	.order li span {
		flex: 1;
		font-weight: 700;
	}
</style>
