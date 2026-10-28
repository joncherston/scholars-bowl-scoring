<script lang="ts" module>
	export type { ImportPlan } from '$lib/sheet/import';
</script>

<script lang="ts">
	import { other, type RuleSettings, type Side } from '$lib/engine';
	import { formatPoints } from '$lib/engine/points';
	import type { ScorerMatch } from '$lib/scorer-types';
	import { buildPlan, exactPlayer, exactTeam, likeness, usedColumns, type ImportChoices, type ImportPlan, type ParsedSheet } from '$lib/sheet/import';
	import { SIDES, SLOTS } from '$lib/sheet/model';

	interface Props {
		match: ScorerMatch;
		rules: RuleSettings;
		/** The tab already has scores, which the import replaces. */
		hasScores: boolean;
		onapply: (plan: ImportPlan) => void;
		oncancel: () => void;
	}
	let { match, rules, hasScores, onapply, oncancel }: Props = $props();

	let loading = $state(false);
	let error = $state('');
	let sheets = $state<ParsedSheet[]>([]);
	let tabIndex = $state<number | null>(null);
	let choices = $state<ImportChoices>({ sides: [null, null], players: [[], []] });
	const sheet = $derived(tabIndex !== null ? sheets[tabIndex] : null);
	const TEAM = '__team';

	async function upload(e: Event) {
		const f = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!f) return;
		error = '';
		sheets = [];
		tabIndex = null;
		loading = true;
		try {
			const fd = new FormData();
			fd.append('file', f);
			const res = await fetch('/api/scorer/sheet-file', { method: 'POST', body: fd });
			const j = await res.json().catch(() => null);
			if (!res.ok) throw new Error(j?.message ?? 'That file could not be read.');
			sheets = j.sheets;
			const i = sheets.findIndex((s) => s.round === match.roundNo);
			if (i >= 0) pickTab(i);
			else error = `No tab for Round (${match.roundNo}) was found in this file. Choose the tab to import.`;
		} catch (err) {
			error = err instanceof Error && err.message !== 'Failed to fetch' ? err.message : 'The file could not be sent. Check the connection and try again.';
		} finally {
			loading = false;
		}
	}

	function autoPlayers(s: ParsedSheet, k: 0 | 1, side: Side | null): (string | null | undefined)[] {
		const used = usedColumns(s, k);
		return Array.from({ length: SLOTS }, (_, i) => {
			if (!used.includes(i)) return null;
			const name = s.players[k][i]?.trim();
			return side && name ? (exactPlayer(name, match.teams[side].roster) ?? undefined) : undefined;
		});
	}
	function pickTab(i: number) {
		tabIndex = i;
		error = '';
		const s = sheets[i];
		let sides: [Side | null, Side | null] = [exactTeam(s.teams[0], match), exactTeam(s.teams[1], match)];
		if (sides[0] && !sides[1]) sides[1] = other(sides[0]);
		if (sides[1] && !sides[0]) sides[0] = other(sides[1]);
		if (sides[0] && sides[0] === sides[1]) sides = [null, null];
		choices = { sides, players: [autoPlayers(s, 0, sides[0]), autoPlayers(s, 1, sides[1])] };
	}
	function setSide(k: 0 | 1, value: string) {
		if (!sheet) return;
		const side = value === 'A' || value === 'B' ? value : null;
		const sides: [Side | null, Side | null] = [...choices.sides];
		sides[k] = side;
		const j = k === 0 ? 1 : 0;
		if (side) sides[j] = other(side);
		choices = { sides, players: [autoPlayers(sheet, 0, sides[0]), autoPlayers(sheet, 1, sides[1])] };
	}
	function setPlayer(k: 0 | 1, i: number, value: string) {
		choices.players[k][i] = value === TEAM ? null : value || undefined;
	}
	const pickValue = (v: string | null | undefined) => (v === undefined ? '' : v === null ? TEAM : v);

	/** Roster choices for a column, likeliest first when the name didn't match exactly. */
	function options(k: 0 | 1, i: number) {
		const side = choices.sides[k];
		if (!side || !sheet) return [];
		const name = sheet.players[k][i] ?? '';
		return [...match.teams[side].roster].map((p) => ({ p, score: likeness(name, p.name) })).sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
	}
	const exactNames = $derived.by(() => {
		if (!sheet) return { teams: [false, false], players: [[], []] as boolean[][] };
		return {
			teams: [0, 1].map((k) => !!choices.sides[k] && exactTeam(sheet.teams[k], match) === choices.sides[k]),
			players: ([0, 1] as const).map((k) => Array.from({ length: SLOTS }, (_, i) => {
				const side = choices.sides[k];
				const id = choices.players[k][i];
				return !!side && !!id && exactPlayer(sheet.players[k][i] ?? '', match.teams[side].roster) === id;
			}))
		};
	});

	const missing = $derived.by(() => {
		if (!sheet) return ['Choose the scoresheet file.'];
		const out: string[] = [];
		if (!choices.sides[0] || !choices.sides[1]) out.push('Match both schools.');
		for (const k of [0, 1] as const) {
			const chosen = usedColumns(sheet, k).map((i) => choices.players[k][i]);
			if (chosen.some((v) => v === undefined)) out.push(`Match every player for ${sheet.teams[k] || (k === 0 ? 'the left team' : 'the right team')}.`);
			const ids = chosen.filter((v): v is string => !!v);
			if (new Set(ids).size !== ids.length) out.push('The same player is chosen for two columns.');
		}
		return out;
	});
	const built = $derived(sheet && !missing.length ? buildPlan(sheet, choices, match, rules) : null);
	const preview = $derived.by(() => {
		if (!built) return null;
		const total = (s: Side) => built.plan.rows.reduce((t, r) => t + r[s].players.reduce<number>((a, v) => a + (v ?? 0), 0) + (r[s].bonus ?? 0), 0);
		const tossups = built.plan.rows.filter((r) => SIDES.some((s) => r[s].players.some((v) => v !== null))).length;
		return { A: total('A'), B: total('B'), tossups };
	});

	function apply() {
		if (!built || !sheet) return;
		onapply({ ...built.plan, label: `the "${sheet.name}" tab` });
	}
	const colLetter = (k: 0 | 1, i: number) => String.fromCharCode((k === 0 ? 66 : 75) + i);
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="imp-title">
	<div class="dialog">
		<div class="dlg-title" id="imp-title">Import scores into Round ({match.roundNo})</div>
		<div class="dlg-body">
			<p>Choose the Excel scoresheet (.xls or .xlsx). The tab for Round ({match.roundNo}) is read and you match its school and player names to the ones here. Nothing changes until you press Import.</p>
			<label class="file">
				Scoresheet file
				<input type="file" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onchange={upload} />
			</label>
			{#if loading}<p>Reading the file…</p>{/if}
			{#if error}<p class="err" role="alert">{error}</p>{/if}
			{#if sheets.length > 1 || (sheets.length && tabIndex === null)}
				<label>
					Tab to import
					<select value={tabIndex ?? ''} onchange={(e) => pickTab(Number((e.currentTarget as HTMLSelectElement).value))}>
						{#if tabIndex === null}<option value="" disabled>Choose a tab…</option>{/if}
						{#each sheets as s, i (i)}<option value={i}>{s.name}{s.teams[0] || s.teams[1] ? ` — ${s.teams[0]} vs ${s.teams[1]}` : ''}</option>{/each}
					</select>
				</label>
			{/if}

			{#if sheet}
				<h3>Schools</h3>
				<table class="map">
					<tbody>
						{#each [0, 1] as const as k (k)}
							<tr>
								<td>{k === 0 ? 'Left' : 'Right'} team on the spreadsheet: <strong>{sheet.teams[k] || '(blank)'}</strong></td>
								<td>
									<select aria-label="School for {sheet.teams[k] || (k === 0 ? 'the left team' : 'the right team')}" value={choices.sides[k] ?? ''} onchange={(e) => setSide(k, (e.currentTarget as HTMLSelectElement).value)} class:need={!choices.sides[k]}>
										<option value="">Choose the school…</option>
										{#each SIDES as s (s)}<option value={s}>{match.teams[s].name}</option>{/each}
									</select>
									{#if exactNames.teams[k]}<span class="ok">same name</span>{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>

				<h3>Players</h3>
				<table class="map">
					<tbody>
						{#each [0, 1] as const as k (k)}
							{#each usedColumns(sheet, k) as i (i)}
								<tr>
									<td>
										{#if sheet.players[k][i]}<strong>{sheet.players[k][i]}</strong>{:else}<em>No name in column {colLetter(k, i)}</em>{/if}
										<span class="muted">({sheet.teams[k] || (k === 0 ? 'left team' : 'right team')})</span>
									</td>
									<td>
										{#if choices.sides[k]}
											{@const opts = options(k, i)}
											<select aria-label="Player for {sheet.players[k][i] || `column ${colLetter(k, i)}`}" value={pickValue(choices.players[k][i])} onchange={(e) => setPlayer(k, i, (e.currentTarget as HTMLSelectElement).value)} class:need={choices.players[k][i] === undefined}>
												<option value="">Choose the player…</option>
												{#each opts as o, j (o.p.id)}<option value={o.p.id}>{o.p.name}{j === 0 && o.score > 0 && !exactNames.players[k][i] ? ' (closest name)' : ''}</option>{/each}
												<option value={TEAM}>(no player — count for the team)</option>
											</select>
											{#if exactNames.players[k][i]}<span class="ok">same name</span>{/if}
										{:else}
											<span class="muted">Match the school first</span>
										{/if}
									</td>
								</tr>
							{/each}
						{/each}
					</tbody>
				</table>

				{#if built?.problems.length}
					<div class="warn">
						<strong>{built.problems.length} cell{built.problems.length === 1 ? '' : 's'} can't be imported:</strong>
						<ul>{#each built.problems as p (p)}<li>{p}</li>{/each}</ul>
						You can type {built.problems.length === 1 ? 'it' : 'them'} in after importing.
					</div>
				{/if}
				{#if preview}
					<p class="preview">
						After importing: {match.teams.A.name} <strong>{formatPoints(preview.A)}</strong>, {match.teams.B.name} <strong>{formatPoints(preview.B)}</strong> ({preview.tossups} tossup{preview.tossups === 1 ? '' : 's'} with answers).
					</p>
				{/if}
				{#if hasScores}<p class="warn">This tab already has scores. Importing replaces every tossup row with the spreadsheet's values.</p>{/if}
			{/if}
		</div>
		<div class="dlg-buttons">
			{#if sheet && missing.length}<span class="muted left">{missing[0]}</span>{/if}
			<button type="button" class="db primary" disabled={!built} onclick={apply}>Import</button>
			<button type="button" class="db" onclick={oncancel}>Cancel</button>
		</div>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 25%);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
		padding: 16px;
	}
	.dialog {
		background: #fff;
		border: 1px solid #888;
		box-shadow: 0 8px 30px rgb(0 0 0 / 30%);
		width: 100%;
		max-width: 720px;
		max-height: calc(100vh - 32px);
		display: flex;
		flex-direction: column;
		font: 14px 'Segoe UI', system-ui, sans-serif;
	}
	.dlg-title {
		padding: 8px 12px;
		font-weight: 600;
		border-bottom: 1px solid #e0e0e0;
		background: #fafafa;
	}
	.dlg-body {
		padding: 14px 16px;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.dlg-body p {
		margin: 0;
	}
	h3 {
		margin: 6px 0 0;
		font-size: 15px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	select {
		font: inherit;
		padding: 3px;
		max-width: 340px;
	}
	select.need {
		background: #ffff99;
	}
	.map {
		border-collapse: collapse;
		width: 100%;
	}
	.map td {
		padding: 4px 6px;
		border-bottom: 1px solid #eee;
		vertical-align: middle;
	}
	.ok {
		margin-left: 6px;
		color: #1a5c38;
		font-size: 12px;
	}
	.muted {
		color: #666;
		font-size: 13px;
	}
	.err {
		color: #a4262c;
	}
	.warn {
		background: #fff4ce;
		border-left: 4px solid #e0b000;
		padding: 6px 10px;
	}
	.warn ul {
		margin: 4px 0;
		padding-left: 20px;
	}
	.preview {
		font-size: 15px;
	}
	.dlg-buttons {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-top: 1px solid #e0e0e0;
	}
	.left {
		margin-right: auto;
	}
	.db {
		min-width: 80px;
		font: inherit;
		padding: 5px 14px;
		border: 1px solid #adadad;
		background: #fdfdfd;
		cursor: pointer;
	}
	.db.primary {
		border-color: #0078d4;
		box-shadow: inset 0 0 0 1px #0078d4;
	}
	.db:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
