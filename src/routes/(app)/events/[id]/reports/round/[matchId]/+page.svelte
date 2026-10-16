<script lang="ts">
	import Scoresheet from '$lib/components/Scoresheet.svelte';
	import { describeEvent } from '$lib/describe';

	let { data } = $props();
	const s = $derived(data.sheet);
	const m = $derived(s.match);
	const nameOf = (id: string | null) => (id ? (m.teams.A.roster.find((p) => p.id === id)?.name ?? m.teams.B.roster.find((p) => p.id === id)?.name ?? 'Unknown') : 'Team');
	const when = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
</script>

<svelte:head><title>Audit · {m.sessionName} R{m.roundNo} {m.roomName}</title></svelte:head>

<div class="wrap">
	<div class="no-print bar"><button class="btn" type="button" onclick={() => window.print()}>Print</button></div>
	<Scoresheet eventName={data.event.name} isTest={data.event.isTest} match={m} date={s.session.date} moderator={s.moderator} result={s.result} />
	<section class="log">
		<h2>Action history · {m.sessionName} Round {m.roundNo} · {m.roomName}</h2>
		<p class="small">Status: {s.result.status}. Scored under settings version {s.ruleVersion ?? '—'}. Struck-through entries were undone or voided; the reason is shown.</p>
		<table>
			<thead><tr><th>#</th><th>Time</th><th>By</th><th>Action</th><th>Voided</th></tr></thead>
			<tbody>
				{#each s.result.audit as a (a.event.id)}
					<tr class:voided={!a.active}>
						<td>{a.event.seq}</td>
						<td>{when(a.event.serverTs)}</td>
						<td>{a.event.actorName ?? a.event.actor}</td>
						<td class="l">{describeEvent(a.event.body, nameOf, { A: m.teams.A.name, B: m.teams.B.name })}</td>
						<td class="l">{#if a.voidedBy}by {a.voidedBy.actorName ?? a.voidedBy.actor} at {when(a.voidedBy.serverTs)}{a.voidedBy.body.type === 'correction' ? `: ${a.voidedBy.body.reason}` : ' (undo)'}{/if}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if s.result.flags.length}
			<h3>Flags</h3>
			<ul>{#each s.result.flags as f, i (i)}<li>{f.message}</li>{/each}</ul>
		{/if}
	</section>
</div>

<style>
	.wrap {
		padding: 16px;
	}
	.bar {
		max-width: 8.5in;
		margin: 0 auto 12px;
	}
	.log {
		max-width: 8.5in;
		margin: 0 auto;
		background: #fff;
		color: #000;
		padding: 0.25in;
		border: 1px solid var(--border);
	}
	h2 {
		font-size: 13pt;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 8.5pt;
	}
	th,
	td {
		border: 1px solid #999;
		padding: 2px 4px;
		text-align: center;
		vertical-align: top;
	}
	th {
		background: #e8ecf5;
	}
	.l {
		text-align: left;
	}
	tr.voided td:nth-child(4) {
		text-decoration: line-through;
		color: #555;
	}
	@media print {
		.wrap {
			padding: 0;
		}
		.log {
			border: 0;
			padding: 0;
			max-width: none;
		}
	}
</style>
