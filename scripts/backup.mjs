// Consistent snapshot of the database, safe while the app is running.
// Usage (inside the container): node scripts/backup.mjs [kind]
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const kind = process.argv[2] ?? 'manual';
const dataDir = process.env.DATA_DIR ?? 'data';
const src = process.env.DATABASE_PATH ?? path.join(dataDir, 'scoring.db');
if (!fs.existsSync(src)) {
	console.log('No database yet; nothing to back up.');
	process.exit(0);
}
const dir = process.env.BACKUP_DIR ?? path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const file = path.join(dir, `scoring-${kind}-${stamp}.db`);
const db = new Database(src, { fileMustExist: true });
db.pragma('busy_timeout = 10000');
await db.backup(file);
db.close();
console.log(`Backup written: ${file}`);

// Keep the newest copies of each kind this script makes.
const keep = { 'pre-deploy': 20, offsite: 10, manual: 20 };
if (keep[kind]) {
	const mine = fs
		.readdirSync(dir)
		.filter((f) => f.startsWith(`scoring-${kind}-`) && f.endsWith('.db'))
		.sort()
		.reverse();
	for (const old of mine.slice(keep[kind])) fs.rmSync(path.join(dir, old), { force: true });
}
