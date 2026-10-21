<script lang="ts">
	import { dev } from '$app/environment';
	import { goto } from '$app/navigation';
	import { rejectReason, ScorerStore } from '$lib/client/scorer-store.svelte';
	import RoundSummary from '$lib/components/RoundSummary.svelte';
	import Scoreboard from '$lib/components/Scoreboard.svelte';
	import TossupLog from '$lib/components/TossupLog.svelte';
	import { computeRound, other, type BonusPart, type EventBody, type Side } from '$lib/engine';
	import { bonusShare, formatPoints, parsePoints } from '$lib/engine/points';
	import type { ScorerMatch } from '$lib/scorer-types';
	import { onDestroy, onMount, tick } from 'svelte';

	const store = new ScorerStore();
	let ready = $state(false);
	let matchId = $state<number | null>(null);
	let showGames = $state(false);
	let menuOpen = $state(false);
	let helpOpen = $state(false);

	// ---------- Derived round state ----------
	const match = $derived(matchId !== null ? store.match(matchId) : undefined);
	const events = $derived(matchId !== null ? store.eventsFor(matchId) : []);
	const result = $derived(match ? computeRound(events, match.rules) : null);
	const rules = $derived(match?.rules);
	const status = $derived(result?.status ?? 'not_started');
	const statusOf = (m: ScorerMatch) => computeRound(store.eventsFor(m.id), m.rules).status;

	const nameOf = (id: string | null) => {
		if (!id || !match) return 'Team';
		return match.teams.A.roster.find((p) => p.id === id)?.name ?? match.teams.B.roster.find((p) => p.id === id)?.name ?? 'Unknown player';
	};
	const lineup = (side: Side) => (result?.lineups[side] ?? []).map((id) => ({ id, name: nameOf(id) }));

	const cur = $derived(result?.currentTossup ?? { number: 1, tiebreaker: false });
	const line = $derived(result?.tossups.find((t) => t.number === cur.number && t.tiebreaker === cur.tiebreaker));
	const phase = $derived.by(() => {
		if (!result) return 'buzz';
		if (result.decidedByTiebreaker) return 'decided';
		if (!line || line.answers.length === 0) return 'buzz';
		if (line.state === 'open') return 'second';
		if (line.state === 'awaiting_bonus') return 'bonus';
		return 'buzz';
	});
	const turnSide = $derived(phase === 'second' && line ? other(line.answers[0].side) : null);
	const pastMax = $derived(!!rules && !cur.tiebreaker && cur.number > rules.round.maxTossups);
	const tossupLabel = $derived(cur.tiebreaker ? `Tiebreaker ${cur.number}` : pastMax ? 'All tossups read' : `Tossup ${cur.number}`);

	// ---------- Selection for the current tossup ----------
	let sel = $state<{ side: Side; playerId: string | null } | null>(null);
	let interrupt = $state(false);
	let power = $state(false);
	// A string, so a background sync that recomputes the round with the same step doesn't count as a change.
	const stepKey = $derived(`${matchId}:${cur.tiebreaker ? 'T' : 'R'}${cur.number}:${phase}:${line?.answers.length ?? 0}`);
	$effect(() => {
		// Clear the selection only when the scorer moves to a different step.
		void stepKey;
		sel = null;
		interrupt = false;
		power = false;
	});
	const canPick = (side: Side) => !pastMax && (phase === 'buzz' || (phase === 'second' && turnSide === side));

	// Keys typed while an action is being saved are held and replayed in order once the
	// screen reflects that action, so a fast scorer never has a keystroke land in the wrong step.
	let saving = 0;
	const heldKeys: KeyboardEvent[] = [];
	async function add(body: EventBody) {
		if (matchId === null || store.leaseLost) return;
		saving++;
		try {
			await store.add(matchId, body);
		} finally {
			saving--;
			await tick();
			while (!saving && heldKeys.length) onKey(heldKeys.shift()!);
		}
	}
	async function answer(correct: boolean) {
		if (!sel) return;
		const s = sel;
		sel = null;
		await add({
			type: 'tossup_answer',
			tossup: cur.number,
			...(cur.tiebreaker ? { tiebreaker: true } : {}),
			side: s.side,
			playerId: s.playerId,
			correct,
			...(interrupt ? { interrupt: true } : {}),
			...(correct && power ? { power: true } : {})
		});
	}
	const markDead = () => add({ type: 'tossup_dead', tossup: cur.number, ...(cur.tiebreaker ? { tiebreaker: true } : {}) });

	// ---------- Bonus ----------
	let bonusValue = $state<number | null>(null);
	let bonusParts = $state<BonusPart[]>([]);
	let customValue = $state('');
	let bonusKey = '';
	$effect(() => {
		const key = phase === 'bonus' && matchId !== null ? `${matchId}:${cur.number}` : '';
		if (key && key !== bonusKey && result && rules) {
			const prev = [...result.tossups].reverse().flatMap((t) => t.bonuses)[0];
			bonusValue = prev?.value ?? null;
			bonusParts = Array(prev?.parts.length ?? rules.bonus.defaultParts).fill('incorrect');
			customValue = '';
		}
		bonusKey = key;
	});
	const setParts = (n: number) => (bonusParts = Array.from({ length: Math.max(1, Math.min(10, n)) }, (_, i) => bonusParts[i] ?? 'incorrect'));
	function cyclePart(i: number) {
		const order: BonusPart[] = rules?.bonus.bounceback ? ['incorrect', 'correct', 'bounceback'] : ['incorrect', 'correct'];
		bonusParts[i] = order[(order.indexOf(bonusParts[i]) + 1) % order.length];
	}
	const bonusPreview = $derived(
		bonusValue !== null && rules ? bonusShare(bonusValue, bonusParts.length, bonusParts.filter((p) => p === 'correct').length, rules.bonus.rounding) : null
	);
	async function saveBonus() {
		if (bonusValue === null || !line?.correctSide) return;
		await add({ type: 'bonus', tossup: cur.number, side: line.correctSide, value: bonusValue, parts: [...bonusParts] });
	}
	function useCustomValue() {
		const v = parsePoints(customValue);
		if (v !== null && v > 0) bonusValue = v;
	}

	// ---------- Undo ----------
	const UNDOABLE = new Set(['tossup_answer', 'tossup_dead', 'bonus', 'round_ended', 'tiebreaker_started', 'lineup_set', 'round_started']);
	const lastUndoable = $derived(
		result ? [...result.audit].reverse().find((a) => a.active && a.event.actor.startsWith('room:') && UNDOABLE.has(a.event.body.type)) : undefined
	);
	const describe = (b: EventBody): string => {
		switch (b.type) {
			case 'tossup_answer':
				return `${b.tiebreaker ? 'Tiebreaker' : 'Tossup'} ${b.tossup}: ${nameOf(b.playerId)} ${b.correct ? 'correct' : 'wrong'}`;
			case 'tossup_dead':
				return `Tossup ${b.tossup} dead`;
			case 'bonus':
				return `Tossup ${b.tossup} bonus`;
			case 'round_ended':
				return 'End of round';
			case 'tiebreaker_started':
				return 'Start of tiebreaker';
			case 'lineup_set':
				return 'Lineup change';
			case 'round_started':
				return 'Start of round (back to lineups)';
			default:
				return b.type;
		}
	};
	async function undo() {
		if (!lastUndoable) return;
		await add({ type: 'undo', target: lastUndoable.event.id });
	}

	// ---------- Announce after tossup N ----------
	const announced = $derived(result?.audit.some((a) => a.active && a.event.body.type === 'note' && a.event.body.text.startsWith('Score announced')) ?? false);
	const announceDue = $derived(
		!!result &&
			!!rules &&
			rules.round.announceAfterTossup > 0 &&
			status === 'in_progress' &&
			!announced &&
			result.tossups.some((t) => !t.tiebreaker && t.number === rules.round.announceAfterTossup && t.state === 'complete')
	);
	const markAnnounced = () => add({ type: 'note', text: `Score announced after tossup ${rules?.round.announceAfterTossup}` });

	// ---------- End round / tiebreaker / submit ----------
	let endOpen = $state(false);
	let endReason = $state('');
	let endNote = $state('');
	let confirmed = $state(false);
	function openEnd() {
		endReason = endReason || rules?.round.endReasons[0] || 'Time called';
		endOpen = true;
	}
	async function endRound() {
		endOpen = false;
		const note = [endNote.trim(), result?.decidedByTiebreaker ? 'Decided by tiebreaker' : ''].filter(Boolean).join('. ');
		await add({ type: 'round_ended', reason: endReason, ...(note ? { note } : {}) });
	}
	async function startTiebreaker() {
		endOpen = false;
		await add({ type: 'tiebreaker_started' });
	}
	async function submitRound() {
		if (!result || !confirmed) return;
		await add({ type: 'submitted', scoreA: result.teams.A.roundScore, scoreB: result.teams.B.roundScore });
		confirmed = false;
	}

	// ---------- Lineups ----------
	let pick = $state<Record<Side, string[]>>({ A: [], B: [] });
	let lineupFor = $state<number | null>(null);
	let fixLineupOpen = $state(false);
	$effect(() => {
		if (match && status === 'not_started' && lineupFor !== match.id) {
			lineupFor = match.id;
			pick = { A: [...match.teams.A.defaultLineup], B: [...match.teams.B.defaultLineup] };
		}
	});
	const lineupMax = $derived(rules?.roster.activePlayers ?? 4);
	function togglePick(side: Side, id: string) {
		const list = pick[side];
		if (list.includes(id)) pick[side] = list.filter((x) => x !== id);
		else if (list.length < lineupMax) pick[side] = [...list, id];
	}
	const startRound = () => add({ type: 'round_started', lineups: { A: [...pick.A], B: [...pick.B] } });
	function openFixLineup() {
		if (!result) return;
		pick = { A: [...result.lineups.A], B: [...result.lineups.B] };
		fixLineupOpen = true;
		menuOpen = false;
	}
	async function saveFixLineup() {
		if (!result) return;
		for (const side of ['A', 'B'] as const)
			if (JSON.stringify(pick[side]) !== JSON.stringify(result.lineups[side])) await add({ type: 'lineup_set', side, players: [...pick[side]] });
		fixLineupOpen = false;
	}

	// ---------- Game selection ----------
	function chooseDefault() {
		const ms = store.state?.matches ?? [];
		const open = ms.find((m) => !['submitted', 'approved', 'forfeit'].includes(statusOf(m)));
		matchId = (open ?? ms[ms.length - 1])?.id ?? null;
	}
	function openGame(id: number) {
		matchId = id;
		showGames = false;
	}
	const nextGame = $derived.by(() => {
		const ms = store.state?.matches ?? [];
		const i = ms.findIndex((m) => m.id === matchId);
		return ms.slice(i + 1).find((m) => !['submitted', 'approved', 'forfeit'].includes(statusOf(m)));
	});

	// ---------- Status ----------
	const pendingCount = $derived(store.pending.length);
	const oldestPending = $derived(store.pending.length ? Date.parse(store.pending[0].clientTs) : null);
	let now = $state(Date.now());
	const showUnsentBanner = $derived(pendingCount > 0 && (!store.online || (oldestPending !== null && now - oldestPending > 10000)));
	const statusText = $derived(
		store.leaseLost
			? 'Another computer is scoring this room'
			: pendingCount
				? store.online
					? `Saving ${pendingCount}…`
					: `Offline — ${pendingCount} action${pendingCount === 1 ? '' : 's'} waiting (saved on this computer)`
				: store.online
					? 'All changes saved'
					: 'Offline — nothing waiting'
	);
	const statusClass = $derived(store.leaseLost ? 'bad' : pendingCount && !store.online ? 'warn' : pendingCount ? 'info' : store.online ? 'ok' : 'warn');

	// ---------- Keyboard ----------
	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t.closest?.('input, select, textarea') || document.querySelector('dialog[open]') || !result || store.leaseLost) return;
		if (saving) {
			if (!e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
			heldKeys.push(e);
			return;
		}
		// Fall back to the physical key for punctuation shortcuts.
		const byCode: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=' };
		const k = (e.key && e.key !== 'Unidentified' ? e.key : (byCode[e.code] ?? '')).toLowerCase();
		if ((e.ctrlKey || e.metaKey) && k === 'z') {
			e.preventDefault();
			undo();
			return;
		}
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (k === '?') {
			helpOpen = true;
			return;
		}
		if (status !== 'in_progress') return;
		if (announceDue) {
			if (k === 'enter') {
				e.preventDefault();
				markAnnounced();
			}
			return;
		}
		if (k === 'u') return void undo();
		if (k === 'e') return void openEnd();
		if (phase === 'bonus') {
			const n = Number(k);
			if (n >= 1 && n <= bonusParts.length) cyclePart(n - 1);
			else if (k === 'enter') {
				e.preventDefault();
				saveBonus();
			} else if (k === '[' || k === ']') {
				const vals = rules!.bonus.quickValues;
				const i = bonusValue === null ? -1 : vals.indexOf(bonusValue);
				bonusValue = vals[(i + (k === ']' ? 1 : vals.length - 1) + vals.length) % vals.length];
			} else if (k === '-') setParts(bonusParts.length - 1);
			else if (k === '=' || k === '+') setParts(bonusParts.length + 1);
			return;
		}
		if (phase === 'decided') return;
		const aKeys = ['1', '2', '3', '4', '5', '6'];
		const bKeys = ['7', '8', '9', '0', '-', '='];
		const ai = aKeys.indexOf(k);
		const bi = bKeys.indexOf(k);
		if (ai >= 0 && canPick('A') && lineup('A')[ai]) sel = { side: 'A', playerId: lineup('A')[ai].id };
		else if (bi >= 0 && canPick('B') && lineup('B')[bi]) sel = { side: 'B', playerId: lineup('B')[bi].id };
		else if (k === 'a' && canPick('A')) sel = { side: 'A', playerId: null };
		else if (k === 'b' && canPick('B')) sel = { side: 'B', playerId: null };
		else if ((k === 'c' || k === 'enter') && sel) {
			e.preventDefault();
			answer(true);
		} else if (k === 'x' && sel) answer(false);
		else if (k === 'd' && !pastMax) markDead();
		else if (k === 'i' && (rules!.neg.enabled || rules!.power.enabled)) interrupt = !interrupt;
		else if (k === 'p' && rules!.power.enabled) power = !power;
		else if (k === 'escape') sel = null;
	}

	function beforeUnload(e: BeforeUnloadEvent) {
		if (store.pending.length) {
			e.preventDefault();
			e.returnValue = '';
		}
	}

	let clock: ReturnType<typeof setInterval>;
	onMount(async () => {
		await store.init();
		if (store.loadError === 'signed_out' && !store.state) {
			goto('/room');
			return;
		}
		chooseDefault();
		ready = true;
		clock = setInterval(() => (now = Date.now()), 2000);
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js', { type: dev ? 'module' : 'classic' }).catch(() => {});
	});
	onDestroy(() => {
		store.destroy();
		clearInterval(clock);
	});

	async function signOut() {
		if (store.pending.length && !confirm(`${store.pending.length} action(s) have not reached the server yet. Download the results file first? Press Cancel to go back.`)) return;
		const f = document.createElement('form');
		f.method = 'POST';
		f.action = '/logout';
		document.body.appendChild(f);
		f.submit();
	}
	const fmtTime = (t: string | null) => {
		if (!t) return '';
		const [h, m] = t.split(':').map(Number);
		return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	};
