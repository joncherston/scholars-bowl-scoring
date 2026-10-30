import { CONFIRM_ITEMS, DEFAULT_BRACKET_FORMAT, normalizeRules, parsePoints, type DivisionFormat, type RuleSettings, type StandingsCriterion } from '$lib/engine';
import { audit } from '$lib/server/audit';
import { getDb, schema } from '$lib/server/db';
import { currentRuleVersion, eventIdParam, getEvent, saveRules } from '$lib/server/events';
import { requireAdmin } from '$lib/server/guard';
import { fail } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';

export function load({ params }) {
	const id = eventIdParam(params);
	const cur = currentRuleVersion(id);
	const versions = getDb()
		.select({ id: schema.ruleVersions.id, version: schema.ruleVersions.version, note: schema.ruleVersions.note, createdBy: schema.ruleVersions.createdBy, createdAt: schema.ruleVersions.createdAt })
		.from(schema.ruleVersions)
		.where(eq(schema.ruleVersions.eventId, id))
		.orderBy(desc(schema.ruleVersions.version))
		.all();
	return { rules: cur.settings, version: cur.version, versions, confirmItems: CONFIRM_ITEMS.map((c) => ({ ...c })) };
}

class FormError extends Error {}

function parseSettings(f: FormData, base: RuleSettings, classifications: string[]): RuleSettings {
	const r = structuredClone(base);
	const pts = (name: string, allowZero = true) => {
		const v = parsePoints(String(f.get(name) ?? ''));
		if (v === null || v < 0 || (!allowZero && v === 0)) throw new FormError(`"${name}" must be a number of points.`);
		return v;
	};
	const int = (name: string, min: number, max: number) => {
		const v = Number(f.get(name));
		if (!Number.isInteger(v) || v < min || v > max) throw new FormError(`"${name}" must be a whole number from ${min} to ${max}.`);
		return v;
	};
	const on = (name: string) => f.get(name) === 'on';

	r.tossupPoints = pts('tossupPoints', false);
	r.power = { enabled: on('powerEnabled'), points: pts('powerPoints') };
	r.neg = { enabled: on('negEnabled'), points: pts('negPoints'), onlyOnInterrupt: on('negOnlyOnInterrupt') };
	const quick = String(f.get('bonusQuickValues') ?? '')
		.split(/[,\s]+/)
		.filter(Boolean)
		.map((s) => parsePoints(s));
	if (quick.some((q) => q === null || q! <= 0)) throw new FormError('Bonus quick values must be point values separated by commas.');
	r.bonus = {
		bounceback: on('bounceback'),
		rounding: (['exact', 'half_up', 'down'] as const).find((x) => x === f.get('rounding')) ?? 'exact',
		quickValues: quick as number[],
		defaultParts: int('defaultParts', 1, 10)
	};
	r.individual = { includeBonus: on('individualIncludeBonus'), includeTiebreaker: on('individualIncludeTiebreaker') };
	r.tiebreaker = { countsInRoundScore: on('tbRound'), countsInTotalPoints: on('tbTotal') };
	const minT = String(f.get('minTossups') ?? '').trim();
	r.round = {
		maxTossups: int('maxTossups', 1, 60),
		announceAfterTossup: int('announceAfterTossup', 0, 60),
		timeLimitMinutes: int('timeLimitMinutes', 1, 180),
		minTossups: minT === '' ? null : int('minTossups', 1, 60),
		endReasons: String(f.get('endReasons') ?? '')
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean)
	};
	if (!r.round.endReasons.length) r.round.endReasons = ['Time called', 'All tossups read', 'Other'];
	r.roster = { maxPlayers: int('maxPlayers', 1, 20), activePlayers: int('activePlayers', 1, 20) };
	if (r.roster.activePlayers > r.roster.maxPlayers) throw new FormError('Players at a time cannot exceed the roster limit.');
	const CRITERIA = ['roundsWon', 'winPct', 'totalPoints', 'headToHead'];
	const readOrder = (prefix: string, label: string) => {
		const order = [1, 2, 3].map((n) => String(f.get(`${prefix}${n}`))) as StandingsCriterion[];
		if (!order.every((o) => CRITERIA.includes(o)) || new Set(order).size !== 3 || (order.includes('roundsWon') && order.includes('winPct')))
			throw new FormError(`${label}: use each tie-breaker once (rounds won and win ratio measure the same thing; pick one).`);
		return order;
	};
	r.standings = { order: readOrder('order', 'Standings order') };
	const divisions = { ...base.awards.divisions };
	for (const c of classifications) {
		const name = String(f.get(`division:${c}`) ?? '').trim();
		if (!name || name.length > 60) throw new FormError(`Give ${c} an award division name (up to 60 characters).`);
		divisions[c] = name;
	}
	r.awards = {
		teamPlaces: int('teamPlaces', 1, 10),
		individualPlaces: int('individualPlaces', 0, 20),
		individualGrouping: (['division', 'classification', 'session', 'overall'] as const).find((x) => x === f.get('individualGrouping')) ?? 'division',
		divisions,
		classPlaces: int('classPlaces', 0, 10)
	};
	// Format per division (division names as just saved).
	const formats: Record<string, DivisionFormat> = {};
	for (const d of new Set(Object.values(divisions))) {
		const k = `fmt:${d}`;
		if (f.get(`${k}:type`) !== 'bracket') continue;
		const size = Number(f.get(`${k}:size`));
		formats[d] = {
			...DEFAULT_BRACKET_FORMAT,
			seedingRounds: int(`${k}:seedingRounds`, 1, 20),
			bracketSize: ([2, 4, 8] as const).find((x) => x === size) ?? 4,
			thirdPlaceGame: on(`${k}:third`),
			seeding: f.get(`${k}:seeding`) === 'poolWinnersFirst' ? 'poolWinnersFirst' : 'standings',
			bracketCountsForIndividuals: on(`${k}:indiv`),
			fillNonCounters: on(`${k}:fill`)
		};
	}
	r.format = { seedingOrder: readOrder('seed', 'Bracket seeding order'), divisions: formats };
	r.maxRoundsPerSession = int('maxRoundsPerSession', 1, 30);
	return normalizeRules(r);
}

export const actions = {
	save: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const id = eventIdParam(params);
		const f = await request.formData();
		let settings: RuleSettings;
		try {
			settings = parseSettings(f, currentRuleVersion(id).settings, getEvent(id).classifications);
		} catch (e) {
			if (e instanceof FormError) return fail(400, { error: e.message });
			throw e;
		}
		const note = String(f.get('note') ?? '').trim() || null;
		const res = saveRules(id, settings, admin.name, note);
		if (res.changed) audit(`user:${admin.id}`, 'rules_saved', { version: res.version, note }, id);
		return { saved: res.changed, version: res.version };
	},
	confirm: async ({ request, locals, params }) => {
		const admin = requireAdmin(locals.auth);
		const id = eventIdParam(params);
		const f = await request.formData();
		const key = String(f.get('key'));
		if (!CONFIRM_ITEMS.some((c) => c.key === key)) return fail(400, { error: 'Unknown item.' });
		const ev = getEvent(id);
		const confirmations = { ...ev.confirmations };
		if (f.get('confirmed') === '1') confirmations[key] = { by: admin.name, at: new Date().toISOString() };
		else delete confirmations[key];
		getDb().update(schema.events).set({ confirmations }).where(eq(schema.events.id, id)).run();
		audit(`user:${admin.id}`, f.get('confirmed') === '1' ? 'rule_confirmed' : 'rule_unconfirmed', { key }, id);
		return { confirmedKey: key };
	}
};
