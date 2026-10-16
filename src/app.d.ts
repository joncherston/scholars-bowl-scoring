// See https://svelte.dev/docs/kit/types#app.d.ts
import type { AuthContext } from '$lib/server/auth';

declare global {
	namespace App {
		interface Locals {
			auth: AuthContext;
		}
	}
}

export {};
