<script lang="ts">
	import { onMount } from 'svelte';

	type Status = 'running' | 'pass' | 'warn' | 'fail';
	interface Check {
		name: string;
		status: Status;
		detail: string;
	}
	let checks = $state<Check[]>([
		{ name: 'Server connection', status: 'running', detail: 'Checking…' },
		{ name: 'Live updates', status: 'running', detail: 'Listening for 6 updates, one per second…' },
		{ name: 'Offline storage', status: 'running', detail: 'Checking…' },
		{ name: 'Browser window type', status: 'running', detail: 'Checking…' }
	]);
	const set = (i: number, status: Status, detail: string) => (checks[i] = { ...checks[i], status, detail });
	const label: Record<Status, string> = { running: 'Checking', pass: 'OK', warn: 'Warning', fail: 'Problem' };

	onMount(() => {
		(async () => {
			try {
				const t0 = performance.now();
				const r = await fetch('/healthz', { cache: 'no-store' });
				const ms = Math.round(performance.now() - t0);
				r.ok ? set(0, 'pass', `Reached the server in ${ms} ms.`) : set(0, 'fail', `Server answered with status ${r.status}.`);
			} catch {
				set(0, 'fail', 'Could not reach the server. The campus network may be blocking this site.');
			}
		})();

		const arrivals: number[] = [];
		const es = new EventSource('/check/stream');
		const giveUp = setTimeout(() => {
			es.close();
			if (arrivals.length === 0) set(1, 'fail', 'No live updates arrived. The scorer will fall back to checking every few seconds, which still works.');
		}, 12000);
		es.onmessage = () => {
			arrivals.push(performance.now());
			set(1, 'running', `Received ${arrivals.length} of 6…`);
			if (arrivals.length === 6) {
				clearTimeout(giveUp);
				es.close();
				const spread = arrivals[5] - arrivals[0];
				spread > 3500
					? set(1, 'pass', 'Live updates arrive as they happen.')
					: set(1, 'warn', 'Updates arrived in a bunch instead of one per second. A network filter may be delaying them; the app will still work but may lag a few seconds.');
			}
		};
		es.onerror = () => {
			if (arrivals.length >= 6) return;
		};

		(async () => {
			try {
				const ok = await new Promise<boolean>((resolve, reject) => {
					const req = indexedDB.open('sb-network-check', 1);
					req.onupgradeneeded = () => req.result.createObjectStore('t');
					req.onerror = () => reject(req.error);
					req.onsuccess = () => {
						const db = req.result;
						const tx = db.transaction('t', 'readwrite');
						tx.objectStore('t').put(Date.now(), 'probe');
						tx.oncomplete = () => {
							db.close();
							resolve(true);
						};
						tx.onerror = () => reject(tx.error);
					};
				});
				set(2, ok ? 'pass' : 'fail', 'This browser can save scoring actions locally while offline.');
			} catch {
				set(2, 'fail', 'This browser cannot save data locally. Offline protection will not work in this window.');
			}
		})();

		(async () => {
			try {
				const est = await navigator.storage?.estimate?.();
				const quotaGb = (est?.quota ?? 0) / 1024 ** 3;
				if (!est?.quota) set(3, 'warn', 'Could not tell what kind of window this is.');
				else if (quotaGb < 1.5)
					set(3, 'warn', 'This looks like a Guest or Incognito window. Scoring still works, but anything not yet sent to the server is erased when the window closes. Use a regular Chrome profile if you can.');
				else set(3, 'pass', 'Regular browser profile: unsent actions survive closing the window.');
			} catch {
				set(3, 'warn', 'Could not tell what kind of window this is.');
			}
		})();
	});
</script>

<svelte:head><title>Network check · Scholars' Bowl Scoring</title></svelte:head>

<div class="container narrow">
	<h1>Room computer check</h1>
	<p class="muted">Open this page on a room computer before the event. It takes about 10 seconds.</p>
	<div class="card">
		<ul class="checks">
			{#each checks as c (c.name)}
				<li>
					<span class="badge {c.status === 'pass' ? 'ok' : c.status === 'warn' ? 'warn' : c.status === 'fail' ? 'bad' : 'info'}">{label[c.status]}</span>
					<div>
						<strong>{c.name}</strong>
						<div class="small">{c.detail}</div>
					</div>
				</li>
			{/each}
		</ul>
	</div>
</div>

<style>
	.checks {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.checks li {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	.checks li:last-child {
		border-bottom: 0;
	}
	.checks .badge {
		min-width: 84px;
		justify-content: center;
		margin-top: 2px;
	}
</style>
