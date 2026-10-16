# Scholars' Bowl Scoring

Real-time scoring for Southern Union State Community College's High School Scholars' Bowl (and other quiz bowl events): registration import, check-in, scheduling, room scoring that keeps working offline, a live head-scorekeeper dashboard, and reports.

**Volunteers:** see the one-page [Day-of Guide](docs/DAY-OF-GUIDE.md), also printable in the app at `/guide`.

## How it fits together

| Area | Where | Notes |
|---|---|---|
| Scoring engine | `src/lib/engine` | One pure function (`computeRound`) turns a round's event log into scores, the tossup log, and flags; `computeStandings` ranks teams and players. Points are integer hundredths. Shared by the server, the scorer's browser, and reports. |
| Event log | `score_events` table | Append-only. Undo and corrections add events that void or amend earlier ones; nothing is deleted. Each round records the settings version it was scored under. |
| Room scorer | `/room`, `/scorer` | PIN sign-in, one computer per room (takeover needs confirmation). Actions go to IndexedDB first, then sync with retries; the page works offline and offers a "Download unsaved results" file. |
| Projector | `/projector/<token>` | Read-only scoreboard per room, live over Server-Sent Events. |
| Staff | `/events/<id>/…` | Setup, teams and CSV import, check-in, schedule, live dashboard, round audits and corrections, reports. |
| Reports | `/events/<id>/reports` | Awards sheet, full results, Excel workbook, scoresheets (blank and completed), per-round audit printouts. PDFs are rendered by headless Chromium. |

Stack: SvelteKit 2 + TypeScript (adapter-node), SQLite in WAL mode (better-sqlite3 + Drizzle migrations), SSE, Vitest + fast-check, ExcelJS, Playwright (Chromium) for PDFs. One container.

## Develop

```bash
npm install
npm run dev:local        # http://localhost:5173, data in data/dev, setup code from dev.env.example
npm test                 # engine, import, schedule, ingest, and simulation tests
npm run check            # type check
```

Create the first admin at `http://localhost:5173/setup` with the values in `dev.env.example`. From an event's "Start a new event" page you can create a **practice event** filled with fictional schools and students, and on its Live tab, **auto-play** a session to exercise the dashboard and reports.

Schema changes: edit `src/lib/server/db/schema.ts`, then `npm run db:generate` to add a migration under `drizzle/`. Migrations run automatically when the app starts, after a safety snapshot.

To check the registration importer against a real export without committing it:

```bash
REAL_CSV=/path/to/export.csv npx vitest run registrations.real
```

## Deploy

The server runs the app with Docker Compose behind a host Caddy that terminates HTTPS. Nothing about the server is committed here; your machine needs a `.deploy.env` (copy `deploy/deploy.env.example`).

```bash
./deploy/deploy.sh            # tests, type check, build, push to GitHub, push to the server, build there, back up the DB, restart
./deploy/deploy.sh rollback   # switch back to the previous image (database unchanged)
```

On the server (`$DEPLOY_PATH`):

- `docker-compose.yml`: one `app` container, `restart: unless-stopped`, health check, `./data` mounted at `/data`, port bound to `127.0.0.1:3300` only.
- `.env` (not committed; see `.env.example`): `ORIGIN`, `APP_UID`/`APP_GID` (owner of `./data`), `SETUP_TOKEN` (one-time code for `/setup`).
- `deploy/remote-deploy.sh` builds the image tagged with the commit, backs up the database, starts the new version, and rolls back automatically if it isn't healthy within two minutes. `.deploy-history` lists deployed versions.
- Caddy: `deploy/Caddyfile.snippet` was **appended** to `/etc/caddy/Caddyfile` (after a timestamped backup and `caddy validate`). SSE responses are excluded from compression.

First-time server setup (already done for scoring.suscholarsbowl.com):

```bash
mkdir -p ~/apps/scholars-bowl-scoring/data/backups && cd ~/apps/scholars-bowl-scoring
git init -b main && git config receive.denyCurrentBranch updateInstead
cp .env.example .env   # then edit; generate SETUP_TOKEN with: openssl rand -hex 16
```

## Backups and restore

- **Automatic:** every 5 minutes on event days (dates of non-test events and sessions) and nightly at 2 AM Central otherwise, in `data/backups/` (SQLite online backups, safe while running). Event-day snapshots are all kept; the newest 14 nightlies are kept.
- **Also:** before every deploy, migration, registration import, and results-file import.
- **Admin page:** "Back up now" and "Download full backup"; per-event "Export everything to Excel now".
- **Off the server:** `./deploy/pull-backups.sh` takes a fresh snapshot and copies all snapshots to `~/ScholarsBowlBackups` (`--watch` repeats every 10 minutes; leave it running on event day). A nightly 2:30 AM job is in `~/Library/LaunchAgents/edu.suscc.scholarsbowl.pull-backups.plist` (template: `deploy/pull-backups.plist.example`). Load it with:

  ```bash
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/edu.suscc.scholarsbowl.pull-backups.plist
  ```

**Restore** a snapshot on the server:

```bash
cd ~/apps/scholars-bowl-scoring
docker compose stop app
mkdir -p data/restore-$(date +%s) && mv data/scoring.db* data/restore-$(date +%s)/   # keep the current files
cp data/backups/<snapshot>.db data/scoring.db
docker compose start app
```

## Registration import

Teams come from the WordPress registration plugin's **Export to CSV** (WP Admin → Scholars' Bowl → Registrations). The export includes every year's registrations, so the import filters by a "registered on or after" date (default: January 1 of the event's year), flags duplicate sign-ups, matches re-imports on the registration ID, and shows a preview before anything changes. The plugin's `Grade Level` column holds the classification. Payment columns are not imported.

## Security notes

- Staff passwords use Argon2id; sessions are random tokens stored hashed; failed sign-ins and wrong room PINs are rate-limited (only failures count, since room computers may share one public address).
- Room PINs are per event and can be regenerated (which signs out devices using the old PIN). Projector links use a separate, regenerable token.
- Individual (student) results are visible only to signed-in staff. Practice/test events are labeled everywhere and never public.
- This repository is public: keep real registration data, server details, and secrets out of it (`.gitignore` covers `.env`, `.deploy.env`, `data/`, `local-data/`).
