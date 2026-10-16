<script lang="ts">
	import type { RoundResult, TossupLine } from '$lib/engine';
	import { formatPoints } from '$lib/engine/points';
	import type { ScorerMatch } from '$lib/scorer-types';

	interface Props {
		eventName: string;
		isTest: boolean;
		match: ScorerMatch;
		date: string;
		moderator: string | null;
		result: RoundResult | null;
		/** Print an empty sheet even if the round has been scored. */
		blank?: boolean;
	}
	let { eventName, isTest, match, date, moderator, result, blank = false }: Props = $props();

	const r = $derived(blank ? null : result);
	const maxTossups = $derived(match.rules.round.maxTossups);
	const announceAfter = $derived(match.rules.round.announceAfterTossup);
	const rows = $derived(Array.from({ length: Math.max(maxTossups, r?.lastRegularTossup ?? 0) }, (_, i) => i + 1));
	const tbRows = $derived(r ? Math.max(2, r.tossups.filter((t) => t.tiebreaker).length) : 2);
	const line = (n: number, tb = false): TossupLine | undefined => r?.tossups.find((t) => t.number === n && t.tiebreaker === tb);
	const num = (side: 'A' | 'B', id: string | null) => {
		if (!id) return 'T';
		const i = match.teams[side].roster.findIndex((p) => p.id === id);
		return i >= 0 ? String(i + 1) : '?';
	};
	const ans = (t: TossupLine | undefined, side: 'A' | 'B') => t?.answers.filter((a) => a.side === side) ?? [];
	const bonus = (t: TossupLine | undefined, side: 'A' | 'B') => t?.bonuses.find((b) => b.side === side);
	const runningBefore = (n: number, side: 'A' | 'B') => {
		const prev = r?.tossups.filter((t) => !t.tiebreaker && t.number <= n);
		return prev?.length ? prev[prev.length - 1].running[side] : 0;
	};
	const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
</script>

