import { chromium, type Browser } from 'playwright-core';

let active = 0;
const waiting: (() => void)[] = [];
const MAX = 2;

async function slot<T>(fn: () => Promise<T>): Promise<T> {
	if (active >= MAX) await new Promise<void>((r) => waiting.push(r));
	active++;
	try {
		return await fn();
	} finally {
		active--;
		waiting.shift()?.();
	}
}

/** Render one of the app's own print pages to PDF with headless Chromium, as the signed-in user. */
export function renderPdf(url: string, cookie: string, landscape = false): Promise<Uint8Array> {
	return slot(async () => {
		let browser: Browser | null = null;
		try {
			browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
			const ctx = await browser.newContext({ extraHTTPHeaders: { Cookie: cookie } });
			const page = await ctx.newPage();
			const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
			if (!res || !res.ok()) throw new Error(`Report page returned ${res?.status()}`);
			await page.emulateMedia({ media: 'print' });
			return await page.pdf({ format: 'Letter', landscape, printBackground: true, margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' } });
		} finally {
			await browser?.close();
		}
	});
}

/** Where the headless browser reaches this server: the app's own port in production, not the public address. */
export const renderOrigin = (url: URL) => (process.env.PORT && process.env.NODE_ENV === 'production' ? `http://127.0.0.1:${process.env.PORT}` : url.origin);

/**
 * The pages that may be rendered to PDF: this event's report pages and its schedule printout
 * (landscape, for the room grid). Returns the normalized path to render, or null.
 */
export function printablePage(eventId: number, path: string): { path: string; landscape: boolean } | null {
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
	let u: URL;
	try {
		u = new URL(path, 'http://app.invalid');
	} catch {
		return null;
	}
	if (u.origin !== 'http://app.invalid') return null;
	if (new RegExp(`^/events/${eventId}/reports/(awards|results|scoresheets|round/\\d+)$`).test(u.pathname)) return { path: u.pathname + u.search, landscape: false };
	if (u.pathname === `/events/${eventId}/schedule/print`) return { path: u.pathname + u.search, landscape: true };
	return null;
}
