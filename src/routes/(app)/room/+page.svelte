<script lang="ts">
	import { onMount } from 'svelte';
	import { getDeviceId } from '$lib/client/device';

	let { data, form } = $props();
	let deviceId = $state('');
	onMount(() => (deviceId = getDeviceId()));
	const ago = (iso: string | null) => {
		if (!iso) return 'a while ago';
		const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
		return s < 90 ? `${s} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : new Date(iso).toLocaleTimeString();
	};
</script>

<svelte:head><title>Room scorer sign in · Scholars' Bowl Scoring</title></svelte:head>

<div class="container narrow">
	<div class="card">
		{#if form && 'needsTakeover' in form && form.needsTakeover}
			<h1>{form.roomName} is open on another computer</h1>
			<p>
				Another computer is signed in as the scorer for <strong>{form.roomName}</strong> (last heard from {ago(form.lastHeardAt)}).
			</p>
			<p>Only continue if that computer is no longer being used, for example if it froze or was restarted. Anything it already saved is kept, and this computer will pick up where it left off.</p>
			<form method="POST">
				<input type="hidden" name="pin" value={form.pin} />
				<input type="hidden" name="deviceId" value={deviceId} />
				<input type="hidden" name="takeover" value="1" />
				<input type="hidden" name="mode" value={form.mode} />
				<div class="row">
					<button class="btn large" type="submit" disabled={!deviceId}>Yes, score {form.roomName} on this computer</button>
					<a class="btn secondary large" href="/room">Cancel</a>
				</div>
			</form>
		{:else}
			<h1>Room scorer sign in</h1>
			<p class="muted">Enter the PIN from your room's card, then choose how you want to score.</p>
			{#if form && 'error' in form}<div class="alert error" role="alert">{form.error}</div>{/if}
			<form method="POST">
				<input type="hidden" name="deviceId" value={deviceId} />
				<div class="field">
					<label for="pin">Room PIN</label>
					<input id="pin" name="pin" type="text" inputmode="numeric" autocomplete="off" maxlength="7" required class="pin" />
				</div>
				<div class="modes">
					<button class="mode" class:last={data.mode === 'screen'} type="submit" name="mode" value="screen" disabled={!deviceId}>
						<strong>Start scoring with the new screen</strong>
						<span>Click the player who buzzed, then Correct or Wrong. The bonus and the score are worked out for you.</span>
					</button>
					<button class="mode" class:last={data.mode === 'sheet'} type="submit" name="mode" value="sheet" disabled={!deviceId}>
						<strong>Start scoring with the spreadsheet</strong>
						<span>The same scoresheet as in past years: a tab for each round, type 10 under the player and the bonus points.</span>
					</button>
				</div>
				<p class="muted small">Teams, players, room and round are filled in for you either way, and you can switch from the menu at any time.</p>
			</form>
		{/if}
	</div>
</div>

<style>
	.modes {
		display: grid;
		gap: 10px;
	}
	.mode {
		display: flex;
		flex-direction: column;
		gap: 4px;
		text-align: left;
		padding: 14px 16px;
		border: 2px solid var(--suscc-navy);
		border-radius: var(--radius);
		background: #fff;
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.mode strong {
		font-size: 1.15rem;
		color: var(--suscc-navy);
	}
	.mode span {
		color: var(--muted);
		font-size: 0.95rem;
	}
	.mode:hover:not(:disabled),
	.mode.last {
		background: var(--surface-2);
		box-shadow: inset 6px 0 0 var(--suscc-gold);
	}
	.mode:disabled {
		opacity: 0.5;
		cursor: wait;
	}
	.pin {
		font-size: 2rem;
		letter-spacing: 0.3em;
		text-align: center;
		font-family: var(--font-num);
	}
</style>
