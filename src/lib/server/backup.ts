import fs from 'node:fs';
import path from 'node:path';
import { dataDir, getDb, getSqlite, schema } from './db';

export const TZ = 'America/Chicago';
export type BackupKind = 'event-day' | 'nightly' | 'manual' | 'pre-deploy' | 'pre-import' | 'pre-migration';

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

/** Keep every event-day snapshot; keep the newest 14 nightlies and 20 of each other kind. */
function prune() {
	const keep: Partial<Record<BackupKind, number>> = { nightly: 14, manual: 20, 'pre-deploy': 20, 'pre-import': 20, 'pre-migration': 20 };
	const all = listBackups();
	for (const [kind, n] of Object.entries(keep)) {
		const ofKind = all.filter((b) => b.file.startsWith(`scoring-${kind}-`));
		for (const old of ofKind.slice(n!)) fs.rmSync(path.join(backupDir(), old.file), { force: true });
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
let lastNightlyDate = '';

/** Every 5 minutes on event days, nightly at 2 AM Central otherwise. */
export function startBackupScheduler() {
	if (timer || process.env.DISABLE_BACKUPS === '1') return;
	lastNightlyDate = listBackups().find((b) => b.file.startsWith('scoring-nightly-'))
		? localDate(new Date(listBackups().find((b) => b.file.startsWith('scoring-nightly-'))!.mtime))
		: '';
	timer = setInterval(async () => {
		try {
			const now = Date.now();
			if (isEventDay()) {
				if (now - lastEventDay >= 5 * 60_000) {
					lastEventDay = now;
					await backupNow('event-day');
				}
			} else if (localHour() >= 2 && lastNightlyDate !== localDate()) {
				lastNightlyDate = localDate();
				await backupNow('nightly');
			}
		} catch (err) {
			console.error('[backup] failed', err);
		}
	}, 30_000);
	timer.unref();
}
