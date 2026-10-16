import { request, type FullConfig } from '@playwright/test';
import fs from 'node:fs';
import { ADMIN, ADMIN_STATE, BASE } from './helpers';

/** Create the first admin through /setup and save the signed-in state for tests. */
export default async function globalSetup(_config: FullConfig) {
	const ctx = await request.newContext({ baseURL: BASE });
	const res = await ctx.post('/setup', {
		form: { token: 'e2e-setup-code', name: ADMIN.name, email: ADMIN.email, password: ADMIN.password, confirm: ADMIN.password },
		headers: { Origin: BASE }
	});
	if (!res.ok()) throw new Error(`Admin setup failed: ${res.status()} ${(await res.text()).slice(0, 300)}`);
	fs.mkdirSync('e2e/.auth', { recursive: true });
	await ctx.storageState({ path: ADMIN_STATE });
	await ctx.dispose();
}
