<script lang="ts">
	import { page } from '$app/state';

	let { data, children } = $props();
	const base = $derived(`/events/${data.event.id}`);
	const tabs = $derived(
		[
			{ href: base, label: 'Overview', show: true, exact: true },
			{ href: `${base}/teams`, label: 'Teams', show: data.can.teams },
			{ href: `${base}/checkin`, label: 'Check-in', show: data.can.checkin },
			{ href: `${base}/schedule`, label: 'Schedule', show: data.can.schedule },
			{ href: `${base}/live`, label: 'Live', show: data.can.live },
			{ href: `${base}/reports`, label: 'Reports', show: data.can.reports },
			{ href: `${base}/setup`, label: 'Setup', show: data.can.admin }
		].filter((t) => t.show)
	);
	const active = (t: { href: string; exact?: boolean }) =>
		t.exact ? page.url.pathname === t.href : page.url.pathname.startsWith(t.href);
</script>

{#if data.event.isTest}
	<div class="test-banner" role="note">PRACTICE / TEST EVENT — results here never count and are never public</div>
{/if}
<div class="event-head no-print">
	<div class="inner">
		<div>
			<a class="crumb" href="/events">Events</a>
			<h1>{data.event.name}</h1>
		</div>
		<nav class="tabs" aria-label="Event sections">
			{#each tabs as t (t.href)}
				<a href={t.href} aria-current={active(t) ? 'page' : undefined}>{t.label}</a>
			{/each}
		</nav>
	</div>
</div>

{@render children()}

<style>
	.event-head {
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	.inner {
		max-width: 1600px;
		margin: 0 auto;
		padding: 14px 16px 0;
	}
	h1 {
		margin: 0 0 8px;
		font-size: 1.5rem;
	}
	.crumb {
		font-size: 0.85rem;
		text-decoration: none;
	}
	.tabs {
		display: flex;
		gap: 2px;
		overflow-x: auto;
	}
	.tabs a {
		padding: 10px 14px;
		text-decoration: none;
		color: var(--muted);
		font-weight: 700;
		border-bottom: 3px solid transparent;
		white-space: nowrap;
	}
	.tabs a:hover {
		color: var(--suscc-navy);
	}
	.tabs a[aria-current='page'] {
		color: var(--suscc-navy);
		border-bottom-color: var(--suscc-blue);
	}
</style>
