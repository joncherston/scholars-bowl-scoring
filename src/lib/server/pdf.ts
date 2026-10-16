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
