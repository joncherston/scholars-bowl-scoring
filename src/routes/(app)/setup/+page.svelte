<script lang="ts">
	let { data, form } = $props();
</script>

<svelte:head><title>First-time setup · Scholars' Bowl Scoring</title></svelte:head>

<div class="container narrow">
	<div class="card">
		<h1>Create the administrator account</h1>
		<p class="muted">This page only works until the first account exists.</p>
		{#if !data.tokenRequired}
			<div class="alert error">The server has no setup code configured, so setup is disabled.</div>
		{/if}
		{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}
		<form method="POST">
			<div class="field">
				<label for="token">Setup code <span class="hint">(from the server's .env file)</span></label>
				<input id="token" name="token" type="password" autocomplete="off" required />
			</div>
			<div class="field">
				<label for="name">Your name</label>
				<input id="name" name="name" type="text" autocomplete="name" required value={form?.name ?? ''} />
			</div>
			<div class="field">
				<label for="email">Email</label>
				<input id="email" name="email" type="email" autocomplete="username" required value={form?.email ?? ''} />
			</div>
			<div class="field">
				<label for="password">Password <span class="hint">(at least 10 characters)</span></label>
				<input id="password" name="password" type="password" autocomplete="new-password" required minlength="10" />
			</div>
			<div class="field">
				<label for="confirm">Confirm password</label>
				<input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="10" />
			</div>
			<button class="btn large" type="submit" style="width: 100%">Create administrator</button>
		</form>
	</div>
</div>
