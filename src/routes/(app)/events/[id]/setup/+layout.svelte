<script lang="ts">
	import { page } from '$app/state';
	let { data, children } = $props();
	const base = $derived(`/events/${data.event.id}/setup`);
	const links = $derived([
		{ href: base, label: 'Event details', exact: true },
		{ href: `${base}/settings`, label: 'Scoring settings' },
		{ href: `${base}/sessions`, label: 'Sessions' },
		{ href: `${base}/rooms`, label: 'Rooms and PINs' },
		{ href: `${base}/staff`, label: 'Staff' }
	]);
</script>

<div class="container wide setup">
	<nav class="side no-print" aria-label="Setup sections">
		{#each links as l (l.href)}
			<a href={l.href} aria-current={(l.exact ? page.url.pathname === l.href : page.url.pathname.startsWith(l.href)) ? 'page' : undefined}>{l.label}</a>
		{/each}
	</nav>
	<div class="content">{@render children()}</div>
</div>

<style>
	.setup {
		display: grid;
		grid-template-columns: 200px 1fr;
		gap: 24px;
		align-items: start;
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: 2px;
		position: sticky;
		top: 12px;
	}
	.side a {
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		text-decoration: none;
		font-weight: 600;
		color: var(--muted);
	}
	.side a[aria-current='page'] {
		background: var(--surface);
		color: var(--suscc-navy);
		box-shadow: inset 3px 0 0 var(--suscc-blue);
	}
	.content {
		min-width: 0;
	}
	@media (max-width: 800px) {
		.setup {
			grid-template-columns: 1fr;
		}
		.side {
			flex-direction: row;
			flex-wrap: wrap;
			position: static;
		}
	}
</style>
