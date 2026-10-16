<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatPoints } from '$lib/engine/points';

	let { data, form } = $props();
	const r = $derived(data.rules);
	const conf = $derived(data.event.confirmations);
	const criteria = [
		{ v: 'roundsWon', l: 'Most rounds won' },
		{ v: 'totalPoints', l: 'Total points (counting games)' },
		{ v: 'headToHead', l: 'Head-to-head among tied teams' }
	];
	const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
</script>

<svelte:head><title>Scoring settings · {data.event.name}</title></svelte:head>

{#snippet badge(key: string)}
	{#if conf[key]}
		<span class="badge ok" title="Confirmed by {conf[key].by}, {fmtWhen(conf[key].at)}">✓ Confirmed</span>
	{:else}
		<span class="badge warn">Confirm before event</span>
	{/if}
{/snippet}

<div class="row between">
	<h2>Scoring settings <span class="muted small">version {data.version}</span></h2>
</div>
<p class="muted">These settings apply to this event only. Every change is saved as a new version; each round keeps the version it was scored under.</p>

{#if form?.error}<div class="alert error" role="alert">{form.error}</div>{/if}
{#if form && 'saved' in form}
	<div class="alert {form.saved ? 'success' : 'info'}" role="status">
		{form.saved ? `Saved as version ${form.version}. Items whose settings changed need to be confirmed again.` : 'No changes to save.'}
	</div>
{/if}

<div class="layout">
	<form method="POST" action="?/save" class="stack">
		<fieldset class="card">
			<legend><h3>Tossups {@render badge('tossup')}</h3></legend>
			<div class="grid cols-3">
				<div class="field"><label for="tossupPoints">Points for a correct tossup</label><input id="tossupPoints" name="tossupPoints" type="text" inputmode="decimal" value={formatPoints(r.tossupPoints)} /></div>
				<div class="field">
					<label class="check"><input type="checkbox" name="powerEnabled" checked={r.power.enabled} /> Powers (early buzz)</label>
					<label for="powerPoints" class="hint">Power tossup worth</label>
					<input id="powerPoints" name="powerPoints" type="text" inputmode="decimal" value={formatPoints(r.power.points)} />
				</div>
				<div class="field">
					<label class="check"><input type="checkbox" name="negEnabled" checked={r.neg.enabled} /> Negs (penalty)</label>
					<label for="negPoints" class="hint">Points subtracted</label>
					<input id="negPoints" name="negPoints" type="text" inputmode="decimal" value={formatPoints(r.neg.points)} />
					<label class="check" style="margin-top: 6px"><input type="checkbox" name="negOnlyOnInterrupt" checked={r.neg.onlyOnInterrupt} /> Only on an interrupt</label>
				</div>
			</div>
		</fieldset>

		<fieldset class="card">
			<legend><h3>Bonuses {@render badge('bonus')}</h3></legend>
			<p class="muted small">Only the team that answered the tossup hears the bonus. Credit is proportional per part (a 20-point, 2-part bonus with 1 part right earns 10).</p>
			<div class="grid cols-3">
				<div class="field">
					<label for="rounding">When a share isn't whole points</label>
					<select id="rounding" name="rounding" value={r.bonus.rounding}>
						<option value="exact">Keep exact (e.g. 12.5)</option>
						<option value="half_up">Round to whole points, halves up</option>
						<option value="down">Round down to whole points</option>
					</select>
				</div>
				<div class="field"><label for="bonusQuickValues">Quick-pick values for scorers</label><input id="bonusQuickValues" name="bonusQuickValues" type="text" value={r.bonus.quickValues.map(formatPoints).join(', ')} /></div>
				<div class="field"><label for="defaultParts">Default number of parts</label><input id="defaultParts" name="defaultParts" type="number" min="1" max="10" value={r.bonus.defaultParts} /></div>
			</div>
			<label class="check"><input type="checkbox" name="bounceback" checked={r.bonus.bounceback} /> Bouncebacks (the other team may answer missed parts)</label>
		</fieldset>

		<fieldset class="card">
			<legend><h3>Individual scores {@render badge('individual')}</h3></legend>
			<label class="check"><input type="checkbox" name="individualIncludeBonus" checked={r.individual.includeBonus} /> Credit bonus points to the player who answered the tossup</label>
			<p class="muted small" style="margin-top: 4px">Unchecked: individual scores count tossups only, and bonuses are team points.</p>
		</fieldset>

		<fieldset class="card">
			<legend><h3>Tiebreakers {@render badge('tiebreaker')}</h3></legend>
			<p class="muted small">A round that ends tied goes to sudden-death tossups; the first correct answer wins.</p>
			<label class="check"><input type="checkbox" name="tbRound" checked={r.tiebreaker.countsInRoundScore} /> Tiebreaker points count toward the team's round score</label>
			<label class="check"><input type="checkbox" name="tbTotal" checked={r.tiebreaker.countsInTotalPoints} /> Tiebreaker points count toward the team's total points in standings</label>
			<label class="check"><input type="checkbox" name="individualIncludeTiebreaker" checked={r.individual.includeTiebreaker} /> Tiebreaker points count toward the individual's total</label>
		</fieldset>

		<fieldset class="card">
			<legend><h3>Rounds {@render badge('round')}</h3></legend>
			<div class="grid cols-3">
				<div class="field"><label for="maxTossups">Tossups per round (most)</label><input id="maxTossups" name="maxTossups" type="number" min="1" max="60" value={r.round.maxTossups} /></div>
				<div class="field"><label for="minTossups">Minimum tossups <span class="hint">(blank = none)</span></label><input id="minTossups" name="minTossups" type="number" min="1" max="60" value={r.round.minTossups ?? ''} /></div>
				<div class="field"><label for="timeLimitMinutes">Time limit (minutes)</label><input id="timeLimitMinutes" name="timeLimitMinutes" type="number" min="1" max="180" value={r.round.timeLimitMinutes} /></div>
				<div class="field"><label for="announceAfterTossup">Remind scorer to announce the score after tossup</label><input id="announceAfterTossup" name="announceAfterTossup" type="number" min="0" max="60" value={r.round.announceAfterTossup} /></div>
				<div class="field"><label for="maxRoundsPerSession">Most rounds per session</label><input id="maxRoundsPerSession" name="maxRoundsPerSession" type="number" min="1" max="30" value={r.maxRoundsPerSession} /></div>
				<div class="field"><label for="endReasons">Reasons for ending a round <span class="hint">(one per line)</span></label><textarea id="endReasons" name="endReasons" rows="3">{r.round.endReasons.join('\n')}</textarea></div>
			</div>
		</fieldset>

		<fieldset class="card">
			<legend><h3>Teams and standings</h3></legend>
			<div class="grid cols-3">
				<div class="field"><label for="maxPlayers">Players per team (roster limit)</label><input id="maxPlayers" name="maxPlayers" type="number" min="1" max="20" value={r.roster.maxPlayers} /></div>
				<div class="field"><label for="activePlayers">Players at a time</label><input id="activePlayers" name="activePlayers" type="number" min="1" max="20" value={r.roster.activePlayers} /></div>
			</div>
			<p><strong>Standings order</strong> <span class="muted small">(non-counter games never count)</span></p>
			<div class="grid cols-3">
				{#each [1, 2, 3] as n (n)}
					<div class="field">
						<label for="order{n}">{n === 1 ? 'First' : n === 2 ? 'Then' : 'Then'}</label>
						<select id="order{n}" name="order{n}" value={r.standings.order[n - 1]}>
							{#each criteria as c (c.v)}<option value={c.v}>{c.l}</option>{/each}
						</select>
					</div>
				{/each}
			</div>
		</fieldset>

		<fieldset class="card">
			<legend><h3>Team awards {@render badge('teamAwards')}</h3></legend>
			<div class="grid cols-3">
				<div class="field"><label for="teamPlaces">Team places per classification</label><input id="teamPlaces" name="teamPlaces" type="number" min="1" max="10" value={r.awards.teamPlaces} /></div>
			</div>
			<label class="check"><input type="checkbox" name="perSession" checked={r.awards.perSession} /> Team awards are given per classification within each session</label>
		</fieldset>

		<fieldset class="card">
			<legend><h3>Individual awards {@render badge('individualAwards')}</h3></legend>
			<div class="grid cols-3">
				<div class="field"><label for="individualPlaces">Individual places</label><input id="individualPlaces" name="individualPlaces" type="number" min="0" max="20" value={r.awards.individualPlaces} /></div>
				<div class="field">
					<label for="individualGrouping">Individual awards grouped by</label>
					<select id="individualGrouping" name="individualGrouping" value={r.awards.individualGrouping}>
						<option value="classification">Classification</option>
						<option value="session">Session</option>
						<option value="overall">Overall</option>
					</select>
				</div>
			</div>
			<h3 style="margin-top: 12px">Individual ties {@render badge('individualTies')}</h3>
			<p class="muted small">Ties at an award place are flagged for the head scorekeeper to resolve. The system never breaks an individual tie on its own.</p>
		</fieldset>

		<div class="card row">
			<div class="field" style="flex: 1; margin: 0">
				<label for="note">Note for this version <span class="hint">(optional)</span></label>
				<input id="note" name="note" type="text" placeholder="e.g. Confirmed with the rules committee" />
			</div>
			<button class="btn large" type="submit">Save settings</button>
		</div>
	</form>

	<aside class="stack">
		<div class="card">
			<h3>Confirm before the event</h3>
			<p class="muted small">Check off each item once it has been confirmed. Changing an item's settings clears its check.</p>
			<ul class="confirm">
				{#each data.confirmItems as c (c.key)}
					<li>
						<form method="POST" action="?/confirm" use:enhance>
							<input type="hidden" name="key" value={c.key} />
							<input type="hidden" name="confirmed" value={conf[c.key] ? '0' : '1'} />
							<button type="submit" class="tick" aria-pressed={!!conf[c.key]} aria-label="{conf[c.key] ? 'Unconfirm' : 'Confirm'}: {c.label}">
								{conf[c.key] ? '✓' : ''}
							</button>
						</form>
						<div>
							<div>{c.label}</div>
							{#if conf[c.key]}<div class="muted small">{conf[c.key].by}, {fmtWhen(conf[c.key].at)}</div>{:else}<span class="badge warn">Confirm before event</span>{/if}
						</div>
					</li>
				{/each}
			</ul>
		</div>
		<div class="card">
			<h3>Versions</h3>
			<ul class="versions">
				{#each data.versions as v (v.id)}
					<li><strong>v{v.version}</strong> <span class="muted small">{fmtWhen(v.createdAt)} · {v.createdBy ?? ''}</span>{#if v.note}<div class="small">{v.note}</div>{/if}</li>
				{/each}
			</ul>
		</div>
	</aside>
</div>

<style>
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 20px;
		align-items: start;
	}
	@media (max-width: 1100px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}
	fieldset.card {
		margin: 0;
	}
	legend {
		padding: 0;
		float: left;
		width: 100%;
	}
	legend + * {
		clear: both;
	}
	legend h3 {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}
	.confirm,
	.versions {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.confirm li {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.confirm form {
		margin: 0;
	}
	.tick {
		width: 28px;
		height: 28px;
		border: 2px solid var(--border-strong);
		border-radius: 6px;
		background: #fff;
		color: var(--success);
		font-weight: 800;
		cursor: pointer;
		flex: none;
	}
	.tick[aria-pressed='true'] {
		border-color: var(--success);
		background: var(--success-bg);
	}
	.versions li {
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
	}
</style>
