<script lang="ts">
	import { onMount } from 'svelte';
	import { getDeviceId } from '$lib/client/device';

	let { form } = $props();
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
				<div class="row">
					<button class="btn large" type="submit" disabled={!deviceId}>Yes, score {form.roomName} on this computer</button>
					<a class="btn secondary large" href="/room">Cancel</a>
				</div>
			</form>
		{:else}
			<h1>Room scorer sign in</h1>
			<p class="muted">Enter the PIN from your room's card.</p>
			{#if form && 'error' in form}<div class="alert error" role="alert">{form.error}</div>{/if}
			<form method="POST">
				<input type="hidden" name="deviceId" value={deviceId} />
				<div class="field">
					<label for="pin">Room PIN</label>
					<input id="pin" name="pin" type="text" inputmode="numeric" autocomplete="off" maxlength="7" required class="pin" />
				</div>
				<button class="btn large" type="submit" style="width: 100%" disabled={!deviceId}>Start scoring</button>
			</form>
		{/if}
	</div>
</div>

<style>
	.pin {
		font-size: 2rem;
		letter-spacing: 0.3em;
		text-align: center;
		font-family: var(--font-num);
	}
</style>
