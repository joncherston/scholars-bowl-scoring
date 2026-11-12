<script lang="ts">
	import { page } from '$app/state';

	let { data, children } = $props();
	const auth = $derived(data.auth);
</script>

<a class="skip" href="#main">Skip to content</a>
<header class="site no-print">
	<div class="bar">
		<a class="brand" href="/" aria-label="Scholars' Bowl Scoring home">
			<img src="/suscc-logo-white.svg" alt="Southern Union State Community College" width="250" height="30" />
			<span class="app">Scholars' Bowl Scoring</span>
		</a>
		<nav aria-label="Main">
			{#if auth.kind === 'user'}
				<a href="/events" aria-current={page.url.pathname.startsWith('/events') ? 'page' : undefined}>Events</a>
				{#if auth.isAdmin}
					<a href="/admin" aria-current={page.url.pathname.startsWith('/admin') ? 'page' : undefined}>Admin</a>
				{/if}
				<a href="/account" aria-current={page.url.pathname.startsWith('/account') ? 'page' : undefined}>{auth.name}</a>
				<form method="POST" action="/logout"><button class="linklike" type="submit">Sign out</button></form>
			{:else if auth.kind === 'room'}
				<a href="/room">{auth.roomName} scorer</a>
				<form method="POST" action="/logout"><button class="linklike" type="submit">Sign out</button></form>
			{:else}
				<a href="/results">Results</a>
				<a href="/login">Staff sign in</a>
				<a href="/room">Room scorer</a>
			{/if}
		</nav>
	</div>
</header>

<main id="main">
	{@render children()}
</main>

<style>
	.skip {
		position: absolute;
		left: -9999px;
	}
	.skip:focus {
		left: 8px;
		top: 8px;
		z-index: 100;
		background: #fff;
		padding: 8px 12px;
	}
	header.site {
		background: var(--suscc-navy);
		border-bottom: 4px solid var(--suscc-gold);
	}
	.bar {
		max-width: 1600px;
		margin: 0 auto;
		padding: 10px 16px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 14px;
		text-decoration: none;
		min-width: 0;
	}
	.brand img {
		height: 30px;
		width: auto;
		max-width: 60vw;
	}
	.app {
		color: var(--suscc-gold);
		font-family: var(--font-head);
		font-weight: 800;
		font-size: 1.05rem;
		padding-left: 14px;
		border-left: 1px solid rgb(255 255 255 / 30%);
		white-space: nowrap;
	}
	nav {
		display: flex;
		gap: 4px;
		align-items: center;
		flex-wrap: wrap;
	}
	nav a,
	.linklike {
		color: #fff;
		text-decoration: none;
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		font-weight: 600;
		background: none;
		border: 0;
		font: 600 0.95rem var(--font-body);
		cursor: pointer;
	}
	nav a:hover,
	.linklike:hover {
		background: rgb(255 255 255 / 12%);
		color: #fff;
	}
	nav a[aria-current='page'] {
		box-shadow: inset 0 -3px 0 var(--suscc-gold);
	}
	nav form {
		margin: 0;
	}
	@media (max-width: 640px) {
		.app {
			display: none;
		}
	}
</style>
