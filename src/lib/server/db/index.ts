import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

let instance: { sqlite: Database.Database; db: DB } | null = null;

export const dataDir = () => path.resolve(process.env.DATA_DIR ?? 'data');
export const dbPath = () => process.env.DATABASE_PATH ?? path.join(dataDir(), 'scoring.db');
export const migrationsDir = () => path.resolve(process.env.MIGRATIONS_DIR ?? 'drizzle');

/** Open the database (once), apply pragmas, and run pending migrations with a safety backup first. */
export function getDb(): DB {
	return open().db;
}

export function getSqlite(): Database.Database {
	return open().sqlite;
}

function open() {
	if (instance) return instance;
	const file = dbPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const existed = fs.existsSync(file);
	const sqlite = new Database(file);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('synchronous = FULL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('busy_timeout = 5000');
	const db = drizzle(sqlite, { schema });
	if (existed && hasPendingMigrations(sqlite)) {
		const dir = path.join(dataDir(), 'backups');
		fs.mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		sqlite.backup(path.join(dir, `pre-migration-${stamp}.db`));
	}
	migrate(db, { migrationsFolder: migrationsDir() });
	instance = { sqlite, db };
	return instance;
}

function hasPendingMigrations(sqlite: Database.Database): boolean {
	try {
		const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir(), 'meta', '_journal.json'), 'utf8'));
		const applied = sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number };
		return journal.entries.length > applied.n;
	} catch {
		return true;
	}
}

/** For tests: use a fresh in-memory database. */
export function useMemoryDb(): DB {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: migrationsDir() });
	instance = { sqlite, db };
	return db;
}

export { schema };
