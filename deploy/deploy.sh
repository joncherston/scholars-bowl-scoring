#!/usr/bin/env bash
# One-command deploy from a developer machine.
#   ./deploy/deploy.sh            unit + end-to-end tests, build, push, and deploy the current commit
#   SKIP_E2E=1 ./deploy/deploy.sh skip the browser tests (emergency fixes only)
#   ./deploy/deploy.sh rollback   switch the server back to the previous version
# Server details come from .deploy.env (not committed); see deploy/deploy.env.example.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .deploy.env ] || { echo "Missing .deploy.env (copy deploy/deploy.env.example)"; exit 1; }
# shellcheck disable=SC1091
source .deploy.env
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)
[ -n "${DEPLOY_HOST_KEY_ALIAS:-}" ] && SSH_OPTS+=(-o "HostKeyAlias=$DEPLOY_HOST_KEY_ALIAS")
export GIT_SSH_COMMAND="ssh ${SSH_OPTS[*]}"
remote() { ssh "${SSH_OPTS[@]}" "$DEPLOY_SSH" "$@"; }

if [ "${1:-}" = "rollback" ]; then
	remote "cd '$DEPLOY_PATH' && ./deploy/remote-rollback.sh"
	exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
	echo "Commit your changes before deploying."
	exit 1
fi

echo "==> Tests"
npm test --silent
echo "==> Type check"
npm run check --silent
if [ "${SKIP_E2E:-}" = "1" ]; then
	echo "==> Build (end-to-end tests skipped)"
	npm run build --silent >/dev/null
else
	echo "==> End-to-end tests (builds the app)"
	npx playwright test --reporter=line
fi

echo "==> Push to GitHub"
git push -q origin HEAD:main
echo "==> Push to server"
git push -q "$DEPLOY_SSH:$DEPLOY_PATH" HEAD:main
remote "cd '$DEPLOY_PATH' && ./deploy/remote-deploy.sh"
