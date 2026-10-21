import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
