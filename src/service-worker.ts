/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
// Lets the room scorer pages reload with no connection. Only the app's own
// files and the /scorer and /sheet pages are cached; everything else goes to the network.
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `sb-scorer-${version}`;
const ASSETS = new Set([...build, ...files]);
const SHELLS = ['/scorer', '/sheet'];

/** Fetch and cache the scorer pages themselves, so a scorer who loaded one can reload with no connection. */
async function cacheShell(cache: Cache) {
	for (const shell of SHELLS) {
		try {
			const res = await fetch(shell, { credentials: 'same-origin', cache: 'no-store' });
			if (res.ok && !res.redirected) await cache.put(shell, res);
		} catch {
			/* offline during install; the next visit caches it */
		}
	}
}

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then(async (c) => {
				await c.addAll([...ASSETS]);
				await cacheShell(c);
			})
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k.startsWith('sb-scorer-') && k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== sw.location.origin) return;

	if (ASSETS.has(url.pathname)) {
		event.respondWith(caches.match(url.pathname).then((hit) => hit ?? fetch(req)));
		return;
	}
	const shell = url.pathname;
	if (req.mode === 'navigate' && SHELLS.includes(shell)) {
		event.respondWith(
			fetch(req)
				.then(async (res) => {
					if (res.ok && !res.redirected) (await caches.open(CACHE)).put(shell, res.clone());
					return res;
				})
				.catch(async () => (await caches.match(shell)) ?? Response.error())
		);
	}
});
