import { CONFIRM_ITEMS, normalizeRules, parsePoints, type RuleSettings, type StandingsCriterion } from '$lib/engine';
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

function parseSettings(f: FormData, base: RuleSettings): RuleSettings {
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
	const order = [f.get('order1'), f.get('order2'), f.get('order3')].map(String) as StandingsCriterion[];
	if (new Set(order).size !== 3 || !order.every((o) => ['roundsWon', 'totalPoints', 'headToHead'].includes(o)))
		throw new FormError('Each standings tie-breaker must be used once.');
	r.standings = { order };
	r.awards = {
		teamPlaces: int('teamPlaces', 1, 10),
		individualPlaces: int('individualPlaces', 0, 20),
		individualGrouping: (['classification', 'session', 'overall'] as const).find((x) => x === f.get('individualGrouping')) ?? 'classification',
		perSession: on('perSession')
	};
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
			settings = parseSettings(f, currentRuleVersion(id).settings);
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
