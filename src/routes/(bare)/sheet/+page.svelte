<script lang="ts">
	import { dev } from '$app/environment';
	import { goto } from '$app/navigation';
	import { rejectReason, ScorerStore } from '$lib/client/scorer-store.svelte';
	import PracticeStart from '$lib/components/PracticeStart.svelte';
	import SheetImport, { type ImportPlan } from '$lib/components/SheetImport.svelte';
	import { computeRound, type EventBody, type Side } from '$lib/engine';
	import { formatPoints } from '$lib/engine/points';
	import { rememberScorerMode, type ScorerMatch } from '$lib/scorer-types';
	import { ALL_COLS, ALL_ROWS, address, colName, colWidth, FINAL_ROW, formulaOf, FROZEN_ROWS, frozenTop, GRID_WIDTH, HEADER_HEIGHT, LAYOUT, NC, NR, roleOf, ROW_HEADER_WIDTH, rowHeight, span } from '$lib/sheet/grid';
	import {
		BONUS_COL,
		CUML_COL,
		FIRST_TU_ROW,
		isTiebreakerRow,
		moderatorNote,
		NOTES_COL,
		parseCell,
		PLAYER_COL,
		rowChanges,
		rowNote,
		SHEET_TOSSUPS,
		sheetNotes,
		sheetRows,
		sheetSlots,
		sheetTotals,
		SIDES,
		SLOTS,
		TOTAL_COL,
		TU_COL,
		type SheetRow,
		type Slot
	} from '$lib/sheet/model';
	import { LABELS } from '$lib/sheet/template';
	import { onDestroy, onMount, tick } from 'svelte';

	const store = new ScorerStore();
	let ready = $state(false);
	let matchId = $state<number | null>(null);

	// ---------- The open tab's round ----------
	const match = $derived(matchId !== null ? store.match(matchId) : undefined);
	const events = $derived(matchId !== null ? store.eventsFor(matchId) : []);
	const rules = $derived(match?.rules);
	const result = $derived(match ? computeRound(events, match.rules) : null);
	const status = $derived(result?.status ?? 'not_started');
	const locked = $derived(status === 'submitted' || status === 'approved' || status === 'forfeit');
	const statusOf = (m: ScorerMatch) => computeRound(store.eventsFor(m.id), m.rules).status;
	const slots = $derived<Record<Side, Slot[]> | null>(match ? { A: sheetSlots(match, result, 'A'), B: sheetSlots(match, result, 'B') } : null);
	const rows = $derived(slots && rules ? sheetRows(result, slots, rules) : []);
	const notes = $derived(sheetNotes(result));
	const totals = $derived(slots && rules ? sheetTotals(rows, slots, result, rules) : null);

	/** The same, read fresh for one game when a queued change runs (the scorer may have moved to another tab). */
	function stateOf(id: number) {
		const m = store.match(id)!;
		const res = computeRound(store.eventsFor(id), m.rules);
		const sl = { A: sheetSlots(m, res, 'A'), B: sheetSlots(m, res, 'B') };
		return { m, res, sl, rows: sheetRows(res, sl, m.rules), notes: sheetNotes(res), rules: m.rules };
	}
	const ids = (xs: Slot[]) => xs.flatMap((x) => (x.playerId ? [x.playerId] : []));

	// ---------- What each cell shows ----------
	const fp = formatPoints;
	const view = $derived.by(() => {
		const t: string[][] = Array.from({ length: NR }, () => Array<string>(NC).fill(''));
		for (const [addr, text] of Object.entries(LABELS)) {
			const m = /^([A-Z])(\d+)$/.exec(addr)!;
			t[Number(m[2]) - 1][m[1].charCodeAt(0) - 65] = text;
		}
		if (!match || !slots || !totals) return t;
		t[0][1] = `${store.state?.event.name ?? ''} – ${match.sessionName}`;
		t[1][1] = String(match.roundNo);
		t[1][8] = notes.moderator;
		t[1][14] = match.roomName || store.state?.room.name || '';
		t[2][1] = match.teams.A.name;
		t[2][10] = match.teams.B.name;
		for (const side of SIDES) {
			slots[side].forEach((s, i) => (t[3][PLAYER_COL[side] + i] = s.name));
			rows.forEach((row, k) => {
				const r = FIRST_TU_ROW + k;
				row[side].players.forEach((v, i) => (t[r][PLAYER_COL[side] + i] = v === null ? '' : fp(v)));
				t[r][BONUS_COL[side]] = row[side].bonus === null ? '' : fp(row[side].bonus);
				t[r][TOTAL_COL[side]] = totals.rowTotal[side][k] ? fp(totals.rowTotal[side][k]) : '';
				const cum = totals.cumulative[side][k];
				t[r][CUML_COL[side]] = cum === null ? '' : fp(cum);
			});
			const c0 = PLAYER_COL[side];
			t[FINAL_ROW][c0] = fp(totals.final[side]);
			for (let i = 0; i < SLOTS; i++) {
				const show = (v: number | null, f: (n: number) => string = String) => (v === null ? '' : f(v));
				t[FINAL_ROW + 1][c0 + i] = show(totals.count15[side][i]);
				t[FINAL_ROW + 2][c0 + i] = show(totals.count10[side][i]);
				t[FINAL_ROW + 3][c0 + i] = show(totals.countNeg5[side][i]);
				t[FINAL_ROW + 4][c0 + i] = show(totals.tuPoints[side][i], fp);
			}
			t[FINAL_ROW + 5][c0] = fp(totals.subtotal[side]);
			t[FINAL_ROW + 5][BONUS_COL[side]] = fp(totals.bonusTotal[side]);
			t[FINAL_ROW + 6][c0] = totals.bonusConv[side].toFixed(2);
		}
		rows.forEach((_, k) => {
			t[FIRST_TU_ROW + k][TU_COL] = String(k + 1);
			t[FIRST_TU_ROW + k][NOTES_COL] = notes.notes[k];
		});
		return t;
	});

	// Conditional formatting, as on the old sheet: blank names in yellow, tossups still to come in yellow,
	// skipped tossups in red, the leading final score in yellow and the trailing one in grey, and a red
	// box around a row that cannot be right.
	const YELLOW = '#ffff99';
	const dyn = $derived.by(() => {
		const d: string[][] = Array.from({ length: NR }, () => Array<string>(NC).fill(''));
		if (!slots || !totals) return d;
		for (const side of SIDES) {
			for (let i = 0; i < SLOTS; i++) if (!slots[side][i].playerId && (i < SLOTS - 1 || totals.tuPoints[side][i] !== null)) d[3][PLAYER_COL[side] + i] = `background:${YELLOW}`;
			const other = side === 'A' ? 'B' : 'A';
			if (totals.final[side] > totals.final[other]) d[FINAL_ROW][PLAYER_COL[side]] = `background:${YELLOW}`;
			if (totals.final[side] < totals.final[other]) d[FINAL_ROW][PLAYER_COL[side]] = 'background:#c0c0c0';
		}
		totals.tuState.forEach((st, k) => {
			const r = FIRST_TU_ROW + k;
			if (st === 'next') d[r][TU_COL] = `background:${YELLOW}`;
			if (st === 'skipped') d[r][TU_COL] = 'color:#ff0000';
			if (!totals.errorRows[k]) return;
			for (const side of SIDES)
				for (let c = PLAYER_COL[side]; c <= BONUS_COL[side]; c++) {
					const s = ['inset 0 1px 0 #ff0000', 'inset 0 -1px 0 #ff0000'];
					if (c === PLAYER_COL[side]) s.push('inset 1px 0 0 #ff0000');
					if (c === BONUS_COL[side]) s.push('inset -1px 0 0 #ff0000');
					d[r][c] = `box-shadow:${s.join(',')}`;
				}
		});
		return d;
	});
	const textAt = (r: number, c: number) => (r < NR && c < NC ? view[r][c] : '');
	const isNum = (s: string) => /^-?\d+(\.\d+)?$/.test(s);

	// ---------- Selection and editing ----------
	let sel = $state({ r: FIRST_TU_ROW, c: 1 });
	const selSpan = $derived(span(sel.r, sel.c));
	const selRole = $derived(roleOf(sel.r, sel.c));
	let edit = $state<{ r: number; c: number; text: string; replace: boolean } | null>(null);
	let picker = $state<{ side: Side; slot: number; index: number } | null>(null);
	let alertBox = $state<{ text: string; retry?: () => void } | null>(null);
	let hint = $state('');
	let gridWrap = $state<HTMLDivElement>();
	let cellInput = $state<HTMLInputElement>();
	const selByTab = new Map<number, { r: number; c: number }>();

	const barText = $derived.by(() => {
		if (edit) return edit.text;
		return formulaOf(sel.r, sel.c) ?? textAt(selSpan.r0, selSpan.c0);
	});

	function select(r: number, c: number) {
		const s = span(Math.max(0, Math.min(ALL_ROWS - 1, r)), Math.max(0, Math.min(ALL_COLS - 1, c)));
		sel = { r: s.r0, c: s.c0 };
		hint = '';
		tick().then(() => document.querySelector(`[data-cell="${s.r0}-${s.c0}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
	}
	function move(dr: number, dc: number) {
		const s = span(sel.r, sel.c);
		select(dr > 0 ? s.r1 + 1 : dr < 0 ? s.r0 - 1 : sel.r, dc > 0 ? s.c1 + 1 : dc < 0 ? s.c0 - 1 : sel.c);
	}

	/** Why the open round cannot be changed from this computer, if it can't. */
	function blockedReason(): string | null {
		if (!match || !result) return 'Open a round tab first.';
		if (store.leaseLost) return 'Another computer is scoring this room now, so this one has stopped.';
		if (status === 'forfeit') return 'A forfeit was recorded for this game, so there is nothing to score.';
		if (locked) return `Round (${match.roundNo}) was submitted. Changes are now made by the head scorekeeper.`;
		return null;
	}
	function explainLocked(role = selRole): boolean {
		if (role.kind === 'calc') hint = 'This cell is calculated automatically.';
		else if (role.kind === 'auto') hint = 'This is filled in from the schedule.';
		else if (role.kind === 'fixed') hint = '';
		else return false;
		return true;
	}

	function startEdit(replace: boolean, first = '') {
		if (explainLocked()) return;
		const why = blockedReason();
		if (why) {
			alertBox = { text: why };
			return;
		}
		if (selRole.kind === 'header') return openPicker(first);
		edit = { r: sel.r, c: sel.c, text: replace ? first : textAt(sel.r, sel.c), replace };
		tick().then(() => {
			cellInput?.focus();
			if (cellInput && !replace) cellInput.setSelectionRange(cellInput.value.length, cellInput.value.length);
		});
	}
	function cancelEdit() {
		edit = null;
		gridWrap?.focus();
	}
	/** Commit the cell being edited. False when the value was refused (the scorer is asked to retry). */
	function finishEdit(): boolean {
		if (!edit) return true;
		const e = edit;
		edit = null;
		gridWrap?.focus();
		return setCell(e.r, e.c, e.text, () => (edit = { ...e, replace: false }));
	}

	// ---------- Saving changes ----------
	// Changes run one at a time, in order, each reading the round as it stands when it runs.
	let queue: Promise<void> = Promise.resolve();
	const run = (f: () => Promise<void>) =>
		(queue = queue.then(f).catch((err) => {
			console.error(err);
			alertBox = { text: 'That change could not be saved on this computer. Try again, or tell the head scorekeeper.' };
		}));
	async function send(id: number, bodies: EventBody[]) {
		for (const b of bodies) await store.add(id, b);
	}
	async function ensureStarted(id: number, sl: Record<Side, Slot[]>) {
		if (stateOf(id).res.status === 'not_started') await store.add(id, { type: 'round_started', lineups: { A: ids(sl.A), B: ids(sl.B) } });
	}

	/** A whole tab as the scorer sees it: who heads each column, and every row's entries. */
	type Snapshot = { slots: Record<Side, Slot[]>; rows: SheetRow[] };
	type Undo = { id: number; r: number; c: number; before: string; after: string } | { id: number; r: number; c: number; snapshot: { before: Snapshot; after: Snapshot | null } };
	const snapshotOf = (st: { sl: Record<Side, Slot[]>; rows: SheetRow[] }): Snapshot => structuredClone({ slots: st.sl, rows: st.rows });
	let undoStack: Undo[] = [];
	let redoStack: Undo[] = [];

	/** Type `text` into a cell. Returns false if the value is not allowed there. */
	function setCell(r: number, c: number, text: string, retry?: () => void, record = true): boolean {
		const id = matchId;
		const role = roleOf(r, c);
		if (id === null || !rules) return false;
		const why = blockedReason();
		if (why) {
			alertBox = { text: why };
			return false;
		}
		if (role.kind === 'player' || role.kind === 'bonus') {
			const parsed = parseCell(text, role.kind, rules, isTiebreakerRow(role.n, rules));
			if (!parsed.ok) {
				alertBox = { text: parsed.message, retry };
				return false;
			}
		}
		const before = textAt(r, c);
		if (before.trim() === text.trim()) return true;
		if (record) {
			undoStack.push({ id, r, c, before, after: text });
			redoStack = [];
		}
		run(async () => {
			const st = stateOf(id);
			if (role.kind === 'moderator') {
				if (text.trim() !== st.notes.moderator) await store.add(id, moderatorNote(text));
			} else if (role.kind === 'note') {
				if (text.trim() !== st.notes.notes[role.n - 1]) await store.add(id, rowNote(role.n, text));
			} else if (role.kind === 'player' || role.kind === 'bonus') {
				const parsed = parseCell(text, role.kind, st.rules, isTiebreakerRow(role.n, st.rules));
				if (!parsed.ok) return;
				const row = structuredClone(st.rows[role.n - 1]);
				if (role.kind === 'player') row[role.side].players[role.slot] = parsed.value;
				else row[role.side].bonus = parsed.value;
				const changes = rowChanges(st.res, role.n, row, st.sl, st.rules);
				if (changes === null) {
					alertBox = { text: `The head scorekeeper corrected tossup ${role.n}, so only they can change it now.` };
					return;
				}
				if (!changes.length) return;
				await ensureStarted(id, st.sl);
				await send(id, changes);
			}
		});
		return true;
	}

	/** Put a different player (or nobody) at the top of a column. That column's entries go with the new name. */
	function setSlot(side: Side, slot: number, playerId: string | null, record = true) {
		const id = matchId;
		if (id === null || !slots) return;
		const why = blockedReason();
		if (why) {
			alertBox = { text: why };
			return;
		}
		if (slots[side][slot].playerId === playerId) return;
		if (!playerId && rows.some((r) => r[side].players[slot] !== null)) {
			alertBox = { text: 'This column has scores in it. Clear them first, or choose the player who actually answered.' };
			return;
		}
		const entry: Undo = { id, r: 3, c: PLAYER_COL[side] + slot, snapshot: { before: snapshotOf(stateOf(id)), after: null } };
		if (record) {
			undoStack.push(entry);
			redoStack = [];
		}
		run(async () => {
			const st = stateOf(id);
			const next = { A: [...st.sl.A], B: [...st.sl.B] };
			const roster = st.m.teams[side].roster;
			next[side][slot] = playerId ? { playerId, name: roster.find((p) => p.id === playerId)?.name ?? '' } : { playerId: null, name: '' };
			if (st.res.status === 'not_started') await store.add(id, { type: 'round_started', lineups: { A: ids(next.A), B: ids(next.B) } });
			else {
				await store.add(id, { type: 'lineup_set', side, players: ids(next[side]) });
				for (let n = 1; n <= SHEET_TOSSUPS; n++) {
					if (st.rows[n - 1][side].players.every((v) => v === null)) continue;
					const changes = rowChanges(stateOf(id).res, n, st.rows[n - 1], next, st.rules);
					if (changes?.length) await send(id, changes);
				}
			}
			if ('snapshot' in entry) entry.snapshot.after = snapshotOf(stateOf(id));
		});
	}

	/** Put a tab back the way a snapshot shows it (undoing a change of player names). Entries follow their players. */
	function restore(id: number, snap: Snapshot) {
		run(async () => {
			const st = stateOf(id);
			for (const side of SIDES) {
				if (JSON.stringify(ids(snap.slots[side])) === JSON.stringify(ids(st.sl[side]))) continue;
				if (stateOf(id).res.status === 'not_started') await store.add(id, { type: 'round_started', lineups: { A: ids(snap.slots.A), B: ids(snap.slots.B) } });
				else await store.add(id, { type: 'lineup_set', side, players: ids(snap.slots[side]) });
			}
			for (let n = 1; n <= SHEET_TOSSUPS; n++) {
				const changes = rowChanges(stateOf(id).res, n, snap.rows[n - 1], snap.slots, st.rules);
				if (changes?.length) await send(id, changes);
			}
		});
	}

	function undo(redo = false) {
		const from = redo ? redoStack : undoStack;
		const u = from.pop();
		if (!u) return;
		(redo ? undoStack : redoStack).push(u);
		if (u.id !== matchId) openTab(u.id);
		select(u.r, u.c);
		const why = blockedReason();
		if (why) {
			alertBox = { text: why };
			return;
		}
		if ('snapshot' in u) {
			const snap = redo ? u.snapshot.after : u.snapshot.before;
			if (snap) restore(u.id, snap);
		} else setCell(u.r, u.c, redo ? u.after : u.before, undefined, false);
	}

	// ---------- Player name picker (the drop-down on row 4) ----------
	const pickOptions = $derived.by(() => {
		if (!picker || !match || !slots) return [];
		const taken = new Set(slots[picker.side].filter((_, i) => i !== picker!.slot).map((s) => s.playerId));
		return [...match.teams[picker.side].roster.filter((p) => !taken.has(p.id)).map((p) => ({ id: p.id as string | null, name: p.name })), { id: null, name: '(no player)' }];
	});
	function openPicker(first = '') {
		if (selRole.kind !== 'header' || !match || !slots) return;
		const { side, slot } = selRole;
		const current = slots[side][slot].playerId;
		picker = { side, slot, index: 0 };
		tick().then(() => {
			if (!picker) return;
			const f = first.toLowerCase();
			const i = pickOptions.findIndex((o) => (f ? o.name.toLowerCase().startsWith(f) : o.id === current));
			picker.index = Math.max(0, i);
		});
	}
	function choosePick(i: number) {
		if (!picker) return;
		const o = pickOptions[i];
		const { side, slot } = picker;
		picker = null;
		if (o) setSlot(side, slot, o.id);
	}

	// ---------- Keyboard ----------
	function onKey(e: KeyboardEvent) {
		if (alertBox) {
			if (e.key === 'Enter' || e.key === 'Escape') {
				e.preventDefault();
				closeAlert(e.key === 'Enter');
			}
			return;
		}
		if (submitOpen || importOpen || practiceOpen || !ready || !match) return;
		const t = e.target as HTMLElement;
		if (t.closest?.('input, select, textarea, dialog')) return;
		if (picker) {
			e.preventDefault();
			if (e.key === 'ArrowDown') picker.index = Math.min(pickOptions.length - 1, picker.index + 1);
			else if (e.key === 'ArrowUp') picker.index = Math.max(0, picker.index - 1);
			else if (e.key === 'Enter' || e.key === 'Tab') choosePick(picker.index);
			else if (e.key === 'Escape') picker = null;
			else if (e.key.length === 1) {
				const i = pickOptions.findIndex((o) => o.name.toLowerCase().startsWith(e.key.toLowerCase()));
				if (i >= 0) picker.index = i;
			}
			return;
		}
		const mod = e.ctrlKey || e.metaKey;
		const k = e.key.toLowerCase();
		if (mod && (k === 'z' || k === 'y')) {
			e.preventDefault();
			undo(k === 'y' || (k === 'z' && e.shiftKey));
			return;
		}
		if (mod && k === 'home') {
			e.preventDefault();
			return select(0, 0);
		}
		if (mod) return;
		if (e.altKey) {
			if (e.key === 'ArrowDown' && selRole.kind === 'header') {
				e.preventDefault();
				startEdit(false);
			}
			return;
		}
		const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
		if (moves[e.key]) {
			e.preventDefault();
			return move(...moves[e.key]);
		}
		switch (e.key) {
			case 'Tab':
				e.preventDefault();
				return move(0, e.shiftKey ? -1 : 1);
			case 'Enter':
				e.preventDefault();
				return move(e.shiftKey ? -1 : 1, 0);
			case 'Home':
				e.preventDefault();
				return select(sel.r, 0);
			case 'PageDown':
			case 'PageUp':
				e.preventDefault();
				return select(sel.r + (e.key === 'PageDown' ? 20 : -20), sel.c);
			case 'F2':
				e.preventDefault();
				return startEdit(false);
			case 'Delete':
			case 'Backspace':
				e.preventDefault();
				if (explainLocked()) return;
				if (selRole.kind === 'header') return setSlot(selRole.side, selRole.slot, null);
				setCell(sel.r, sel.c, '');
				return;
		}
		if (e.key.length === 1) {
			e.preventDefault();
			startEdit(true, e.key);
		}
	}
	function onEditKey(e: KeyboardEvent) {
		e.stopPropagation();
		const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
		if (e.key === 'Escape') {
			e.preventDefault();
			cancelEdit();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (finishEdit()) move(e.shiftKey ? -1 : 1, 0);
		} else if (e.key === 'Tab') {
			e.preventDefault();
			if (finishEdit()) move(0, e.shiftKey ? -1 : 1);
		} else if (edit?.replace && arrows[e.key]) {
			e.preventDefault();
			if (finishEdit()) move(...arrows[e.key]);
		}
	}
	function onCellDown(e: MouseEvent, r: number, c: number) {
		if (e.button !== 0) return;
		if (edit && (edit.r !== r || edit.c !== c) && !finishEdit()) return;
		picker = null;
		select(r, c);
		gridWrap?.focus();
	}
	function closeAlert(ok: boolean) {
		const retry = alertBox?.retry;
		alertBox = null;
		if (ok && retry) retry();
		tick().then(() => (edit ? cellInput?.focus() : gridWrap?.focus()));
	}

	// ---------- Tabs ----------
	function openTab(id: number) {
		if (edit && !finishEdit()) return;
		if (matchId !== null) selByTab.set(matchId, { ...sel });
		picker = null;
		hint = '';
		matchId = id;
		sel = selByTab.get(id) ?? { r: FIRST_TU_ROW, c: 1 };
		gridWrap?.scrollTo({ top: 0, left: 0 });
	}
	const tabGroups = $derived.by(() => {
		const groups: { session: string; matches: ScorerMatch[] }[] = [];
		for (const m of store.state?.matches ?? []) {
			const g = groups.find((x) => x.session === m.sessionName);
			if (g) g.matches.push(m);
			else groups.push({ session: m.sessionName, matches: [m] });
		}
		return groups;
	});
	function chooseDefault() {
		const ms = store.state?.matches ?? [];
		const open = ms.find((m) => !['submitted', 'approved', 'forfeit'].includes(statusOf(m)));
		matchId = (open ?? ms[ms.length - 1])?.id ?? null;
	}

	// ---------- Submit ----------
	let submitOpen = $state(false);
	let endReason = $state('');
	let confirmed = $state(false);
	let submitTied = $state(false);
	const errorRowList = $derived(totals ? totals.errorRows.flatMap((e, i) => (e ? [i + 1] : [])) : []);
	function openSubmit() {
		if (edit && !finishEdit()) return;
		const why = blockedReason();
		if (why) {
			alertBox = { text: why };
			return;
		}
		if (status === 'not_started') {
			alertBox = { text: 'Nothing has been scored on this tab yet.' };
			return;
		}
		endReason = result?.endReason ?? (result && result.lastRegularTossup >= rules!.round.maxTossups ? 'All tossups read' : (rules!.round.endReasons[0] ?? 'Time called'));
		confirmed = false;
		submitTied = false;
		submitOpen = true;
	}
	function submitRound() {
		const id = matchId;
		if (id === null || !confirmed) return;
		submitOpen = false;
		const reason = endReason;
		run(async () => {
			const st = stateOf(id);
			if (st.res.status === 'in_progress') {
				const note = st.res.decidedByTiebreaker ? 'Decided by tiebreaker' : '';
				await store.add(id, { type: 'round_ended', reason, ...(note ? { note } : {}) });
			}
			const after = stateOf(id).res;
			if (after.status !== 'ended') return;
			await store.add(id, { type: 'submitted', scoreA: after.teams.A.roundScore, scoreB: after.teams.B.roundScore });
		});
	}

	// ---------- Import ----------
	let importOpen = $state(false);
	let practiceOpen = $state(false);
	async function practiceStarted(id: number) {
		await store.refresh();
		practiceOpen = false;
		openTab(id);
	}
	function openImport() {
		if (edit && !finishEdit()) return;
		const why = blockedReason();
		if (why) {
			alertBox = { text: why };
			return;
		}
		importOpen = true;
	}
	function applyImport(plan: ImportPlan) {
		const id = matchId;
		importOpen = false;
		if (id === null) return;
		run(async () => {
			const st = stateOf(id);
			if (st.res.status === 'not_started') await store.add(id, { type: 'round_started', lineups: { A: ids(plan.slots.A), B: ids(plan.slots.B) } });
			else
				for (const side of SIDES)
					if (JSON.stringify(ids(plan.slots[side])) !== JSON.stringify(ids(st.sl[side]))) await store.add(id, { type: 'lineup_set', side, players: ids(plan.slots[side]) });
			if (plan.moderator && plan.moderator !== st.notes.moderator) await store.add(id, moderatorNote(plan.moderator));
			for (let n = 1; n <= SHEET_TOSSUPS; n++) {
				const changes = rowChanges(stateOf(id).res, n, plan.rows[n - 1], plan.slots, st.rules);
				if (changes?.length) await send(id, changes);
				const note = plan.notes[n - 1]?.trim() ?? '';
				if (note && note !== st.notes.notes[n - 1]) await store.add(id, rowNote(n, note));
			}
			hint = `Imported ${plan.label}. Check the scores, then submit the round.`;
		});
	}

	// ---------- Connection status ----------
	const pendingCount = $derived(store.pending.length);
	const statusText = $derived(
		store.leaseLost
			? 'Another computer is scoring this room'
			: pendingCount
				? store.online
					? `Saving ${pendingCount}…`
					: `Offline — ${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting (saved on this computer)`
				: store.online
					? 'All changes saved'
					: 'Offline — nothing waiting'
	);
	const statusClass = $derived(store.leaseLost ? 'bad' : pendingCount && !store.online ? 'warn' : pendingCount ? 'info' : store.online ? 'ok' : 'warn');
	const roundState = $derived(
		!match
			? ''
			: status === 'forfeit'
				? 'Forfeit recorded — nothing to score'
				: status === 'approved'
					? 'Approved by the head scorekeeper'
					: status === 'submitted'
						? 'Submitted — waiting for approval'
						: status === 'ended'
							? 'Round ended — ready to submit'
							: ''
	);

	// ---------- Zoom ----------
	let zoom = $state(100);
	function setZoom(z: number) {
		zoom = Math.max(50, Math.min(200, z));
		try {
			localStorage.setItem('sb-sheet-zoom', String(zoom));
		} catch {
			/* private window */
		}
	}

	let menuOpen = $state(false);
	function switchToScreen() {
		rememberScorerMode('screen');
		goto('/scorer');
	}
	async function signOut() {
		if (store.pending.length && !confirm(`${store.pending.length} change(s) have not reached the server yet. Download the results file first? Press Cancel to go back.`)) return;
		const f = document.createElement('form');
		f.method = 'POST';
		f.action = '/logout';
		document.body.appendChild(f);
		f.submit();
	}
	function beforeUnload(e: BeforeUnloadEvent) {
		if (store.pending.length) {
			e.preventDefault();
			e.returnValue = '';
		}
	}

	onMount(async () => {
		try {
			const z = Number(localStorage.getItem('sb-sheet-zoom'));
			if (z >= 50 && z <= 200) zoom = z;
		} catch {
			/* private window */
		}
		rememberScorerMode('sheet');
		await store.init();
		if (store.loadError === 'signed_out' && !store.state) {
			goto('/room');
			return;
		}
		chooseDefault();
		ready = true;
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js', { type: dev ? 'module' : 'classic' }).catch(() => {});
		tick().then(() => gridWrap?.focus());
	});
	onDestroy(() => store.destroy());

	const sticky = (r: number) => (r < FROZEN_ROWS ? `position:sticky;top:${frozenTop(r)}px;z-index:3;` : '');
	const workbookTitle = $derived(match ? `Scholar's Bowl ${match.sessionName} Scoresheet` : 'Scoresheet');
</script>

<svelte:window onkeydown={onKey} onbeforeunload={beforeUnload} />
<svelte:head><title>{workbookTitle}{store.state ? ` – ${store.state.room.name}` : ''}</title></svelte:head>

<div class="app">
	<header class="ribbon">
		<div class="book">
			<strong>{workbookTitle}</strong>
			{#if store.state}<span>{store.state.room.name}</span>{/if}
			{#if store.state?.event.isTest}<span class="practice">Practice event</span>{/if}
			{#if store.state?.room.practice}<span class="practice">Practice room · scores never count</span>{/if}
		</div>
		<div class="tools">
			{#if store.state?.practice && store.state.matches.length}<button type="button" class="rb" onclick={() => (practiceOpen = true)}>New practice game</button>{/if}
			<button type="button" class="rb" onclick={openImport} disabled={!match}>Import scores</button>
			<button type="button" class="rb primary" onclick={openSubmit} disabled={!match || locked}>Submit round</button>
			<span class="conn {statusClass}" role="status" aria-live="polite">{statusText}</span>
			{#if pendingCount}<button type="button" class="rb" onclick={() => store.downloadRescueFile()}>Download unsaved results</button>{/if}
			<div class="menu">
				<button type="button" class="rb" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>Menu ▾</button>
				{#if menuOpen}
					<div class="menu-pop" role="menu">
						<button type="button" role="menuitem" onclick={switchToScreen}>Switch to the new scoring screen</button>
						<button type="button" role="menuitem" onclick={() => { store.downloadRescueFile(); menuOpen = false; }}>Download results file (for a flash drive)</button>
						{#if store.state}<a role="menuitem" href="/projector/{store.state.room.projectorToken}" target="_blank" rel="noopener">Open projector view</a>{/if}
						<a role="menuitem" href="/guide" target="_blank" rel="noopener">Day-of Guide</a>
						<button type="button" role="menuitem" onclick={signOut}>Sign out</button>
					</div>
				{/if}
			</div>
		</div>
	</header>

	{#if store.rejected.length}
		<div class="strip error">
			{store.rejected.length} change(s) were not accepted by the server ({[...new Set(store.rejected.map((r) => rejectReason(r.rejected!)))].join('; ')}). Tell the head scorekeeper; they are kept in the results file.
		</div>
	{/if}
	{#if store.fromCache}<div class="strip info">Showing the last saved copy of this room's games because the server can't be reached.</div>{/if}
	{#if roundState || (match && !match.counts)}
		<div class="strip {status === 'approved' ? 'ok' : 'info'}">
			{#if match && !match.counts}<strong>Non-counter game</strong> — this round does not count toward standings.{/if}
			{roundState}
		</div>
	{/if}

	<div class="fbar">
		<div class="namebox" aria-label="Selected cell">{address(selSpan.r0, selSpan.c0)}</div>
		<div class="fx" aria-hidden="true"><span>✕</span><span>✓</span><em>fx</em></div>
		<input
			class="formula"
			aria-label="Cell contents"
			value={barText}
			readonly={!edit}
			onfocus={() => !edit && startEdit(false)}
			oninput={(e) => edit && (edit.text = (e.currentTarget as HTMLInputElement).value)}
			onkeydown={onEditKey}
		/>
	</div>

	{#if !ready}
		<p class="center">Loading…</p>
	{:else if store.state?.practice && store.state.matches.length === 0}
		<div class="empty">
			<h2>Start a practice game in {store.state.room.name}</h2>
			<PracticeStart options={store.state.practice} onstarted={practiceStarted} />
		</div>
	{:else if !store.state || store.state.matches.length === 0}
		<div class="empty">
			<h2>No games scheduled for this room yet</h2>
			<p>Round tabs appear here once the schedule is published. <button type="button" class="rb" onclick={() => store.refresh()}>Check again</button></p>
		</div>
	{:else}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="grid-wrap" bind:this={gridWrap} tabindex="0" role="grid" aria-label="Round ({match?.roundNo}) scoresheet">
			<table class="xl" style="width:{GRID_WIDTH}px;zoom:{zoom / 100}">
				<colgroup>
					<col style="width:{ROW_HEADER_WIDTH}px" />
					{#each Array(ALL_COLS) as _, c (c)}<col style="width:{colWidth(c)}px" />{/each}
				</colgroup>
				<thead>
					<tr style="height:{HEADER_HEIGHT}px">
						<th class="corner"></th>
						{#each Array(ALL_COLS) as _, c (c)}
							<th class="ch" class:on={c >= selSpan.c0 && c <= selSpan.c1} class:after-hidden={c === NC}>{colName(c)}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each LAYOUT as cells, r (r)}
						<tr style="height:{rowHeight(r)}px">
							<th class="rh" class:on={r >= selSpan.r0 && r <= selSpan.r1} style="{sticky(r)}{r < FROZEN_ROWS ? 'z-index:5' : ''}">{r + 1}</th>
							{#each cells as cell (cell.c)}
								{@const text = textAt(cell.r, cell.c)}
								{@const active = cell.r === selSpan.r0 && cell.c === selSpan.c0}
								<td
									data-cell="{cell.r}-{cell.c}"
									rowspan={cell.rowspan}
									colspan={cell.colspan}
									class:active
									class:rot={cell.rotated}
									class:num={cell.align === 'g' && isNum(text)}
									style="{cell.style};{cell.r < NR && cell.c < NC ? dyn[cell.r][cell.c] : ''};{sticky(cell.r)}{active && cell.r < FROZEN_ROWS ? 'z-index:4;' : ''}"
									onmousedown={(e) => onCellDown(e, cell.r, cell.c)}
									ondblclick={() => startEdit(false)}
								>
									{#if edit && edit.r === cell.r && edit.c === cell.c}
										<input class="cell-input" bind:this={cellInput} bind:value={edit.text} onkeydown={onEditKey} aria-label="Edit {address(cell.r, cell.c)}" />
									{:else if cell.rotated}
										<span class="vt">{text}</span>
									{:else}
										{text}
									{/if}
									{#if active && selRole.kind === 'header' && !locked}
										<button type="button" class="dd" aria-label="Choose player" tabindex="-1" onmousedown={(e) => { e.stopPropagation(); e.preventDefault(); openPicker(); }}>▾</button>
									{/if}
									{#if active && picker}
										<div class="picker" role="listbox" aria-label="Players">
											{#each pickOptions as o, i (o.id ?? 'none')}
												<div role="option" tabindex="-1" aria-selected={i === picker.index} class:on={i === picker.index} onmousedown={(e) => { e.stopPropagation(); e.preventDefault(); choosePick(i); }}>{o.name}</div>
											{/each}
										</div>
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
			{#if status === 'forfeit' && match}
				<div class="forfeit-note">Forfeit recorded — nothing to score.{#if result?.forfeit} {match.teams[result.forfeit.side].name} forfeited this game.{/if}</div>
			{/if}
		</div>

		<footer class="tabs-bar">
			<div class="tabs" role="tablist">
				{#each tabGroups as g (g.session)}
					{#if tabGroups.length > 1}<span class="tab-group">{g.session}</span>{/if}
					{#each g.matches as m (m.id)}
						{@const st = statusOf(m)}
						<button
							type="button"
							role="tab"
							aria-selected={m.id === matchId}
							class="tab"
							class:on={m.id === matchId}
							class:done={st === 'approved' || st === 'forfeit'}
							class:sent={st === 'submitted'}
							title="{m.sessionName} Round {m.roundNo}: {m.teams.A.name} vs {m.teams.B.name}"
							onclick={() => openTab(m.id)}>Round ({m.roundNo})</button
						>
					{/each}
				{/each}
			</div>
			<div class="statusbar">
				<span class="hint" aria-live="polite">{hint}</span>
				<button type="button" class="zb" aria-label="Zoom out" onclick={() => setZoom(zoom - 10)}>−</button>
				<input type="range" min="50" max="200" step="10" value={zoom} oninput={(e) => setZoom(Number((e.currentTarget as HTMLInputElement).value))} aria-label="Zoom" />
				<button type="button" class="zb" aria-label="Zoom in" onclick={() => setZoom(zoom + 10)}>+</button>
				<span class="zv">{zoom}%</span>
			</div>
		</footer>
	{/if}
</div>

{#if alertBox}
	<div class="overlay" role="alertdialog" aria-modal="true" aria-labelledby="alert-text">
		<div class="dialog small">
			<div class="dlg-title">Scoresheet</div>
			<div class="dlg-body"><span class="warn-icon" aria-hidden="true">!</span><p id="alert-text">{alertBox.text}</p></div>
			<div class="dlg-buttons">
				{#if alertBox.retry}
					<button type="button" class="db primary" onclick={() => closeAlert(true)}>Retry</button>
					<button type="button" class="db" onclick={() => closeAlert(false)}>Cancel</button>
				{:else}
					<button type="button" class="db primary" onclick={() => closeAlert(false)}>OK</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

{#if practiceOpen && store.state?.practice}
	<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="practice-title">
		<div class="dialog">
			<div class="dlg-title" id="practice-title">New practice game</div>
			<div class="dlg-body col">
				<PracticeStart options={store.state.practice} onstarted={practiceStarted} oncancel={() => (practiceOpen = false)} />
			</div>
		</div>
	</div>
{/if}

{#if submitOpen && match && result}
	{@const tied = result.tied && !result.decidedByTiebreaker}
	<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="submit-title">
		<div class="dialog">
			<div class="dlg-title" id="submit-title">Submit Round ({match.roundNo})</div>
			<div class="dlg-body col">
				<p class="final">
					{match.teams.A.name} <strong>{fp(result.teams.A.roundScore)}</strong>, {match.teams.B.name} <strong>{fp(result.teams.B.roundScore)}</strong>
					{#if result.winner}<br /><span class="muted">Winner: {match.teams[result.winner].name}{result.decidedByTiebreaker ? ' (tiebreaker)' : ''}</span>{/if}
				</p>
				{#if tied}
					<p class="warn">The score is tied. Read a tiebreaker tossup and type the correct answer on row 26 (the first correct answer wins), then submit.</p>
					<label class="check"><input type="checkbox" bind:checked={submitTied} /> Submit it tied anyway (the head scorekeeper will be alerted)</label>
				{/if}
				{#if errorRowList.length}
					<p class="warn">Row{errorRowList.length === 1 ? '' : 's'} {errorRowList.join(', ')} {errorRowList.length === 1 ? 'is' : 'are'} outlined in red. Check {errorRowList.length === 1 ? 'it' : 'them'} before submitting.</p>
				{/if}
				<label>
					Why did the round end?
					<select bind:value={endReason}>{#each rules?.round.endReasons ?? [] as r (r)}<option value={r}>{r}</option>{/each}</select>
				</label>
				<label class="check"><input type="checkbox" bind:checked={confirmed} /> I confirmed the final score with the moderator</label>
				<p class="muted">After you submit, this round is locked. Changes after that are made by the head scorekeeper.</p>
			</div>
			<div class="dlg-buttons">
				<button type="button" class="db primary" disabled={!confirmed || (tied && !submitTied) || store.leaseLost} onclick={submitRound}>Submit</button>
				<button type="button" class="db" onclick={() => (submitOpen = false)}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

{#if importOpen && match && slots && rules}
	<SheetImport {match} {rules} hasScores={status !== 'not_started'} onapply={applyImport} oncancel={() => (importOpen = false)} />
{/if}

{#if store.leaseLost}
	<div class="overlay" role="alertdialog" aria-labelledby="lease-title">
		<div class="dialog">
			<div class="dlg-title" id="lease-title">This room is now being scored on another computer</div>
			<div class="dlg-body col">
				<p>Someone signed in to {store.state?.room.name} on a different computer, so this one has stopped scoring. Nothing this computer saved to the server is lost.</p>
				{#if pendingCount}<p><strong>{pendingCount} change(s) from this computer never reached the server.</strong> Download them and give the file to the head scorekeeper.</p>{/if}
			</div>
			<div class="dlg-buttons">
				<button type="button" class="db primary" onclick={() => store.downloadRescueFile()}>Download this computer's results</button>
				<button type="button" class="db" onclick={signOut}>Sign out</button>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(body) {
		background: #fff;
		overflow: hidden;
	}
	.app {
		height: 100vh;
		display: flex;
		flex-direction: column;
		font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
		font-size: 13px;
		color: #222;
	}
	.ribbon {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		padding: 6px 10px;
		background: #f3f3f3;
		border-bottom: 1px solid #d4d4d4;
	}
	.book {
		display: flex;
		gap: 10px;
		align-items: baseline;
	}
	.book strong {
		font-weight: 600;
		font-size: 14px;
	}
	.book span {
		color: #555;
	}
	.book .practice {
		background: #fff4ce;
		border: 1px solid #e0c060;
		padding: 0 6px;
		border-radius: 3px;
		color: #6b5000;
	}
	.tools {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
	}
	.rb {
		font: inherit;
		padding: 4px 10px;
		border: 1px solid #c8c8c8;
		border-radius: 3px;
		background: #fff;
		cursor: pointer;
		color: #222;
	}
	.rb:hover:not(:disabled) {
		background: #e8e8e8;
	}
	.rb.primary {
		border-color: #1e6b40;
		background: #217346;
		color: #fff;
	}
	.rb.primary:hover:not(:disabled) {
		background: #1a5c38;
	}
	.rb:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.conn {
		padding: 2px 8px;
		border-radius: 10px;
		font-size: 12px;
	}
	.conn.ok {
		color: #1a5c38;
	}
	.conn.info {
		color: #24408f;
	}
	.conn.warn {
		background: #fff4ce;
		color: #6b5000;
	}
	.conn.bad {
		background: #fde7e9;
		color: #a4262c;
	}
	.menu {
		position: relative;
	}
	.menu-pop {
		position: absolute;
		right: 0;
		top: calc(100% + 2px);
		z-index: 30;
		background: #fff;
		border: 1px solid #c8c8c8;
		box-shadow: 0 4px 12px rgb(0 0 0 / 15%);
		min-width: 280px;
		display: flex;
		flex-direction: column;
	}
	.menu-pop > * {
		text-align: left;
		padding: 8px 12px;
		border: 0;
		background: none;
		font: inherit;
		color: #222;
		text-decoration: none;
		cursor: pointer;
	}
	.menu-pop > *:hover {
		background: #e8e8e8;
	}
	.strip {
		padding: 4px 10px;
		border-bottom: 1px solid #d4d4d4;
	}
	.strip.info {
		background: #eef3fb;
	}
	.strip.ok {
		background: #e6f4ea;
	}
	.strip.error {
		background: #fde7e9;
		color: #a4262c;
	}
	.fbar {
		display: flex;
		align-items: stretch;
		gap: 0;
		padding: 4px 6px;
		border-bottom: 1px solid #d4d4d4;
		background: #fff;
	}
	.namebox {
		width: 90px;
		border: 1px solid #c8c8c8;
		padding: 2px 6px;
		font-size: 13px;
	}
	.fx {
		display: flex;
		gap: 10px;
		align-items: center;
		padding: 0 10px;
		color: #999;
		font-size: 12px;
	}
	.fx em {
		font-family: 'Times New Roman', serif;
		font-size: 14px;
		color: #555;
	}
	.formula {
		flex: 1;
		border: 1px solid #c8c8c8;
		padding: 2px 6px;
		font: 13px Arial, sans-serif;
		outline: none;
	}
	.grid-wrap {
		flex: 1;
		overflow: auto;
		position: relative;
		outline: none;
		background: #fff;
	}
	.xl {
		border-collapse: collapse;
		table-layout: fixed;
		font: 10pt Arial, Helvetica, sans-serif;
		color: #000;
		cursor: cell;
		user-select: none;
	}
	.xl th {
		background: #f3f3f3;
		color: #444;
		font: 11px 'Segoe UI', system-ui, sans-serif;
		border: 1px solid #d4d4d4;
		text-align: center;
		padding: 0;
	}
	.xl thead th {
		position: sticky;
		top: 0;
		z-index: 5;
	}
	.xl .corner {
		left: 0;
		z-index: 6;
	}
	.xl .rh {
		position: sticky;
		left: 0;
		z-index: 4;
	}
	.xl th.on {
		background: #d2d2d2;
		color: #217346;
		font-weight: 600;
	}
	.xl thead th.on {
		box-shadow: inset 0 -2px 0 #217346;
	}
	.xl .rh.on {
		box-shadow: inset -2px 0 0 #217346;
	}
	.xl .ch.after-hidden {
		border-left: 3px double #a0a0a0;
	}
	.xl td {
		position: relative;
		padding: 0 2px;
		overflow: hidden;
		white-space: nowrap;
		background: #fff;
		line-height: 1.15;
	}
	.xl td.num {
		text-align: right;
	}
	.xl td.active {
		outline: 2px solid #217346;
		outline-offset: -2px;
		z-index: 2;
		overflow: visible;
	}
	.xl td.active::after {
		content: '';
		position: absolute;
		right: -3px;
		bottom: -3px;
		width: 5px;
		height: 5px;
		background: #217346;
		border: 1px solid #fff;
	}
	.xl td.rot {
		text-align: center;
	}
	.vt {
		display: inline-block;
		writing-mode: vertical-rl;
		transform: rotate(180deg);
		max-height: 100%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: clip;
	}
	.cell-input {
		position: absolute;
		inset: 0;
		min-width: 100%;
		width: max(100%, 120px);
		border: 0;
		outline: 2px solid #217346;
		outline-offset: -2px;
		padding: 0 3px;
		font: inherit;
		background: #fff;
		z-index: 3;
	}
	.dd {
		position: absolute;
		right: 0;
		bottom: 0;
		width: 16px;
		height: 17px;
		padding: 0;
		border: 1px solid #c8c8c8;
		background: #f3f3f3;
		font-size: 10px;
		line-height: 1;
		cursor: pointer;
		z-index: 4;
	}
	.picker {
		position: absolute;
		left: 0;
		top: 100%;
		z-index: 10;
		min-width: 190px;
		max-height: 220px;
		overflow: auto;
		background: #fff;
		border: 1px solid #888;
		box-shadow: 0 3px 8px rgb(0 0 0 / 20%);
		font: 10pt Arial, sans-serif;
		text-align: left;
	}
	.picker > div {
		padding: 2px 6px;
		cursor: default;
		white-space: nowrap;
	}
	.picker > div.on {
		background: #0078d4;
		color: #fff;
	}
	.forfeit-note {
		position: absolute;
		top: 180px;
		left: 120px;
		padding: 12px 16px;
		background: #fff4ce;
		border: 1px solid #e0c060;
		font-size: 15px;
		z-index: 8;
	}
	.tabs-bar {
		display: flex;
		justify-content: space-between;
		align-items: stretch;
		border-top: 1px solid #d4d4d4;
		background: #f3f3f3;
		min-height: 30px;
	}
	.tabs {
		display: flex;
		align-items: stretch;
		overflow-x: auto;
		padding-left: 8px;
	}
	.tab-group {
		align-self: center;
		padding: 0 8px 0 12px;
		color: #666;
		font-size: 12px;
	}
	.tab {
		font: inherit;
		padding: 4px 14px;
		border: 0;
		border-right: 1px solid #d4d4d4;
		background: transparent;
		cursor: pointer;
		white-space: nowrap;
		color: #333;
	}
	.tab:hover {
		background: #e8e8e8;
	}
	.tab.on {
		background: #fff;
		color: #217346;
		font-weight: 600;
		box-shadow: inset 0 -3px 0 #217346;
	}
	.tab.sent {
		box-shadow: inset 0 -3px 0 #2b6cb0;
	}
	.tab.done {
		box-shadow: inset 0 -3px 0 #2e9e5b;
	}
	.tab.on.sent,
	.tab.on.done {
		box-shadow: inset 0 -3px 0 #217346, inset 0 3px 0 #2b6cb0;
	}
	.statusbar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		font-size: 12px;
		color: #444;
	}
	.hint {
		margin-right: 12px;
		color: #555;
	}
	.zb {
		border: 0;
		background: none;
		font-size: 16px;
		cursor: pointer;
		color: #444;
	}
	.statusbar input[type='range'] {
		width: 100px;
	}
	.zv {
		width: 40px;
	}
	.empty,
	.center {
		padding: 30px;
		text-align: center;
	}
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
		max-width: 520px;
		font-family: 'Segoe UI', system-ui, sans-serif;
		font-size: 14px;
	}
	.dialog.small {
		max-width: 420px;
	}
	.dlg-title {
		padding: 8px 12px;
		font-weight: 600;
		border-bottom: 1px solid #e0e0e0;
		background: #fafafa;
	}
	.dlg-body {
		padding: 14px 16px;
		display: flex;
		gap: 12px;
		align-items: flex-start;
	}
	.dlg-body.col {
		flex-direction: column;
		gap: 10px;
	}
	.dlg-body p {
		margin: 0;
	}
	.dlg-body label {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.dlg-body label.check {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}
	.dlg-body select {
		font: inherit;
		padding: 3px;
	}
	.warn-icon {
		flex: none;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: #f2c811;
		color: #000;
		font-weight: 800;
		display: grid;
		place-items: center;
		font-size: 18px;
	}
	.final {
		font-size: 16px;
	}
	.warn {
		background: #fff4ce;
		border-left: 4px solid #e0b000;
		padding: 6px 10px !important;
	}
	.muted {
		color: #666;
		font-size: 13px;
	}
	.dlg-buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 12px;
		border-top: 1px solid #e0e0e0;
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
