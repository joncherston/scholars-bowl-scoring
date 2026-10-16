<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head><title>Your account · Scholars' Bowl Scoring</title></svelte:head>

<div class="container narrow">
	<div class="card">
		<h1>Change your password</h1>
		{#if data.required && !form?.ok}
			<div class="alert warning">Please choose a new password before continuing.</div>
		{/if}
		{#if form?.ok}<div class="alert success" role="status">Password changed. <a href="/events">Continue</a></div>{/if}
		{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}
		<form method="POST" action="?/password">
			<div class="field">
				<label for="current">Current password</label>
				<input id="current" name="current" type="password" autocomplete="current-password" required />
			</div>
			<div class="field">
				<label for="password">New password <span class="hint">(at least 10 characters)</span></label>
				<input id="password" name="password" type="password" autocomplete="new-password" required minlength="10" />
			</div>
			<div class="field">
				<label for="confirm">Confirm new password</label>
				<input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="10" />
			</div>
			<button class="btn" type="submit">Change password</button>
		</form>
	</div>
</div>
