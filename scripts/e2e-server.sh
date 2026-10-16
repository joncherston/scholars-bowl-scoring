#!/bin/sh
# Production build on a throwaway database, for the Playwright end-to-end tests.
set -e
cd "$(dirname "$0")/.."
rm -rf .e2e-data
mkdir -p .e2e-data
[ "${E2E_SKIP_BUILD:-}" = "1" ] || npm run build --silent >/dev/null
DATA_DIR=.e2e-data PORT=4173 ORIGIN=http://localhost:4173 SETUP_TOKEN=e2e-setup-code \
	COOKIE_SECURE=0 DISABLE_BACKUPS=1 NODE_ENV=production exec node build/index.js
