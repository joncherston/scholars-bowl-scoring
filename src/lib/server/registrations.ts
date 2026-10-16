import Papa from 'papaparse';
import { normalizeClassification } from './events';

/** Column layout of the WordPress plugin's "Export to CSV" (v1.0.6). v1.0.7 adds "Classification". */
export const PLUGIN_HEADERS = [
	'ID',
	'School Name',
	'Contact Name',
	'Contact Email',
	'Contact Phone',
	'Dietary Restrictions',
	'Competing Students',
	'Additional Students',
	'Additional Adults',
	'Coaches',
	'Grade Level',
	'Session Time',
	'Total Amount',
	'Amount Paid',
	'Balance Due',
	'Payment Status',
	'Payment Method',
	'Registration Status',
	'Registration Date',
	'Payment Notes'
];

export const FIELDS = {
	registrationId: 'Registration ID',
	schoolName: 'School / team name',
	classification: 'Classification',
	session: 'Session',
	status: 'Registration status',
	registeredAt: 'Registration date',
	contactName: 'Contact name',
	contactEmail: 'Contact email',
	contactPhone: 'Contact phone',
	competingStudents: 'Competing students',
	coaches: 'Coaches'
} as const;
export type FieldKey = keyof typeof FIELDS;
export type ColumnMapping = Partial<Record<FieldKey, string>>;

const GUESSES: Record<FieldKey, RegExp> = {
	registrationId: /^(id|registration id|reg(istration)? ?#?)$/i,
	schoolName: /school|team/i,
	classification: /^classification$|class|grade level|division/i,
	session: /session/i,
	status: /registration status|^status$/i,
	registeredAt: /registration date|registered|date/i,
	contactName: /contact name|coach name|sponsor/i,
	contactEmail: /e-?mail/i,
	contactPhone: /phone/i,
	competingStudents: /competing|students/i,
	coaches: /^coaches?$/i
};

export function detectMapping(headers: string[]): { mapping: ColumnMapping; pluginLayout: boolean } {
	const has = (h: string) => headers.includes(h);
	if (PLUGIN_HEADERS.every(has)) {
		return {
			pluginLayout: true,
			mapping: {
				registrationId: 'ID',
				schoolName: 'School Name',
				// The plugin stores classification in "grade_level"; 1.0.7 adds an explicit column.
				classification: has('Classification') ? 'Classification' : 'Grade Level',
				session: 'Session Time',
				status: 'Registration Status',
				registeredAt: 'Registration Date',
				contactName: 'Contact Name',
				contactEmail: 'Contact Email',
				contactPhone: 'Contact Phone',
				competingStudents: 'Competing Students',
				coaches: 'Coaches'
			}
		};
	}
	const mapping: ColumnMapping = {};
	const taken = new Set<string>();
	for (const [field, re] of Object.entries(GUESSES) as [FieldKey, RegExp][]) {
		const h = headers.find((x) => !taken.has(x) && re.test(x.trim()));
		if (h) {
			mapping[field] = h;
			taken.add(h);
		}
	}
	return { mapping, pluginLayout: false };
}

export function parseCsv(text: string): { headers: string[]; records: Record<string, string>[]; errors: string[] } {
	const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
		header: true,
		skipEmptyLines: 'greedy',
		transformHeader: (h) => h.trim()
	});
	const errors = res.errors.slice(0, 10).map((e) => `Row ${(e.row ?? 0) + 2}: ${e.message}`);
	return { headers: res.meta.fields ?? [], records: res.data, errors };
}

export interface RegistrationRow {
	rowNumber: number;
	registrationId: number | null;
	schoolName: string;
	classification: string;
	session: string;
	status: string;
	registeredAt: string | null;
	contactName: string | null;
	contactEmail: string | null;
	contactPhone: string | null;
	competingStudents: number | null;
	coaches: number | null;
}

