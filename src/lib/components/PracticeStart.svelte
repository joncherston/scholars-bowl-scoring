<script lang="ts">
	import type { PracticeOptions } from '$lib/scorer-types';
	import { untrack } from 'svelte';

	interface Props {
		options: PracticeOptions;
		/** Reload the room's games, then open the new one. */
		onstarted: (matchId: number) => void | Promise<void>;
		oncancel?: () => void;
	}
	let { options, onstarted, oncancel }: Props = $props();

	let sessionId = $state<number>(untrack(() => options.sessions[0]?.id ?? 0));
	let teamA = $state<number | ''>('');
	let teamB = $state<number | ''>('');
	let busy = $state(false);
	let error = $state('');
	const teams = $derived(options.teams.filter((t) => t.sessionId === sessionId));

	async function start(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (!teamA || !teamB || teamA === teamB) {
			error = 'Choose two different teams.';
			return;
		}
		busy = true;
		try {
			const res = await fetch('/api/scorer/practice', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId, teamA, teamB })
			});
			const j = await res.json().catch(() => ({}));
			if (!res.ok || !j.matchId) {
				error = j.error ?? j.message ?? 'The practice game could not be started. Check the connection and try again.';
				return;
			}
			teamA = '';
			teamB = '';
			await onstarted(j.matchId);
		} catch {
			error = 'The server can’t be reached, so a practice game can’t be started right now.';
		} finally {
			busy = false;
		}
	}
</script>

<form class="practice-start" onsubmit={start}>
	<p class="note">Practice room: games here are for practice and training. Nothing scored here counts toward standings, awards or results.</p>
	<div class="fields">
		{#if options.sessions.length > 1}
			<label>
				Session
				<select bind:value={sessionId} onchange={() => { teamA = ''; teamB = ''; }}>
					{#each options.sessions as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
				</select>
			</label>
		{/if}
		<label>
			Team A
			<select bind:value={teamA} required>
				<option value="">Choose…</option>
				{#each teams as t (t.id)}<option value={t.id} disabled={t.id === teamB}>{t.name}</option>{/each}
			</select>
		</label>
		<label>
			Team B
			<select bind:value={teamB} required>
				<option value="">Choose…</option>
				{#each teams as t (t.id)}<option value={t.id} disabled={t.id === teamA}>{t.name}</option>{/each}
			</select>
		</label>
	</div>
	{#if error}<p class="err" role="alert">{error}</p>{/if}
	<div class="actions">
		<button class="btn" type="submit" disabled={busy}>{busy ? 'Starting…' : 'Start practice game'}</button>
		{#if oncancel}<button class="btn secondary" type="button" onclick={oncancel}>Cancel</button>{/if}
	</div>
</form>

<style>
	.practice-start {
		display: grid;
		gap: 0.75rem;
		text-align: left;
	}
	.note {
		margin: 0;
		color: var(--muted, #555);
	}
	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	label {
		display: grid;
		gap: 0.25rem;
		font-weight: 600;
		min-width: 12rem;
	}
	.err {
		margin: 0;
		color: var(--danger, #b42318);
		font-weight: 600;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
</style>
