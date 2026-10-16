import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
	testDir: 'e2e',
	// One shared server and database; tests create their own events, but run in order for predictability.
	workers: 1,
	fullyParallel: false,
	timeout: 90_000,
	expect: { timeout: 10_000 },
	reporter: [['list']],
	globalSetup: './e2e/global-setup.ts',
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
	webServer: {
		command: 'sh scripts/e2e-server.sh',
		url: `http://localhost:${PORT}/healthz`,
		reuseExistingServer: false,
		timeout: 180_000
	}
});