</script>

<svelte:window onkeydown={onKey} onbeforeunload={beforeUnload} />
<svelte:head><title>{store.state ? `${store.state.room.name} scorer` : 'Scorer'} · Scholars' Bowl</title></svelte:head>

{#if store.state?.event.isTest}<div class="test-banner">PRACTICE / TEST EVENT</div>{/if}

<div class="scorer">
	<header class="top">
		<div class="where">
			<strong>{store.state?.room.name ?? 'Scorer'}</strong>
			{#if match}<span>· {match.sessionName} · Round {match.roundNo}{#if match.time} · {fmtTime(match.time)}{/if}</span>{/if}
		</div>
		<div class="row">
			<span class="badge {statusClass} conn" role="status" aria-live="polite">{statusText}</span>
			{#if pendingCount}<button class="btn small secondary" type="button" onclick={() => store.downloadRescueFile()}>Download unsaved results</button>{/if}
			<button class="btn small secondary" type="button" onclick={() => (showGames = !showGames)}>Games</button>
			<div class="menu">
				<button class="btn small secondary" type="button" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>Menu</button>
				{#if menuOpen}
					<div class="menu-pop" role="menu">
						{#if status === 'in_progress'}<button type="button" role="menuitem" onclick={openFixLineup}>Fix lineup (wrong players chosen)</button>{/if}
						<button type="button" role="menuitem" onclick={() => { store.downloadRescueFile(); menuOpen = false; }}>Download results file (for a flash drive)</button>
						{#if store.state}<a role="menuitem" href="/projector/{store.state.room.projectorToken}" target="_blank" rel="noopener">Open projector view</a>{/if}
						<button type="button" role="menuitem" onclick={() => { helpOpen = true; menuOpen = false; }}>Keyboard shortcuts</button>
						<a role="menuitem" href="/guide" target="_blank" rel="noopener">Day-of Guide</a>
						<button type="button" role="menuitem" onclick={signOut}>Sign out</button>
					</div>
				{/if}
			</div>
		</div>
	</header>

	{#if showUnsentBanner}
		<div class="alert warning unsent" role="alert">
			<strong>{pendingCount} action{pendingCount === 1 ? ' is' : 's are'} saved on this computer but not yet on the server.</strong>
			Keep this window open; it will send them when the connection returns. As a backup:
			<button class="btn small" type="button" onclick={() => store.downloadRescueFile()}>Download unsaved results</button>
			and give the file (on a flash drive) to the head scorekeeper.
		</div>
	{/if}
	{#if store.rejected.length}
		<div class="alert error small">
			{store.rejected.length} action(s) were not accepted by the server ({[...new Set(store.rejected.map((r) => rejectReason(r.rejected!)))].join('; ')}). Tell the head scorekeeper; they are kept in the results file.
		</div>
	{/if}
	{#if store.fromCache}<div class="alert info small">Showing the last saved copy of this room's games because the server can't be reached.</div>{/if}

	{#if !ready}
		<p class="muted center">Loading…</p>
	{:else if !store.state || store.state.matches.length === 0}
		<div class="card center">
			<h2>No games scheduled for this room yet</h2>
			<p class="muted">Games appear here once the schedule is published. <button class="btn small secondary" type="button" onclick={() => store.refresh()}>Check again</button></p>
		</div>
	{:else if showGames || !match || !result}
		<div class="card">
			<h2>Games in {store.state.room.name}</h2>
			<ul class="games">
				{#each store.state.matches as m (m.id)}
					{@const st = statusOf(m)}
					<li>
						<button type="button" class:current={m.id === matchId} onclick={() => openGame(m.id)}>
							<span class="g-round">{m.sessionName} · Round {m.roundNo}{#if m.time} · {fmtTime(m.time)}{/if}</span>
							<span class="g-teams">{m.teams.A.name} vs {m.teams.B.name}</span>
							<span class="g-st">
								{#if !m.counts}<span class="badge">Non-counter</span>{/if}
								<span class="badge {st === 'approved' || st === 'forfeit' ? 'ok' : st === 'submitted' ? 'info' : st === 'not_started' ? '' : 'warn'}">
									{{ not_started: 'Not started', in_progress: 'In progress', ended: 'Ready to submit', submitted: 'Submitted', approved: 'Approved', forfeit: 'Forfeit' }[st]}
								</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{:else if status === 'forfeit'}
		<div class="card center">
			<h2>{match.sessionName} · Round {match.roundNo}: {match.teams.A.name} vs {match.teams.B.name}</h2>
			<p class="alert info">Forfeit recorded — nothing to score.</p>
			{#if result.forfeit}<p class="muted">{match.teams[result.forfeit.side].name} forfeited this game. The head scorekeeper recorded it.</p>{/if}
			<div class="row" style="justify-content: center; margin-top: 14px">
				{#if nextGame}<button class="btn large" type="button" onclick={() => openGame(nextGame.id)}>Next game: Round {nextGame.roundNo} →</button>{/if}
				<button class="btn secondary" type="button" onclick={() => (showGames = true)}>All games</button>
			</div>
		</div>
	{:else if status === 'not_started'}
		<div class="card">
			<h2>{match.sessionName} · Round {match.roundNo}: choose who is playing</h2>
			<p class="muted">Pick up to {lineupMax} players for each team. Substitutions happen only between rounds.</p>
			<div class="grid cols-2">
				{#each ['A', 'B'] as const as side (side)}
					<fieldset class="lineup">
						<legend><span class="side side-{side}">{side}</span> {match.teams[side].name} <span class="muted small">{pick[side].length}/{lineupMax}</span></legend>
						{#each match.teams[side].roster as p (p.id)}
							<label class="check big">
								<input type="checkbox" checked={pick[side].includes(p.id)} disabled={!pick[side].includes(p.id) && pick[side].length >= lineupMax} onchange={() => togglePick(side, p.id)} />
								{p.name}
							</label>
						{:else}
							<p class="alert warning small">No players have been entered for this team. You can still score answers for the team; ask check-in to add players.</p>
						{/each}
					</fieldset>
				{/each}
			</div>
			<div class="row" style="margin-top: 16px">
				<button class="btn large" type="button" onclick={startRound} disabled={store.leaseLost}>Start round</button>
				{#if !match.counts}<span class="badge">Non-counter game</span>{/if}
			</div>
		</div>
	{:else if status === 'in_progress'}
		<Scoreboard
			nameA={match.teams.A.name}
			nameB={match.teams.B.name}
			scoreA={result.teams.A.roundScore}
			scoreB={result.teams.B.roundScore}
			label={tossupLabel}
			sublabel={cur.tiebreaker ? 'Sudden death' : pastMax ? '' : `of ${rules!.round.maxTossups}`}
			counts={match.counts}
			winner={result.decidedByTiebreaker ? result.winner : null}
		/>

		<div class="play">
			{#each ['A', 'B'] as const as side (side)}
				<div class="players side-col-{side}" style="order: {side === 'A' ? 0 : 2}">
					<div class="col-title"><span class="side side-{side}">{side}</span> {match.teams[side].name}</div>
					{#each lineup(side) as p, i (p.id)}
						<button
							type="button"
							class="player"
							class:selected={sel?.side === side && sel.playerId === p.id}
							disabled={!canPick(side) || phase === 'bonus' || phase === 'decided'}
							onclick={() => (sel = { side, playerId: p.id })}
						>
							<kbd>{side === 'A' ? ['1', '2', '3', '4', '5', '6'][i] : ['7', '8', '9', '0', '-', '='][i]}</kbd>
							{p.name}
						</button>
					{/each}
					<button
						type="button"
						class="player team-only"
						class:selected={sel?.side === side && sel.playerId === null}
						disabled={!canPick(side) || phase === 'bonus' || phase === 'decided'}
						onclick={() => (sel = { side, playerId: null })}
					>
						<kbd>{side === 'A' ? 'A' : 'B'}</kbd> Player not sure
					</button>
				</div>
			{/each}

			<div class="action" style="order: 1" aria-live="polite">
				{#if announceDue}
					<div class="announce">
						<h2>Announce the score</h2>
						<p class="big-score">{match.teams.A.name} <strong>{formatPoints(result.teams.A.roundScore)}</strong>, {match.teams.B.name} <strong>{formatPoints(result.teams.B.roundScore)}</strong></p>
						<button class="btn large" type="button" onclick={markAnnounced}>Done <kbd>Enter</kbd></button>
					</div>
				{:else if phase === 'decided'}
					<h2>Tiebreaker won by {match.teams[result.winner!].name}</h2>
					<button class="btn large" type="button" onclick={openEnd}>End the round <kbd>E</kbd></button>
				{:else if phase === 'bonus' && line?.correctSide}
					<div class="bonus">
						<h2>Bonus for {match.teams[line.correctSide].name}</h2>
						<div class="lbl">Bonus value</div>
						<div class="chips">
							{#each rules!.bonus.quickValues as v (v)}
								<button type="button" class="chip" class:on={bonusValue === v} onclick={() => (bonusValue = v)}>{formatPoints(v)}</button>
							{/each}
							<input class="custom" type="text" inputmode="decimal" placeholder="Other" bind:value={customValue} onchange={useCustomValue} aria-label="Other bonus value" />
						</div>
						<div class="lbl">Parts</div>
						<div class="chips">
							{#each [1, 2, 3, 4] as n (n)}
								<button type="button" class="chip" class:on={bonusParts.length === n} onclick={() => setParts(n)}>{n}</button>
							{/each}
							<input class="custom" type="number" min="1" max="10" value={bonusParts.length} onchange={(e) => setParts(Number((e.currentTarget as HTMLInputElement).value))} aria-label="Number of parts" />
						</div>
						<div class="lbl">Tap each part that was answered correctly</div>
						<div class="parts">
							{#each bonusParts as p, i (i)}
								<button type="button" class="part {p}" onclick={() => cyclePart(i)} aria-label="Part {i + 1}: {p}">
									<kbd>{i + 1}</kbd> Part {i + 1}: <strong>{p === 'correct' ? '✓ Right' : p === 'bounceback' ? '↩ Other team' : '✗ Wrong'}</strong>
								</button>
							{/each}
						</div>
						<div class="row between" style="margin-top: 10px">
							<div class="preview">
								{#if bonusPreview}= <strong>{formatPoints(bonusPreview.points)}</strong> points{#if bonusPreview.fractional}&nbsp;<span class="badge warn">fractional</span>{/if}{:else}<span class="muted">Choose the bonus value</span>{/if}
							</div>
							<button class="btn large" type="button" disabled={bonusValue === null} onclick={saveBonus}>Save bonus <kbd>Enter</kbd></button>
						</div>
					</div>
				{:else if pastMax}
					<h2>All {rules!.round.maxTossups} tossups have been read</h2>
					<button class="btn large" type="button" onclick={openEnd}>End the round <kbd>E</kbd></button>
				{:else}
					<h2>{phase === 'second' ? `${match.teams[turnSide!].name}'s turn` : 'Who buzzed?'}</h2>
					{#if phase === 'second'}<p class="muted">{match.teams[other(turnSide!)].name} missed. The question is re-read for the other team.</p>{/if}
					{#if sel}
						<p class="who">{sel.playerId ? nameOf(sel.playerId) : `Team ${sel.side}`} <span class="muted">({match.teams[sel.side].name})</span></p>
						{#if rules!.neg.enabled || rules!.power.enabled}
							<div class="row">
								<label class="check"><input type="checkbox" bind:checked={interrupt} /> Interrupt <kbd>I</kbd></label>
								{#if rules!.power.enabled}<label class="check"><input type="checkbox" bind:checked={power} /> Power <kbd>P</kbd></label>{/if}
							</div>
						{/if}
						<div class="row answer">
							<button class="btn large ok" type="button" onclick={() => answer(true)}>✓ Correct <kbd>C</kbd></button>
							<button class="btn large no" type="button" onclick={() => answer(false)}>✗ Wrong <kbd>X</kbd></button>
						</div>
					{:else}
						<p class="muted">Click the player who buzzed (or press their number).</p>
					{/if}
					<button class="btn secondary" type="button" onclick={markDead}>{phase === 'second' ? 'No answer — tossup dead' : 'Dead tossup (no one buzzed)'} <kbd>D</kbd></button>
				{/if}
			</div>
		</div>

		<div class="bottom">
			<div class="row">
				<button class="btn secondary" type="button" disabled={!lastUndoable} onclick={undo} title={lastUndoable ? `Undo: ${describe(lastUndoable.event.body)}` : ''}>
					↶ Undo{#if lastUndoable}: {describe(lastUndoable.event.body)}{/if} <kbd>U</kbd>
				</button>
				<button class="btn secondary" type="button" onclick={openEnd}>End round <kbd>E</kbd></button>
				<button class="btn ghost small" type="button" onclick={() => (helpOpen = true)}>Shortcuts <kbd>?</kbd></button>
			</div>
		</div>

		<div class="log-wrap">
			<TossupLog {result} playerName={nameOf} teamNames={{ A: match.teams.A.name, B: match.teams.B.name }} newestFirst limit={8} large />
		</div>
	{:else if status === 'ended'}
		<div class="card">
			<div class="row between">
				<h2>Review and submit · {match.sessionName} Round {match.roundNo}</h2>
				<span class="muted">Ended: {result.endReason}{result.endNote ? ` (${result.endNote})` : ''}</span>
			</div>
			<Scoreboard nameA={match.teams.A.name} nameB={match.teams.B.name} scoreA={result.teams.A.roundScore} scoreB={result.teams.B.roundScore} label="Final" counts={match.counts} winner={result.winner} compact />
			<div style="margin-top: 14px">
				<RoundSummary {result} teams={match.teams} playerName={nameOf} includeBonusInIndividual={rules!.individual.includeBonus} />
			</div>
			<div class="card submit">
				<label class="check big"><input type="checkbox" bind:checked={confirmed} /> I confirmed the final score with the moderator: {match.teams.A.name} {formatPoints(result.teams.A.roundScore)}, {match.teams.B.name} {formatPoints(result.teams.B.roundScore)}</label>
				<div class="row" style="margin-top: 12px">
					<button class="btn large" type="button" disabled={!confirmed || store.leaseLost} onclick={submitRound}>Submit round</button>
					<button class="btn secondary" type="button" onclick={undo}>Back to scoring</button>
				</div>
				<p class="muted small">After you submit, this round is locked. Changes after that are made by the head scorekeeper.</p>
			</div>
		</div>
	{:else}
		<div class="card">
			<div class="row between">
				<h2>{match.sessionName} Round {match.roundNo} · {status === 'approved' ? 'Approved' : 'Submitted'}</h2>
				{#if status === 'approved'}<span class="badge ok">Approved by the head scorekeeper</span>{:else}<span class="badge info">Waiting for the head scorekeeper to approve</span>{/if}
			</div>
			<Scoreboard nameA={match.teams.A.name} nameB={match.teams.B.name} scoreA={result.teams.A.roundScore} scoreB={result.teams.B.roundScore} label="Final" counts={match.counts} winner={result.winner} compact />
			<div class="row" style="margin-top: 14px">
				{#if nextGame}<button class="btn large" type="button" onclick={() => openGame(nextGame.id)}>Next game: Round {nextGame.roundNo} →</button>{/if}
				<button class="btn secondary" type="button" onclick={() => (showGames = true)}>All games</button>
			</div>
			<div style="margin-top: 14px">
				<TossupLog {result} playerName={nameOf} teamNames={{ A: match.teams.A.name, B: match.teams.B.name }} />
			</div>
		</div>
	{/if}
</div>

{#if store.leaseLost}
	<div class="overlay" role="alertdialog" aria-labelledby="lease-title">
		<div class="card">
			<h2 id="lease-title">This room is now being scored on another computer</h2>
			<p>Someone signed in to {store.state?.room.name} on a different computer, so this one has stopped scoring. Nothing this computer saved to the server is lost.</p>
			{#if pendingCount}<p><strong>{pendingCount} action(s) from this computer never reached the server.</strong> Download them and give the file to the head scorekeeper.</p>{/if}
			<div class="row">
				<button class="btn" type="button" onclick={() => store.downloadRescueFile()}>Download this computer's results</button>
				<button class="btn secondary" type="button" onclick={signOut}>Sign out</button>
			</div>
		</div>
	</div>
{/if}

{#if endOpen && result}
	<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="end-title">
		<div class="card">
			{#if result.tied && !result.decidedByTiebreaker}
				<h2 id="end-title">The score is tied {formatPoints(result.teams.A.roundScore)}–{formatPoints(result.teams.B.roundScore)}</h2>
				<p>Play a sudden-death tiebreaker tossup. The first correct answer wins.</p>
				<div class="field">
					<label for="end-reason">Why did regulation end?</label>
					<select id="end-reason" bind:value={endReason}>{#each rules!.round.endReasons as r (r)}<option value={r}>{r}</option>{/each}</select>
				</div>
				<div class="row">
					<button class="btn large" type="button" onclick={startTiebreaker}>Start tiebreaker</button>
					<button class="btn secondary" type="button" onclick={() => (endOpen = false)}>Keep playing</button>
				</div>
				<p class="small" style="margin-top: 12px">
					<button class="btn ghost small" type="button" onclick={() => { if (confirm('End the round tied, without a tiebreaker? The head scorekeeper will be alerted.')) endRound(); }}>End tied anyway</button>
				</p>
			{:else}
				<h2 id="end-title">End the round?</h2>
				<p>Score: {match!.teams.A.name} <strong>{formatPoints(result.teams.A.roundScore)}</strong>, {match!.teams.B.name} <strong>{formatPoints(result.teams.B.roundScore)}</strong></p>
				<div class="field">
					<label for="end-reason">Reason</label>
					<select id="end-reason" bind:value={endReason}>{#each rules!.round.endReasons as r (r)}<option value={r}>{r}</option>{/each}</select>
				</div>
				<div class="field">
					<label for="end-note">Note <span class="hint">(optional)</span></label>
					<input id="end-note" type="text" bind:value={endNote} />
				</div>
				<div class="row">
					<button class="btn large" type="button" onclick={endRound}>End round and review</button>
					<button class="btn secondary" type="button" onclick={() => (endOpen = false)}>Keep playing</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

{#if fixLineupOpen && match}
	<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="fix-title">
		<div class="card wide">
			<h2 id="fix-title">Fix lineup</h2>
			<p class="muted">Use this only to correct the players chosen at the start of the round. Substitutions happen between rounds.</p>
			<div class="grid cols-2">
				{#each ['A', 'B'] as const as side (side)}
					<fieldset class="lineup">
						<legend>{match.teams[side].name}</legend>
						{#each match.teams[side].roster as p (p.id)}
							<label class="check big"><input type="checkbox" checked={pick[side].includes(p.id)} disabled={!pick[side].includes(p.id) && pick[side].length >= lineupMax} onchange={() => togglePick(side, p.id)} /> {p.name}</label>
						{/each}
					</fieldset>
				{/each}
			</div>
			<div class="row" style="margin-top: 12px">
				<button class="btn" type="button" onclick={saveFixLineup}>Save lineup</button>
				<button class="btn secondary" type="button" onclick={() => (fixLineupOpen = false)}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

{#if helpOpen}
	<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="help-title">
		<div class="card wide">
			<h2 id="help-title">Keyboard shortcuts</h2>
			<table class="data">
				<tbody>
					<tr><td><kbd>1</kbd>–<kbd>4</kbd></td><td>Team A player who buzzed</td></tr>
					<tr><td><kbd>7</kbd> <kbd>8</kbd> <kbd>9</kbd> <kbd>0</kbd></td><td>Team B player who buzzed</td></tr>
					<tr><td><kbd>A</kbd> / <kbd>B</kbd></td><td>Team A / B buzzed, player not sure</td></tr>
					<tr><td><kbd>C</kbd> or <kbd>Enter</kbd></td><td>Correct</td></tr>
					<tr><td><kbd>X</kbd></td><td>Wrong (the other team gets a turn)</td></tr>
					<tr><td><kbd>D</kbd></td><td>Dead tossup</td></tr>
					<tr><td><kbd>I</kbd> / <kbd>P</kbd></td><td>Interrupt / power (when those rules are on)</td></tr>
					<tr><td>Bonus: <kbd>1</kbd>–<kbd>9</kbd></td><td>Toggle that part right or wrong</td></tr>
					<tr><td>Bonus: <kbd>[</kbd> <kbd>]</kbd></td><td>Previous / next bonus value</td></tr>
					<tr><td>Bonus: <kbd>-</kbd> <kbd>=</kbd></td><td>Fewer / more parts</td></tr>
					<tr><td>Bonus: <kbd>Enter</kbd></td><td>Save the bonus</td></tr>
					<tr><td><kbd>U</kbd> or <kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>Undo the last action (repeat to keep undoing)</td></tr>
					<tr><td><kbd>E</kbd></td><td>End the round</td></tr>
					<tr><td><kbd>Esc</kbd></td><td>Clear the selected player</td></tr>
				</tbody>
			</table>
			<button class="btn" type="button" style="margin-top: 12px" onclick={() => (helpOpen = false)}>Close</button>
		</div>
	</div>
{/if}

<style>
	:global(body) {
		background: #e9edf5;
	}
	.scorer {
		max-width: 1500px;
		margin: 0 auto;
		padding: 10px 14px 30px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.where {
		font-size: 1.05rem;
		color: var(--suscc-navy);
	}
	.conn {
		font-size: 0.85rem;
		padding: 4px 10px;
	}
	.menu {
		position: relative;
	}
	.menu-pop {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 20;
		background: #fff;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		min-width: 300px;
		display: flex;
		flex-direction: column;
	}
	.menu-pop > * {
		text-align: left;
		padding: 10px 14px;
		border: 0;
		background: none;
		font: 600 0.95rem var(--font-body);
		color: var(--text);
		text-decoration: none;
		cursor: pointer;
	}
	.menu-pop > *:hover {
		background: var(--surface-2);
	}
	.unsent {
		margin: 0;
	}
	.center {
		text-align: center;
	}
	.games {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 6px;
	}
	.games button {
		width: 100%;
		display: grid;
		grid-template-columns: 220px 1fr auto;
		gap: 12px;
		align-items: center;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: #fff;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.games button.current {
		border-color: var(--suscc-blue);
		box-shadow: inset 4px 0 0 var(--suscc-blue);
	}
	.g-teams {
		font-weight: 700;
	}
	.g-st {
		display: flex;
		gap: 6px;
	}
	.lineup {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 12px;
	}
	.lineup legend {
		font-weight: 800;
		padding: 0 6px;
	}
	.check.big {
		font-size: 1.1rem;
		padding: 6px 0;
	}
	.check.big input {
		width: 22px;
		height: 22px;
	}
	.play {
		display: grid;
		grid-template-columns: minmax(200px, 1fr) minmax(360px, 1.6fr) minmax(200px, 1fr);
		gap: 10px;
		align-items: start;
	}
	.players {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.col-title {
		font-weight: 800;
		color: var(--suscc-navy);
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.player {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 54px;
		padding: 8px 12px;
		border: 2px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: #fff;
		font: 700 1.15rem var(--font-body);
		text-align: left;
		cursor: pointer;
		color: var(--text);
	}
	.side-col-A .player:not(:disabled):hover {
		border-color: var(--team-a);
	}
	.side-col-B .player:not(:disabled):hover {
		border-color: var(--team-b);
	}
	.player.selected {
		border-color: var(--suscc-navy);
		background: var(--suscc-gold);
		box-shadow: 0 0 0 3px var(--suscc-navy);
	}
	.player:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.player.team-only {
		font-size: 0.95rem;
		min-height: 40px;
		font-weight: 600;
		color: var(--muted);
	}
	kbd {
		display: inline-block;
		min-width: 1.6em;
		padding: 0 5px;
		border: 1px solid var(--border-strong);
		border-bottom-width: 2px;
		border-radius: 4px;
		background: var(--surface-2);
		font: 700 0.8rem var(--font-num);
		color: var(--muted);
		text-align: center;
	}
	.btn kbd {
		background: rgb(255 255 255 / 85%);
	}
	.action {
		background: #fff;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 16px;
		min-height: 260px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		align-items: flex-start;
	}
	.action h2 {
		margin: 0;
	}
	.who {
		font-size: 1.4rem;
		font-weight: 800;
		margin: 0;
	}
	.answer .btn {
		min-width: 170px;
		font-size: 1.25rem;
	}
	.btn.ok {
		background: var(--success);
		border-color: var(--success);
	}
	.btn.no {
		background: var(--danger);
		border-color: var(--danger);
	}
	.bonus {
		width: 100%;
	}
	.lbl {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		margin: 8px 0 4px;
	}
	.chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		align-items: center;
	}
	.chip {
		min-width: 56px;
		min-height: 44px;
		border: 2px solid var(--border-strong);
		border-radius: 999px;
		background: #fff;
		font: 800 1.1rem var(--font-num);
		cursor: pointer;
	}
	.chip.on {
		background: var(--suscc-navy);
		border-color: var(--suscc-navy);
		color: var(--suscc-gold);
	}
	.custom {
		width: 90px !important;
		min-height: 44px !important;
	}
	.parts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 6px;
	}
	.part {
		min-height: 52px;
		border: 2px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: #fff;
		font: 600 1rem var(--font-body);
		cursor: pointer;
		text-align: left;
		padding: 6px 10px;
	}
	.part.correct {
		border-color: var(--success);
		background: var(--success-bg);
	}
	.part.bounceback {
		border-color: var(--warning);
		background: var(--warning-bg);
	}
	.preview {
		font-size: 1.3rem;
	}
	.announce {
		width: 100%;
		background: var(--suscc-gold);
		border-radius: var(--radius);
		padding: 16px;
	}
	.big-score {
		font-size: 1.5rem;
	}
	.bottom {
		display: flex;
		justify-content: space-between;
	}
	.log-wrap {
		border-radius: var(--radius);
		overflow: hidden;
		border: 1px solid var(--border);
	}
	.submit {
		margin-top: 14px;
		border-left: 6px solid var(--suscc-blue);
	}
	.overlay {
		position: fixed;
		inset: 0;
		background: rgb(18 32 71 / 55%);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
		padding: 16px;
	}
	.overlay .card {
		max-width: 560px;
		width: 100%;
	}
	.overlay .card.wide {
		max-width: 820px;
	}
	.side {
		display: inline-block;
		min-width: 1.6em;
		text-align: center;
		font: 800 0.8rem/1.6 var(--font-head);
		border-radius: 3px;
		color: #fff;
	}
	.side-A {
		background: var(--team-a);
	}
	.side-B {
		background: var(--team-b);
	}
	@media (max-width: 1000px) {
		.play {
			grid-template-columns: 1fr 1fr;
		}
		.action {
			grid-column: 1 / -1;
			order: 3 !important;
		}
		.games button {
			grid-template-columns: 1fr;
		}
	}
</style>