export const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();
const int = (s: string | undefined) => {
	const n = Number(String(s ?? '').trim());
	return Number.isFinite(n) && String(s ?? '').trim() !== '' ? Math.trunc(n) : null;
};
const text = (s: string | undefined) => {
	const v = cleanName(String(s ?? ''));
	return v === '' ? null : v;
};

/** Normalize a date like "2026-10-15 18:15:31" or "10/15/2026" to YYYY-MM-DD HH:MM:SS (or null). */
export function normalizeDate(s: string | undefined): string | null {
	const v = String(s ?? '').trim();
	if (!v) return null;
	let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
	if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
	m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(v);
	if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')} ${(m[4] ?? '0').padStart(2, '0')}:${m[5] ?? '00'}:00`;
	return null;
}

export function toRows(records: Record<string, string>[], mapping: ColumnMapping, classifications: string[]): RegistrationRow[] {
	const get = (r: Record<string, string>, f: FieldKey) => (mapping[f] ? r[mapping[f]!] : undefined);
	return records
		.map((r, i) => ({
			rowNumber: i + 2,
			registrationId: int(get(r, 'registrationId')),
			schoolName: cleanName(String(get(r, 'schoolName') ?? '')),
			classification: normalizeClassification(get(r, 'classification'), classifications),
			session: cleanName(String(get(r, 'session') ?? '')).toLowerCase(),
			status: cleanName(String(get(r, 'status') ?? '')).toLowerCase() || 'confirmed',
			registeredAt: normalizeDate(get(r, 'registeredAt')),
			contactName: text(get(r, 'contactName')),
			contactEmail: text(get(r, 'contactEmail'))?.toLowerCase() ?? null,
			contactPhone: text(get(r, 'contactPhone')),
			competingStudents: int(get(r, 'competingStudents')),
			coaches: int(get(r, 'coaches'))
		}))
		.filter((r) => r.schoolName !== '');
}

/** Key for comparing team names: case, punctuation, and spacing ignored. */
export const teamKey = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** School name with a trailing team letter removed: "Sumiton Christian B" → "Sumiton Christian". */
export const schoolNameFromTeam = (name: string) => cleanName(name).replace(/\s+(?:team\s+)?[A-D]$/i, '');
export const schoolKey = (name: string) => teamKey(schoolNameFromTeam(name));

export interface ExistingTeam {
	id: number;
	registrationId: number | null;
	name: string;
	registrationName: string | null;
	classification: string;
	sessionId: number | null;
	registrationStatus: string | null;
	contactName: string | null;
	contactEmail: string | null;
	contactPhone: string | null;
	competingStudents: number | null;
	coaches: number | null;
	withdrawn: boolean;
}

export interface SessionInfo {
	id: number;
	name: string;
	classifications: string[];
}

export type PreviewAction = 'new' | 'update' | 'unchanged' | 'withdraw' | 'skip';

export interface PreviewRow extends RegistrationRow {
	action: PreviewAction;
	include: boolean;
	notes: string[];
	existingTeamId: number | null;
	changes: { field: string; from: string; to: string }[];
	sessionId: number | null;
}

/** Pick the session for a row: by classification first, then by the session text. */
export function resolveSession(row: RegistrationRow, sessions: SessionInfo[]): { sessionId: number | null; note: string | null } {
	const byClass = sessions.find((s) => s.classifications.includes(row.classification));
	const byText = row.session ? sessions.find((s) => s.name.toLowerCase().includes(row.session)) : undefined;
	if (byClass) {
		const note =
			byText && byText.id !== byClass.id
				? `Registration says "${row.session}", but ${row.classification} is in the ${byClass.name} session`
				: null;
		return { sessionId: byClass.id, note };
	}
	return { sessionId: byText?.id ?? null, note: null };
}

/**
 * Compare a registration file against the event's teams. Nothing is applied
 * here; the admin reviews the preview and approves rows.
 */
