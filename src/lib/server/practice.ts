import { HIGH_SCHOOL_DEFAULTS } from '$lib/engine';
import { eq } from 'drizzle-orm';
import { localDate } from './backup';
import { getDb, schema } from './db';
import { createEvent, DEFAULT_CLASSIFICATIONS, defaultSessions, listSessions } from './events';
import { generateDraft, savePools } from './schedule';
import { addPlayerToTeam, createTeam } from './teams';

/** Fictional schools for practice events. Any resemblance to real schools is coincidental. */
export const PRACTICE_SCHOOLS: { name: string; classification: string }[] = [
	{ name: 'Pinecrest Academy', classification: 'Private' },
	{ name: 'Magnolia Christian School', classification: 'Private' },
	{ name: 'Briarwood Preparatory', classification: 'Private' },
	{ name: 'Heritage Classical Academy', classification: 'Private' },
	{ name: 'Willow Creek School', classification: 'Private' },
	{ name: 'Cornerstone Christian Academy', classification: 'Private' },
	{ name: 'Lantern Hill Academy', classification: 'Private' },
	{ name: 'Riverbend Christian A', classification: '1A' },
	{ name: 'Riverbend Christian B', classification: '1A' },
	{ name: 'Cedar Hollow School', classification: '2A' },
	{ name: 'Fox Run High School', classification: '3A' },
	{ name: 'Lakeview High School', classification: '4A' },
	{ name: 'Maple Grove High School', classification: '5A' },
	{ name: 'Stonebridge High School', classification: '5A' },
	{ name: 'Summit High School', classification: '6A' },
	{ name: 'Northgate High School', classification: '7A' }
];

const FIRST = ['Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Quinn', 'Rowan', 'Emerson', 'Harper', 'Elliot', 'Sawyer', 'Reese', 'Parker', 'Hayden', 'Finley', 'Dakota', 'Skyler', 'Kendall', 'Logan', 'Peyton', 'Blake', 'Cameron', 'Drew', 'Jamie', 'Micah', 'Remy', 'Sage', 'Tatum', 'Lane', 'Marlow'];
const LAST = ['Ashworth', 'Bellamy', 'Calloway', 'Dunmore', 'Ellsworth', 'Fairbanks', 'Galloway', 'Hollister', 'Ingram', 'Jessup', 'Kingsley', 'Langford', 'Merriweather', 'Northcutt', 'Oakley', 'Pemberton', 'Quarles', 'Radcliffe', 'Stanhope', 'Thistlewood', 'Underhill', 'Vandermeer', 'Whitlock', 'Yarborough', 'Zellner'];

/** Small seeded PRNG so practice data is reproducible. */
export function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function createPracticeEvent(actorName: string, opts: { date?: string; roomCount?: number } = {}): number {
	const date = opts.date ?? localDate();
	const id = createEvent(
		{
			name: `Practice Event ${date}`,
			eventDate: date,
			isTest: true,
			classifications: DEFAULT_CLASSIFICATIONS,
			sessions: defaultSessions(date),
			roomNames: Array.from({ length: opts.roomCount ?? 6 }, (_, i) => `Room ${i + 1}`),
			settings: structuredClone(HIGH_SCHOOL_DEFAULTS),
			settingsSource: 'SUSCC High School defaults (practice)'
		},
		actorName
	);
	const sessions = listSessions(id);
	const rand = rng(id * 7919);
	const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
	const db = getDb();
	db.transaction((tx) => {
		for (const s of PRACTICE_SCHOOLS) {
			const session = sessions.find((x) => x.classifications.includes(s.classification));
			const teamId = createTeam(tx, id, {
				name: s.name,
				registrationName: s.name,
				classification: s.classification,
				sessionId: session?.id ?? null,
				source: 'manual',
				registrationStatus: 'confirmed',
				contactName: `${pick(FIRST)} ${pick(LAST)}`,
				competingStudents: 6,
				coaches: 1
			});
			tx.update(schema.teams).set({ arrivedAt: new Date().toISOString(), arrivedBy: 'practice data' }).where(eq(schema.teams.id, teamId)).run();
			const n = 4 + Math.floor(rand() * 3);
			const used = new Set<string>();
			for (let i = 0; i < n; i++) {
				let first: string, last: string;
				do {
					first = pick(FIRST);
					last = pick(LAST);
				} while (used.has(`${first} ${last}`));
				used.add(`${first} ${last}`);
				addPlayerToTeam(tx, teamId, { firstName: first, lastName: last, grade: String(9 + Math.floor(rand() * 4)) });
			}
		}
	});
	// Merge the small morning classifications into one pool, then build and publish schedules.
	for (const s of sessions) {
		if (s.classifications.includes('1A')) savePools(s.id, { Private: 'Private', '1A': '1A–3A', '2A': '1A–3A', '3A': '1A–3A' });
		else savePools(s.id, Object.fromEntries(s.classifications.map((c) => [c, '4A–7A'])));
		generateDraft(id, s.id, { rounds: 6, onlyArrived: false, fillByesWithNonCounters: true });
		db.update(schema.sessions).set({ scheduleStatus: 'published', schedulePublishedAt: new Date().toISOString() }).where(eq(schema.sessions.id, s.id)).run();
	}
	return id;
}
