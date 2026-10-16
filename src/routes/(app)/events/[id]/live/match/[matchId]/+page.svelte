<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import RoundSummary from '$lib/components/RoundSummary.svelte';
	import Scoreboard from '$lib/components/Scoreboard.svelte';
	import { describeEvent } from '$lib/describe';
	import { computeRound, isScoringBody, type BonusPart, type ScoringBody } from '$lib/engine';
	import { formatPoints } from '$lib/engine/points';
	import { onDestroy, onMount } from 'svelte';

	let { data, form } = $props();
	const m = $derived(data.match);
	const result = $derived(computeRound(m.events, m.rules));
	const base = $derived(`/events/${data.event.id}`);
	const nameOf = (id: string | null) => (id ? (m.teams.A.roster.find((p) => p.id === id)?.name ?? m.teams.B.roster.find((p) => p.id === id)?.name ?? 'Unknown player') : 'Team');
	const teamNames = $derived({ A: m.teams.A.name, B: m.teams.B.name });
	const when = (iso?: string) => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
	const trail = $derived(result.audit.filter((a) => ['submitted', 'approved', 'unapproved', 'round_ended'].includes(a.event.body.type) || (a.event.body.type === 'correction' && a.event.body.action === 'void' && a.event.body.reason.startsWith('Returned'))));
	const finalized = $derived(!!data.session.finalizedAt);

	// ---- Correction dialog ----
	let dlg: HTMLDialogElement | undefined = $state();
	let c = $state({
		target: '',
		rtype: 'tossup_answer' as ScoringBody['type'],
		tossup: 1,
		tiebreaker: false,
		side: 'A' as 'A' | 'B',
		playerId: '',
		correct: 'yes',
		interrupt: false,
		power: false,
		value: '20',
		parts: ['incorrect'] as BonusPart[]
	});
	function openCorrection(target: string | null, body?: ScoringBody) {
		c = {
			target: target ?? '',
			rtype: body?.type ?? 'tossup_answer',
			tossup: body?.tossup ?? result.lastRegularTossup + 1,
			tiebreaker: body && body.type !== 'bonus' ? !!body.tiebreaker : false,
			side: body && body.type !== 'tossup_dead' ? body.side : 'A',
			playerId: body?.type === 'tossup_answer' ? (body.playerId ?? '') : '',
			correct: body?.type === 'tossup_answer' && !body.correct ? 'no' : 'yes',
			interrupt: body?.type === 'tossup_answer' ? !!body.interrupt : false,
			power: body?.type === 'tossup_answer' ? !!body.power : false,
			value: body?.type === 'bonus' ? formatPoints(body.value) : '20',
			parts: body?.type === 'bonus' ? [...body.parts] : ['incorrect']
		};
		dlg?.showModal();
	}
	const setParts = (n: number) => (c.parts = Array.from({ length: Math.max(1, Math.min(10, n)) }, (_, i) => c.parts[i] ?? 'incorrect'));

	let es: EventSource | null = null;
	onMount(() => {
		es = new EventSource(`/api/stream/event/${data.event.id}`);
		es.addEventListener('round', (e) => {
			const msg = JSON.parse((e as MessageEvent).data);
			if (msg.matchId === m.id) invalidate('app:live');
		});
	});
	onDestroy(() => es?.close());
</script>

<svelte:head><title>{m.sessionName} R{m.roundNo} {m.roomName} · Audit</title></svelte:head>

