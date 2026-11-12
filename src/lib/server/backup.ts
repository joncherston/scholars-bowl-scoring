import fs from 'node:fs';
import path from 'node:path';
import { dataDir, getDb, getSqlite, schema } from './db';

export const TZ = 'America/Chicago';
export type BackupKind = 'event-day' | 'weekly' | 'manual' | 'pre-deploy' | 'pre-import' | 'pre-migration' | 'offsite';

export const backupDir = () => path.resolve(process.env.BACKUP_DIR ?? path.join(dataDir(), 'backups'));

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/** Consistent online snapshot of the live database (safe while the app is running). */
export async function backupNow(kind: BackupKind): Promise<string> {
	const dir = backupDir();
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `scoring-${kind}-${stamp()}.db`);
	await getSqlite().backup(file);
	prune();
	return file;
}

export function listBackups() {
	const dir = backupDir();
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.db'))
		.map((f) => {
			const st = fs.statSync(path.join(dir, f));
			return { file: f, size: st.size, mtime: st.mtime.toISOString() };
		})
		.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

const DAY = 86_400_000;

/**
 * What the server keeps; 30 days of nightly copies live off the server (deploy/pull-backups.sh).
 * The newest weekly and offsite snapshot, the newest 3 of each other kind but none older than 30 days,
 * and event-day snapshots for 30 days. Nightlies from before the weekly schedule are removed.
 */
const RETENTION: Record<string, { newest: number; maxDays?: number }> = {
	weekly: { newest: 1 },
	offsite: { newest: 1 },
	manual: { newest: 3, maxDays: 30 },
	'pre-deploy': { newest: 3, maxDays: 30 },
	'pre-import': { newest: 3, maxDays: 30 },
	'pre-migration': { newest: 3, maxDays: 30 },
	'event-day': { newest: Infinity, maxDays: 30 },
	nightly: { newest: 0 }
};

/** The kind in a snapshot name: scoring-pre-deploy-20261021-210523.db, or pre-migration-2026-10-16T01-38-51-660Z.db. */
const kindOf = (file: string) => /^(?:scoring-)?([a-z-]+?)-\d/.exec(file)?.[1];

export function prune() {
	const seen: Record<string, number> = {};
	for (const b of listBackups()) {
		const kind = kindOf(b.file) ?? '';
		const rule = RETENTION[kind];
		if (!rule) continue;
		seen[kind] = (seen[kind] ?? 0) + 1;
		const tooOld = rule.maxDays !== undefined && Date.now() - Date.parse(b.mtime) > rule.maxDays * DAY;
		if (seen[kind] > rule.newest || tooOld) fs.rmSync(path.join(backupDir(), b.file), { force: true });
	}
}

export const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const localHour = (d = new Date()) =>
	Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(d));

/** True when a real (non-test) event or one of its sessions is today. */
function isEventDay(): boolean {
	const today = localDate();
	const db = getDb();
	const evs = db.select({ id: schema.events.id, date: schema.events.eventDate, isTest: schema.events.isTest }).from(schema.events).all();
	if (evs.some((e) => !e.isTest && e.date === today)) return true;
	const sess = db.select({ date: schema.sessions.date, eventId: schema.sessions.eventId }).from(schema.sessions).all();
	const real = new Set(evs.filter((e) => !e.isTest).map((e) => e.id));
	return sess.some((s) => real.has(s.eventId) && s.date === today);
}

let timer: NodeJS.Timeout | null = null;
let lastEventDay = 0;
let lastWeeklyDate = '';

const daysSince = (date: string) => (Date.parse(localDate()) - Date.parse(date)) / DAY;

/** Every 5 minutes on event days, otherwise weekly at 2 AM Central. */
export function startBackupScheduler() {
	if (timer || process.env.DISABLE_BACKUPS === '1') return;
	const weekly = listBackups().find((b) => b.file.startsWith('scoring-weekly-'));
	lastWeeklyDate = weekly ? localDate(new Date(weekly.mtime)) : '';
	timer = setInterval(async () => {
		try {
			const now = Date.now();
			if (isEventDay()) {
				if (now - lastEventDay >= 5 * 60_000) {
					lastEventDay = now;
					await backupNow('event-day');
				}
			} else if (localHour() >= 2 && (!lastWeeklyDate || daysSince(lastWeeklyDate) >= 7)) {
				lastWeeklyDate = localDate();
				await backupNow('weekly');
			}
		} catch (err) {
			console.error('[backup] failed', err);
		}
	}, 30_000);
	timer.unref();
}
