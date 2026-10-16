<script lang="ts">
	import { enhance } from '$app/forms';
	let { form } = $props();
	let busy = $state(false);
</script>

<svelte:head><title>Staff sign in · Scholars' Bowl Scoring</title></svelte:head>

<div class="container narrow">
	<div class="card">
		<h1>Staff sign in</h1>
		{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}
		<form
			method="POST"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update();
					busy = false;
				};
			}}
		>
			<div class="field">
				<label for="email">Email</label>
				<input id="email" name="email" type="email" autocomplete="username" required value={form?.email ?? ''} />
			</div>
			<div class="field">
				<label for="password">Password</label>
				<input id="password" name="password" type="password" autocomplete="current-password" required />
			</div>
			<button class="btn large" type="submit" disabled={busy} style="width: 100%">Sign in</button>
		</form>
		<p class="muted small" style="margin-top: 16px">
			Forgot your password? Ask the administrator to reset it. Room scorers should use <a href="/room">the room PIN sign-in</a>.
		</p>
	</div>
</div>
