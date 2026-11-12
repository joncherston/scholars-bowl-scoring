<script lang="ts">
	import Scoreboard from '$lib/components/Scoreboard.svelte';
	import TossupLog from '$lib/components/TossupLog.svelte';
	import { computeRound } from '$lib/engine';
	import type { ScorerMatch } from '$lib/scorer-types';
	import { onDestroy, onMount } from 'svelte';

	let { data } = $props();
	interface State {
		room: { name: string; practice?: boolean };
		event: { name: string; isTest: boolean };
		match: ScorerMatch | null;
		next: { roundNo: number; teams: { A: string; B: string } } | null;
	}
	let st = $state<State | null>(null);
	let err = $state<string | null>(null);
	let live = $state(false);
	const result = $derived(st?.match ? computeRound(st.match.events, st.match.rules) : null);
	const nameOf = (id: string | null) =>
		(id && (st?.match?.teams.A.roster.find((p) => p.id === id)?.name ?? st?.match?.teams.B.roster.find((p) => p.id === id)?.name)) || 'Team';
	const label = $derived.by(() => {
		if (!result) return '';
		if (result.status === 'not_started') return 'Starting soon';
		if (result.status !== 'in_progress') return 'Final';
		const c = result.currentTossup;
		return c.tiebreaker ? `Tiebreaker ${c.number}` : `Tossup ${Math.min(c.number, st!.match!.rules.round.maxTossups)}`;
	});

	async function load() {
		try {
			const res = await fetch(`/api/projector/${data.token}`, { cache: 'no-store' });
			if (res.status === 404) {
				err = 'This projector link is no longer valid.';
				return;
			}
			st = await res.json();
			err = null;
		} catch {
			/* keep showing the last state */
		}
	}
	let es: EventSource | null = null;
	let poll: ReturnType<typeof setInterval>;
	onMount(() => {
		load();
		es = new EventSource(`/api/projector/${data.token}/stream`);
		es.onopen = () => (live = true);
		es.onerror = () => (live = false);
		es.addEventListener('round', () => load());
		poll = setInterval(() => !live && load(), 5000);
	});
	onDestroy(() => {
		es?.close();
		clearInterval(poll);
	});
</script>

<svelte:head><title>{st ? `${st.room.name} · ${st.event.name}` : 'Projector'}</title></svelte:head>

<div class="proj">
	{#if st?.event.isTest}<div class="test-banner">PRACTICE / TEST EVENT</div>{/if}
	{#if st?.room.practice}<div class="test-banner">PRACTICE ROOM · scores here never count</div>{/if}
	{#if err}
		<p class="msg">{err}</p>
	{:else if !st}
		<p class="msg">Loading…</p>
	{:else if !st.match || !result}
		<div class="idle">
			<img src="/suscc-logo-white.svg" alt="Southern Union State Community College" />
			<h1>{st.event.name}</h1>
			<h2>{st.room.name}</h2>
		</div>
	{:else}
		<div class="head">
			<span>{st.room.name} · {st.match.sessionName} · Round {st.match.roundNo}</span>
			<img src="/suscc-logo-white.svg" alt="Southern Union State Community College" />
		</div>
		<Scoreboard
			nameA={st.match.teams.A.name}
			nameB={st.match.teams.B.name}
			scoreA={result.teams.A.roundScore}
			scoreB={result.teams.B.roundScore}
			{label}
			sublabel={result.status === 'in_progress' && !result.currentTossup.tiebreaker ? `of ${st.match.rules.round.maxTossups}` : ''}
			counts={st.match.counts}
			winner={result.status === 'in_progress' && !result.decidedByTiebreaker ? null : result.winner}
		/>
		{#if result.status !== 'not_started'}
			<div class="log">
				<TossupLog {result} playerName={nameOf} teamNames={{ A: st.match.teams.A.name, B: st.match.teams.B.name }} newestFirst limit={6} large />
			</div>
		{/if}
		{#if result.status !== 'in_progress' && st.next}
			<div class="next">Next in this room: Round {st.next.roundNo} — {st.next.teams.A} vs {st.next.teams.B}</div>
		{/if}
	{/if}
</div>

<style>
	:global(body) {
		background: var(--suscc-navy);
	}
	.proj {
		min-height: 100vh;
		padding: 16px 24px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		color: #fff;
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font: 700 1.3rem var(--font-head);
	}
	.head img {
		height: 34px;
	}
	.log {
		border-radius: var(--radius);
		overflow: hidden;
		color: var(--text);
	}
	.next {
		font: 700 1.5rem var(--font-head);
		color: var(--suscc-gold);
		text-align: center;
	}
	.idle {
		margin: auto;
		text-align: center;
	}
	.idle img {
		height: 60px;
	}
	.idle h1 {
		color: #fff;
		font-size: 3rem;
	}
	.idle h2 {
		color: var(--suscc-gold);
		font-size: 2.4rem;
	}
	.msg {
		margin: auto;
		font-size: 1.5rem;
	}
</style>