<article class="sheet">
	<header>
		<div>
			<div class="ev">{eventName}{isTest ? ' — PRACTICE' : ''}</div>
			<h1>{match.sessionName} · Round {match.roundNo} · {match.roomName}</h1>
			<div class="meta">
				{fmtDate(date)} · {match.counts ? 'Counting game' : 'NON-COUNTER (does not count)'} · Moderator: <span class="line">{moderator ?? ''}</span> · Scorekeeper: <span class="line"></span>
			</div>
		</div>
		<img src="/suscc-logo-navy.svg" alt="Southern Union State Community College" />
	</header>

	<div class="teams">
		{#each ['A', 'B'] as const as side (side)}
			<div class="team">
				<div class="tname"><span class="tag">{side}</span> {match.teams[side].name}</div>
				<ol>
					{#each Array.from({ length: Math.max(6, match.teams[side].roster.length) }, (_, i) => i) as i (i)}
						{@const p = match.teams[side].roster[i]}
						<li>
							<span class="pn">{i + 1}</span>
							<span class="pname">{p?.name ?? ''}</span>
							<span class="played">{r && p && r.lineups[side].includes(p.id) ? '● playing' : r ? '' : '☐ playing'}</span>
						</li>
					{/each}
				</ol>
			</div>
		{/each}
	</div>

	<table class="tu-grid">
		<thead>
			<tr>
				<th rowspan="2" class="tu">TU</th>
				<th colspan="4" class="ha">A · {match.teams.A.name}</th>
				<th colspan="4" class="hb">B · {match.teams.B.name}</th>
			</tr>
			<tr>
				<th>Player #<br /><span>✓ / ✗</span></th>
				<th>Bonus<br /><span>parts / value</span></th>
				<th>Pts</th>
				<th>Total</th>
				<th>Player #<br /><span>✓ / ✗</span></th>
				<th>Bonus<br /><span>parts / value</span></th>
				<th>Pts</th>
				<th>Total</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as n (n)}
				{@const t = line(n)}
				<tr class:announce={n === announceAfter} class:dead={!!t && !t.correctSide && (t.dead || t.answers.length >= 2)}>
					<td class="tu">{n}</td>
					{#each ['A', 'B'] as const as side (side)}
						{@const b = bonus(t, side)}
						<td class="pl">
							{#each ans(t, side) as a (a.eventId)}<span class={a.correct ? 'ok' : 'no'}>{num(side, a.playerId)}{a.correct ? '✓' : '✗'}{a.interrupt ? 'ᵢ' : ''}</span>{/each}
						</td>
						<td class="bn">{#if b}{b.partsCorrect}/{b.parts.length} of {formatPoints(b.value)}{/if}</td>
						<td class="pts">{t && t.points[side] ? formatPoints(t.points[side]) : ''}</td>
						<td class="tot">{t ? formatPoints(t.running[side]) : ''}</td>
					{/each}
				</tr>
				{#if n === announceAfter}
					<tr class="announce-row">
						<td colspan="9">↑ Announce the score after tossup {announceAfter}{#if r && line(n)}: {match.teams.A.name} {formatPoints(runningBefore(n, 'A'))}, {match.teams.B.name} {formatPoints(runningBefore(n, 'B'))}{/if}</td>
					</tr>
				{/if}
			{/each}
			{#each Array.from({ length: tbRows }, (_, i) => i + 1) as n (n)}
				{@const t = line(n, true)}
				<tr class="tb">
					<td class="tu">TB{n}</td>
					{#each ['A', 'B'] as const as side (side)}
						<td class="pl">{#each ans(t, side) as a (a.eventId)}<span class={a.correct ? 'ok' : 'no'}>{num(side, a.playerId)}{a.correct ? '✓' : '✗'}</span>{/each}</td>
						<td class="bn muted">—</td>
						<td class="pts">{t && t.points[side] ? formatPoints(t.points[side]) : ''}</td>
						<td class="tot">{t ? formatPoints(t.running[side]) : ''}</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>

	<footer>
		<div>Final score: A <span class="box">{r && (r.status === 'ended' || r.status === 'submitted' || r.status === 'approved') ? formatPoints(r.teams.A.roundScore) : ''}</span> B <span class="box">{r && (r.status === 'ended' || r.status === 'submitted' || r.status === 'approved') ? formatPoints(r.teams.B.roundScore) : ''}</span></div>
		<div>Winner: <span class="line wide">{r?.winner && r.status !== 'in_progress' ? match.teams[r.winner].name : ''}</span></div>
		<div>Round ended because: <span class="line wide">{r?.endReason ?? ''}</span></div>
		<div class="sig">Moderator signature <span class="line wide"></span> Scorekeeper signature <span class="line wide"></span></div>
		<p class="legend">Player # is the player's number above (T = team, player not recorded). ✓ correct, ✗ wrong, ᵢ interrupt. A wrong answer passes the tossup to the other team. Bonus credit is proportional per part. Tiebreaker: first correct answer wins.</p>
	</footer>
</article>

<style>
	.sheet {
		background: #fff;
		color: #000;
		padding: 0.25in;
		font-size: 10.5pt;
		break-after: page;
		max-width: 8.5in;
		margin: 0 auto 24px;
		border: 1px solid var(--border);
	}
	header {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: flex-start;
		border-bottom: 2px solid #122047;
		padding-bottom: 6px;
	}
	header img {
		height: 24px;
	}
	.ev {
		font-size: 9pt;
	}
	h1 {
		font-size: 15pt;
		margin: 2px 0;
		color: #000;
	}
	.meta {
		font-size: 9pt;
	}
	.line {
		display: inline-block;
		min-width: 1.6in;
		border-bottom: 1px solid #000;
	}
	.line.wide {
		min-width: 2.2in;
	}
	.teams {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
		margin: 6px 0;
	}
	.tname {
		font-weight: 800;
		font-size: 11pt;
	}
	.tag {
		display: inline-block;
		border: 1.5px solid #000;
		padding: 0 4px;
		font-size: 9pt;
	}
	.team ol {
		list-style: none;
		margin: 2px 0 0;
		padding: 0;
		columns: 2;
		font-size: 9pt;
	}
	.team li {
		display: flex;
		gap: 4px;
		border-bottom: 1px dotted #999;
		padding: 1px 0;
		break-inside: avoid;
	}
	.pn {
		font-weight: 800;
		width: 1.1em;
	}
	.pname {
		flex: 1;
	}
	.played {
		font-size: 8pt;
		color: #333;
	}
	table.tu-grid {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
	}
	.tu-grid th,
	.tu-grid td {
		border: 1px solid #333;
		padding: 1px 3px;
		height: 0.24in;
		text-align: center;
		font-size: 9.5pt;
	}
	.tu-grid th {
		background: #e8ecf5;
		font-size: 8pt;
		line-height: 1.1;
	}
	.tu-grid th span {
		font-weight: 400;
	}
	.tu-grid .tu {
		width: 0.42in;
		font-weight: 800;
	}
	.tu-grid .ha,
	.tu-grid .hb {
		font-size: 9pt;
		text-align: left;
	}
	.tu-grid td.bn {
		font-size: 8.5pt;
	}
	.tu-grid td.tot {
		font-weight: 800;
	}
	.tu-grid td.pl span {
		margin-right: 4px;
		font-weight: 700;
	}
	.tu-grid td.pl .no {
		color: #8a1c2b;
	}
	tr.announce td {
		border-bottom: 3px solid #000;
	}
	.announce-row td {
		height: auto;
		font-size: 8pt;
		text-align: left;
		background: #fff6d6;
		border-top: 0;
	}
	tr.tb td {
		background: #f7f7f7;
	}
	tr.dead td.pl {
		color: #666;
	}
	.muted {
		color: #777;
	}
	footer {
		margin-top: 8px;
		display: grid;
		gap: 6px;
	}
	.box {
		display: inline-block;
		min-width: 0.8in;
		border: 1px solid #000;
		padding: 0 6px;
		text-align: center;
		font-weight: 800;
		margin-right: 12px;
	}
	.legend {
		font-size: 7.5pt;
		color: #333;
		margin: 0;
	}
	@media print {
		.sheet {
			border: 0;
			margin: 0;
			padding: 0;
			max-width: none;
		}
	}
</style>