<div class="container wide">
	<a class="small no-print" href="{base}/live?session={m.sessionId}">← Live dashboard</a>
	<div class="row between">
		<h2>{m.sessionName} · Round {m.roundNo} · {m.roomName}</h2>
		<div class="row no-print">
			<a class="btn secondary" href="{base}/reports/round/{m.id}" target="_blank" rel="noopener">Print audit sheet</a>
			{#if result.status === 'submitted'}
				<form method="POST" action="?/approve" use:enhance><button class="btn" type="submit" disabled={finalized}>Approve</button></form>
			{/if}
		</div>
	</div>
	<p class="muted">
		{m.counts ? 'Counting game' : 'Non-counter (never counts)'} · Scored under settings version {data.ruleVersion ?? '— (not started)'}
		{#if finalized}· <span class="badge ok">Session finalized</span>{/if}
	</p>
	{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}
	{#if form && 'message' in form}<div class="alert success" role="status">{form.message}</div>{/if}

	<Scoreboard nameA={m.teams.A.name} nameB={m.teams.B.name} scoreA={result.teams.A.roundScore} scoreB={result.teams.B.roundScore} label={{ not_started: 'Not started', in_progress: 'In progress', ended: 'Reviewing', submitted: 'Submitted', approved: 'Approved' }[result.status]} counts={m.counts} winner={result.status === 'submitted' || result.status === 'approved' ? result.winner : null} compact />

	{#if data.gaps.length}
		<div class="alert error" style="margin-top: 12px">
			<strong>Missing actions:</strong> a scoring computer's numbering skips {data.gaps.map((g) => g.missing.join(', ')).join('; ')}. Some of its actions never arrived. Ask for that computer's results file and import it.
		</div>
	{/if}

	<div style="margin-top: 14px">
		<RoundSummary {result} teams={m.teams} playerName={nameOf} includeBonusInIndividual={m.rules.individual.includeBonus} />
	</div>

	<div class="card no-print" style="margin-top: 14px">
		<h3>Head scorekeeper actions</h3>
		<p class="muted small">Every change is added to the log with your name, the time, and the reason. Nothing is deleted.</p>
		<div class="row">
			<button class="btn secondary" type="button" disabled={finalized} onclick={() => openCorrection(null)}>Add a missing entry</button>
			{#if result.status === 'submitted' || result.status === 'approved'}
				<form method="POST" action="?/returnToRoom" use:enhance class="row" onsubmit={(e) => { const r = prompt('Why return this round to the room scorer?'); if (!r) { e.preventDefault(); return; } (e.currentTarget.querySelector('[name=reason]') as HTMLInputElement).value = r; }}>
					<input type="hidden" name="reason" /><button class="btn secondary" type="submit" disabled={finalized}>Return to room for editing</button>
				</form>
			{/if}
			{#if result.status === 'approved'}
				<form method="POST" action="?/unapprove" use:enhance onsubmit={(e) => { const r = prompt('Why withdraw approval?'); if (!r) { e.preventDefault(); return; } (e.currentTarget.querySelector('[name=reason]') as HTMLInputElement).value = r; }}>
					<input type="hidden" name="reason" /><button class="btn ghost" type="submit" disabled={finalized}>Withdraw approval</button>
				</form>
			{/if}
			<form method="POST" action="?/note" use:enhance class="row" style="flex: 1">
				<input name="text" type="text" placeholder="Add a note to this round's record" aria-label="Note" style="flex: 1; min-width: 200px" />
				<button class="btn secondary" type="submit">Add note</button>
			</form>
		</div>
	</div>

	{#if trail.length}
		<div class="card" style="margin-top: 14px">
			<h3>Approval trail</h3>
			<ul class="trail">
				{#each trail as a (a.event.id)}
					<li class:voided={!a.active}>{when(a.event.serverTs)} · {a.event.actorName ?? a.event.actor}: {describeEvent(a.event.body, nameOf, teamNames)}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="card" style="margin-top: 14px; padding: 0">
		<h3 style="padding: 14px 14px 0">Full action history</h3>
		<div class="table-wrap" style="border: 0">
			<table class="data">
				<thead><tr><th class="num">#</th><th>Time</th><th>By</th><th>Action</th><th>Status</th><th class="no-print"></th></tr></thead>
				<tbody>
					{#each result.audit as a (a.event.id)}
						{@const b = a.event.body}
						<tr class:voided={!a.active}>
							<td class="num">{a.event.seq}</td>
							<td class="nowrap small">{when(a.event.serverTs)}</td>
							<td class="small">{a.event.actorName ?? a.event.actor}{#if a.event.deviceId}<div class="muted">device …{a.event.deviceId.slice(-6)} #{a.event.deviceSeq}</div>{/if}</td>
							<td>{describeEvent(b, nameOf, teamNames)}{#if b.type === 'undo'}<span class="muted small"> (of #{result.audit.find((x) => x.event.id === b.target)?.event.seq})</span>{/if}{#if b.type === 'correction' && b.action !== 'add'}<span class="muted small"> (#{result.audit.find((x) => x.event.id === b.target)?.event.seq})</span>{/if}</td>
							<td class="small">
								{#if a.active}<span class="badge ok">active</span>{:else}
									<span class="badge">voided</span>
									<div class="muted">by {a.voidedBy?.actorName ?? a.voidedBy?.actor} at {when(a.voidedBy?.serverTs)}{#if a.voidedBy?.body.type === 'correction'}: {a.voidedBy.body.reason}{:else if a.voidedBy?.body.type === 'undo'} (undo){/if}</div>
								{/if}
							</td>
							<td class="no-print nowrap">
								{#if a.active && isScoringBody(b) && !finalized}
									<button class="btn small secondary" type="button" onclick={() => openCorrection(a.event.id, b)}>Correct…</button>
									{@const earned = b.type === 'tossup_answer' && b.correct && !b.tiebreaker ? result.tossups.find((t) => !t.tiebreaker && t.number === b.tossup)?.bonuses.find((x) => x.side === b.side) : undefined}
									<form method="POST" action="?/void" use:enhance style="display: inline" onsubmit={(e) => {
										const r = prompt('Reason for voiding this entry?');
										if (!r) { e.preventDefault(); return; }
										const f = e.currentTarget;
										(f.querySelector('[name=reason]') as HTMLInputElement).value = r;
										(f.querySelector('[name=alsoTarget]') as HTMLInputElement).value = earned && confirm(`Also void the bonus for tossup ${b.tossup}? It was earned by this answer.`) ? earned.eventId : '';
									}}>
										<input type="hidden" name="target" value={a.event.id} /><input type="hidden" name="reason" /><input type="hidden" name="alsoTarget" />
										<button class="btn small ghost" type="submit">Void…</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	{#if data.rejected.length}
		<div class="card" style="margin-top: 14px">
			<h3>Actions the server did not accept ({data.rejected.length})</h3>
			<p class="muted small">Kept for the record. If one should count, add it with "Add a missing entry".</p>
			<table class="data">
				<thead><tr><th>Received</th><th>Reason</th><th>Action</th></tr></thead>
				<tbody>
					{#each data.rejected as r (r.id)}
						{@const raw = r.raw as { body?: Parameters<typeof describeEvent>[0] } | null}
						<tr><td class="small">{when(r.receivedAt)}</td><td>{r.reason}</td><td class="small">{raw?.body ? describeEvent(raw.body, nameOf, teamNames) : 'Unreadable'}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<dialog bind:this={dlg} class="modal" aria-labelledby="corr-title">
	<form method="POST" action="?/amend" use:enhance={() => async ({ update, result }) => { await update({ reset: false }); if (result.type === 'success') dlg?.close(); }}>
		<h2 id="corr-title">{c.target ? 'Correct an entry' : 'Add a missing entry'}</h2>
		<input type="hidden" name="target" value={c.target} />
		<div class="grid cols-2">
			<div class="field">
				<label for="c-type">Entry</label>
				<select id="c-type" name="rtype" bind:value={c.rtype}>
					<option value="tossup_answer">Tossup answer</option>
					<option value="tossup_dead">Dead tossup</option>
					<option value="bonus">Bonus</option>
				</select>
			</div>
			<div class="field">
				<label for="c-tu">Tossup number</label>
				<input id="c-tu" name="tossup" type="number" min="1" max="99" bind:value={c.tossup} />
				{#if c.rtype !== 'bonus'}<label class="check small"><input type="checkbox" name="tiebreaker" bind:checked={c.tiebreaker} /> Tiebreaker tossup</label>{/if}
			</div>
			{#if c.rtype !== 'tossup_dead'}
				<div class="field">
					<label for="c-side">Team</label>
					<select id="c-side" name="side" bind:value={c.side}>
						<option value="A">A · {m.teams.A.name}</option>
						<option value="B">B · {m.teams.B.name}</option>
					</select>
				</div>
			{/if}
			{#if c.rtype === 'tossup_answer'}
				<div class="field">
					<label for="c-player">Player</label>
					<select id="c-player" name="playerId" bind:value={c.playerId}>
						<option value="">Not recorded</option>
						{#each m.teams[c.side].roster as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="c-correct">Result</label>
					<select id="c-correct" name="correct" bind:value={c.correct}><option value="yes">Correct</option><option value="no">Wrong</option></select>
				</div>
				<div class="field">
					<label class="check"><input type="checkbox" name="interrupt" bind:checked={c.interrupt} /> Interrupt</label>
					<label class="check"><input type="checkbox" name="power" bind:checked={c.power} /> Power</label>
				</div>
			{/if}
			{#if c.rtype === 'bonus'}
				<div class="field"><label for="c-val">Bonus value</label><input id="c-val" name="value" type="text" bind:value={c.value} /></div>
				<div class="field"><label for="c-parts">Parts</label><input id="c-parts" name="parts" type="number" min="1" max="10" value={c.parts.length} onchange={(e) => setParts(Number((e.currentTarget as HTMLInputElement).value))} /></div>
				<div class="field" style="grid-column: 1 / -1">
					{#each c.parts as p, i (i)}
						<label class="check" style="display: inline-flex; margin-right: 12px">
							Part {i + 1}
							<select name="part{i}" bind:value={c.parts[i]} aria-label="Part {i + 1}">
								<option value="correct">Right</option><option value="incorrect">Wrong</option>{#if m.rules.bonus.bounceback}<option value="bounceback">Other team</option>{/if}
							</select>
						</label>
					{/each}
				</div>
			{/if}
		</div>
		<div class="field">
			<label for="c-reason">Reason (required)</label>
			<input id="c-reason" name="reason" type="text" required placeholder="e.g. Coach's sheet shows tossup 14 was answered by player 3" />
		</div>
		<div class="row" style="justify-content: flex-end">
			<button class="btn secondary" type="button" onclick={() => dlg?.close()}>Cancel</button>
			<button class="btn" type="submit">{c.target ? 'Save correction' : 'Add entry'}</button>
		</div>
	</form>
</dialog>

<style>
	tr.voided td,
	li.voided {
		text-decoration: line-through;
		color: var(--muted);
	}
	tr.voided td:nth-child(5) {
		text-decoration: none;
	}
	.trail {
		margin: 0;
		padding-left: 18px;
	}
	.modal {
		border: 0;
		border-radius: var(--radius);
		padding: 24px;
		width: min(720px, 94vw);
	}
	.modal::backdrop {
		background: rgb(18 32 71 / 45%);
	}
</style>
