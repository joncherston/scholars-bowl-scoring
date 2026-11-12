import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prune } from './backup';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const name = (kind: string, d: Date) => `scoring-${kind}-${d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}.db`;

describe('Mac copies (deploy/backup-retention.sh)', () => {
	// macOS's /bin/bash (3.2) is what the nightly job runs.
	const leaveOut = (names: string[]) =>
		execFileSync('/bin/bash', [path.resolve('deploy/backup-retention.sh')], { input: names.join('\n') + '\n', encoding: 'utf8' })
			.split('\n')
			.filter(Boolean)
			.sort();

	it('keeps 30 days of copies and drops older ones', () => {
		const recent = [name('nightly', ago(1)), name('offsite', ago(29)), name('manual', ago(10)), name('pre-deploy', ago(20))];
		const old = [name('nightly', ago(31)), name('offsite', ago(45)), name('pre-import', ago(60)), name('pre-deploy', ago(90))];
		const legacyMigration = `pre-migration-${ago(40).toISOString().replace(/[:.]/g, '-')}.db`;
		expect(leaveOut([...recent, ...old, legacyMigration])).toEqual([...old, legacyMigration].sort());
	});

	it('keeps event-day snapshots and the pre-deploys within a week of an event for good', () => {
		const event = [name('event-day', ago(100)), name('event-day', new Date(ago(100).getTime() + 3_600_000))];
		const nearEvent = [name('pre-deploy', ago(107)), name('pre-deploy', ago(103)), name('pre-deploy', ago(94))];
		const farFromEvent = [name('pre-deploy', ago(120)), name('pre-deploy', ago(92)), name('nightly', ago(101)), name('pre-import', ago(103))];
		expect(leaveOut([...event, ...nearEvent, ...farFromEvent])).toEqual(farFromEvent.sort());
	});

	it('ignores other files and lists each name once', () => {
		const old = name('nightly', ago(40));
		expect(leaveOut(['pull.log', 'notes.db', old, old, ''])).toEqual([old]);
		expect(leaveOut([])).toEqual([]);
	});
});

describe('server snapshots (prune)', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-backups-'));
	afterEach(() => {
		delete process.env.BACKUP_DIR;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const make = (file: string, d: Date) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, file), '');
		fs.utimesSync(path.join(dir, file), d, d);
		return file;
	};

	it('keeps one weekly, one offsite, three of each other kind within 30 days, and event days for 30 days', () => {
		process.env.BACKUP_DIR = dir;
		const at = (kind: string, days: number) => make(name(kind, ago(days)), ago(days));
		const legacyMigration = (days: number) => make(`pre-migration-${ago(days).toISOString().replace(/[:.]/g, '-')}.db`, ago(days));
		const kept = [
			at('weekly', 2),
			at('offsite', 0.5),
			...[1, 2, 3].map((d) => at('pre-deploy', d)),
			at('manual', 29),
			...[1, 2, 3].map(legacyMigration),
			at('event-day', 29),
			at('event-day', 29.9),
			'notes.db'
		];
		make('notes.db', ago(400));
		const removed = [
			at('weekly', 9),
			at('offsite', 1.5),
			at('pre-deploy', 4),
			at('pre-import', 31),
			at('manual', 40),
			legacyMigration(4),
			at('event-day', 31),
			...[1, 5, 13].map((d) => at('nightly', d))
		];
		prune();
		const left = fs.readdirSync(dir).sort();
		expect(left).toEqual(kept.sort());
		expect(left.filter((f) => removed.includes(f))).toEqual([]);
	});
});