export function buildPreview(rows: RegistrationRow[], existing: ExistingTeam[], sessions: SessionInfo[], cutoff: string | null): PreviewRow[] {
	const byReg = new Map(existing.filter((t) => t.registrationId != null).map((t) => [t.registrationId!, t]));
	const existingKeys = new Map(existing.map((t) => [teamKey(t.registrationName ?? t.name), t]));
	const out: PreviewRow[] = rows.map((r) => {
		const { sessionId, note } = resolveSession(r, sessions);
		const p: PreviewRow = { ...r, action: 'new', include: true, notes: [], existingTeamId: null, changes: [], sessionId };
		if (note) p.notes.push(note);
		if (!r.classification) p.notes.push('No classification in the file; choose one');
		if (cutoff && r.registeredAt && r.registeredAt.slice(0, 10) < cutoff) {
			p.action = 'skip';
			p.include = false;
			p.notes = [`Registered ${r.registeredAt.slice(0, 10)}, before ${cutoff} (probably an earlier year)`];
			return p;
		}
		const ex = r.registrationId != null ? byReg.get(r.registrationId) : undefined;
		if (r.status === 'cancelled') {
			if (ex && !ex.withdrawn) {
				p.action = 'withdraw';
				p.existingTeamId = ex.id;
				p.notes.push('Registration was cancelled; team will be marked withdrawn');
			} else {
				p.action = 'skip';
				p.include = false;
				p.notes = ['Cancelled registration'];
			}
			return p;
		}
		if (ex) {
			p.existingTeamId = ex.id;
			const cmp: [string, unknown, unknown][] = [
				['Name', ex.registrationName ?? ex.name, r.schoolName],
				['Classification', ex.classification, r.classification || ex.classification],
				['Session', sessionName(sessions, ex.sessionId), sessionName(sessions, sessionId ?? ex.sessionId)],
				['Status', ex.registrationStatus, r.status],
				['Contact', ex.contactName, r.contactName],
				['Email', ex.contactEmail, r.contactEmail],
				['Phone', ex.contactPhone, r.contactPhone],
				['Competing students', ex.competingStudents, r.competingStudents],
				['Coaches', ex.coaches, r.coaches]
			];
			for (const [field, from, to] of cmp)
				if (String(from ?? '') !== String(to ?? '')) p.changes.push({ field, from: String(from ?? '—'), to: String(to ?? '—') });
			if (ex.withdrawn) p.changes.push({ field: 'Withdrawn', from: 'yes', to: 'no' });
			p.action = p.changes.length ? 'update' : 'unchanged';
			p.include = p.action === 'update';
			return p;
		}
		const sameName = existingKeys.get(teamKey(r.schoolName));
		if (sameName) {
			p.include = false;
			p.notes.push(`A team named "${sameName.name}" is already in this event (different registration). Check before adding.`);
		}
		return p;
	});

	// Duplicate registrations for the same team within the file (abandoned attempts left "pending").
	const groups = new Map<string, PreviewRow[]>();
	for (const p of out) if (p.action === 'new') groups.set(teamKey(p.schoolName), [...(groups.get(teamKey(p.schoolName)) ?? []), p]);
	for (const g of groups.values()) {
		if (g.length < 2) continue;
		const confirmed = g.filter((p) => p.status === 'confirmed');
		const keep = (confirmed.length ? confirmed : g).reduce((a, b) => ((b.registeredAt ?? '') > (a.registeredAt ?? '') ? b : a));
		for (const p of g) {
			if (p === keep) {
				p.notes.push(`${g.length} registrations in this file share this name; this one is selected`);
			} else {
				p.include = false;
				p.notes.push(`Possible duplicate of registration ${keep.registrationId ?? `row ${keep.rowNumber}`}`);
			}
		}
	}
	return out;
}

function sessionName(sessions: SessionInfo[], id: number | null | undefined) {
	return sessions.find((s) => s.id === id)?.name ?? '';
}
