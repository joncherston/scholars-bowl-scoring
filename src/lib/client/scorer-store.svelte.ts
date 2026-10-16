import type { EventBody, ScoreEvent } from '$lib/engine';
import type { RoomState, ScorerMatch } from '$lib/scorer-types';
import { openDB, type IDBPDatabase } from 'idb';

/** An action recorded on this device. Saved to IndexedDB before anything else happens. */
export interface LocalEvent {
	id: string;
	matchId: number;
	roomId: number;
	eventId: number;
	deviceId: string;
	deviceSeq: number;
	body: EventBody;
	clientTs: string;
	synced: 0 | 1;
	serverSeq: number | null;
	rejected: string | null;
}

export type ScorerState = RoomState & { deviceId: string; leaseOk: boolean };

const DB_NAME = 'sb-scorer';

async function openStore(): Promise<IDBPDatabase> {
	return openDB(DB_NAME, 1, {
		upgrade(db) {
			const ev = db.createObjectStore('events', { keyPath: 'id' });
			ev.createIndex('roomId', 'roomId');
			db.createObjectStore('meta');
		}
	});
}

const REJECT_TEXT: Record<string, string> = {
	device_replaced: 'another computer took over this room',
	round_submitted: 'the round was already submitted',
	invalid_event: 'the server could not read it',
	unknown_target: 'it refers to an action the server does not have',
	wrong_room: 'the game belongs to another room',
	unknown_match: 'the game no longer exists'
};
export const rejectReason = (code: string) => REJECT_TEXT[code] ?? code;

/**
 * Offline-first store for one room's scorer. Every action goes to IndexedDB
 * first, then a sync loop sends it to the server (safe to retry). The
 * round on screen is computed from server events plus local unsent ones.
 */
export class ScorerStore {
	state = $state<ScorerState | null>(null);
	local = $state<LocalEvent[]>([]);
	online = $state(typeof navigator === 'undefined' ? true : navigator.onLine);
	syncing = $state(false);
	lastSyncAt = $state<number | null>(null);
	loadError = $state<string | null>(null);
	fromCache = $state(false);
	storageOk = $state(true);

	pending = $derived(this.local.filter((e) => !e.synced && !e.rejected));
	rejected = $derived(this.local.filter((e) => !!e.rejected));
	leaseLost = $derived(this.state ? !this.state.leaseOk : false);

	private db: IDBPDatabase | null = null;
	private timers: ReturnType<typeof setInterval>[] = [];
	private syncQueued = false;
	private serverVersion: string | null = null;
	private roomId = 0;

	async init() {
		try {
			this.db = await openStore();
			navigator.storage?.persist?.().catch(() => {});
		} catch {
			this.storageOk = false;
		}
		const cached = this.db ? ((await this.db.get('meta', 'state')) as ScorerState | undefined) : undefined;
		await this.refresh();
		if (!this.state && cached) {
			this.state = cached;
			this.fromCache = true;
		}
		if (this.state) {
			this.roomId = this.state.room.id;
			if (this.db) this.local = ((await this.db.getAllFromIndex('events', 'roomId', this.roomId)) as LocalEvent[]).sort((a, b) => a.matchId - b.matchId || a.deviceSeq - b.deviceSeq);
		}
		window.addEventListener('online', this.onOnline);
		window.addEventListener('offline', this.onOffline);
		this.timers.push(setInterval(() => this.sync(), 4000));
		this.timers.push(setInterval(() => this.heartbeat(), 10000));
		this.timers.push(setInterval(() => this.refresh(), 30000));
		this.sync();
		this.heartbeat();
	}

	destroy() {
		this.timers.forEach(clearInterval);
		window.removeEventListener('online', this.onOnline);
		window.removeEventListener('offline', this.onOffline);
	}

	private onOnline = () => {
		this.online = true;
		this.sync();
	};
	private onOffline = () => {
		this.online = false;
	};

	/** Fetch the room's games and their server logs; cache them for offline reloads. */
	async refresh(): Promise<boolean> {
		try {
			const res = await fetch('/api/scorer/state', { cache: 'no-store' });
			if (res.status === 401) {
				this.loadError = 'signed_out';
				return false;
			}
			if (!res.ok) throw new Error(String(res.status));
			const s = (await res.json()) as ScorerState;
			this.state = s;
			this.fromCache = false;
			this.online = true;
			this.loadError = null;
			if (this.db) await this.db.put('meta', $state.snapshot(s), 'state');
			return true;
		} catch {
			this.online = false;
			return false;
		}
	}

	match(matchId: number): ScorerMatch | undefined {
		return this.state?.matches.find((m) => m.id === matchId);
	}

	/** Server events plus this device's not-yet-confirmed events, in order. */
	eventsFor(matchId: number): ScoreEvent[] {
		const server = this.match(matchId)?.events ?? [];
		const known = new Set(server.map((e) => e.id));
		let seq = server.length ? Math.max(...server.map((e) => e.seq)) : 0;
		const extra = this.local
			.filter((e) => e.matchId === matchId && !known.has(e.id) && !e.rejected)
			.sort((a, b) => (a.serverSeq ?? Infinity) - (b.serverSeq ?? Infinity) || a.deviceSeq - b.deviceSeq)
			.map(
				(e): ScoreEvent => ({
					id: e.id,
					seq: e.serverSeq ?? ++seq,
					body: e.body,
					actor: `room:${e.roomId}`,
					deviceId: e.deviceId,
					deviceSeq: e.deviceSeq,
					clientTs: e.clientTs
				})
			);
		return [...server, ...extra].sort((a, b) => a.seq - b.seq);
	}

	/** Record an action: saved locally first (durable), then sent. */
	async add(matchId: number, body: EventBody): Promise<string> {
		const s = this.state!;
		const mine = [
			...(this.match(matchId)?.events ?? []).filter((e) => e.deviceId === s.deviceId).map((e) => e.deviceSeq ?? 0),
			...this.local.filter((e) => e.matchId === matchId).map((e) => e.deviceSeq)
		];
		const ev: LocalEvent = {
			id: crypto.randomUUID(),
			matchId,
			roomId: s.room.id,
			eventId: s.event.id,
			deviceId: s.deviceId,
			deviceSeq: (mine.length ? Math.max(...mine) : 0) + 1,
			body: $state.snapshot(body) as EventBody,
			clientTs: new Date().toISOString(),
			synced: 0,
			serverSeq: null,
			rejected: null
		};
		if (this.db) await this.db.put('events', ev);
		this.local.push(ev);
		queueMicrotask(() => this.sync());
		return ev.id;
	}

	async sync() {
		if (this.syncing) {
			this.syncQueued = true;
			return;
		}
		const batch = this.pending.map((e) => $state.snapshot(e) as LocalEvent);
		if (!batch.length || this.leaseLost) return;
		this.syncing = true;
		try {
			const res = await fetch('/api/scorer/events', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ events: batch.map(({ id, matchId, deviceSeq, body, clientTs }) => ({ id, matchId, deviceSeq, body, clientTs })) })
			});
			if (res.status === 401) {
				this.loadError = 'signed_out';
				return;
			}
			if (!res.ok) throw new Error(String(res.status));
			const { results } = (await res.json()) as { results: { id: string; status: string; seq?: number; reason?: string }[] };
			for (const r of results) {
				const ev = this.local.find((e) => e.id === r.id);
				if (!ev) continue;
				if (r.status === 'accepted' || r.status === 'duplicate') {
					ev.synced = 1;
					ev.serverSeq = r.seq ?? null;
					const m = this.match(ev.matchId);
					if (m && !m.events.some((x) => x.id === ev.id))
						m.events.push({ id: ev.id, seq: r.seq!, body: ev.body, actor: `room:${ev.roomId}`, deviceId: ev.deviceId, deviceSeq: ev.deviceSeq, clientTs: ev.clientTs });
				} else {
					ev.rejected = r.reason ?? 'rejected';
					if (r.reason === 'device_replaced' && this.state) this.state.leaseOk = false;
				}
				if (this.db) await this.db.put('events', $state.snapshot(ev));
			}
			this.online = true;
			this.lastSyncAt = Date.now();
			if (this.db && this.state) await this.db.put('meta', $state.snapshot(this.state), 'state');
		} catch {
			this.online = false;
		} finally {
			this.syncing = false;
			if (this.syncQueued) {
				this.syncQueued = false;
				queueMicrotask(() => this.sync());
			}
		}
	}

	async heartbeat() {
		try {
			const res = await fetch('/api/scorer/heartbeat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pending: this.pending.length })
			});
			if (res.status === 401) {
				this.loadError = 'signed_out';
				return;
			}
			const j = await res.json();
			this.online = true;
			if (this.state) this.state.leaseOk = !!j.leaseOk;
			// Something changed on the server (a staff correction, approval, or new schedule): reload.
			if (j.version && this.serverVersion !== null && j.version !== this.serverVersion && !this.syncing) await this.refresh();
			this.serverVersion = j.version ?? null;
		} catch {
			this.online = false;
		}
	}

	/** A file with every action this device recorded for the room, for a flash drive. */
	async rescueFile(): Promise<{ name: string; blob: Blob }> {
		const s = this.state!;
		const events = this.local.map((e) => $state.snapshot(e));
		const text = JSON.stringify(events);
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
		const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
		const payload = {
			format: 'sb-scorer-rescue',
			version: 1,
			exportedAt: new Date().toISOString(),
			eventId: s.event.id,
			eventName: s.event.name,
			roomId: s.room.id,
			roomName: s.room.name,
			deviceId: s.deviceId,
			unsent: this.pending.length,
			events,
			sha256
		};
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		return {
			name: `${s.room.name.replace(/\W+/g, '-')}-scores-${stamp}.json`,
			blob: new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' })
		};
	}

	async downloadRescueFile() {
		const { name, blob } = await this.rescueFile();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
	}

	async getMeta<T>(key: string): Promise<T | undefined> {
		return this.db ? ((await this.db.get('meta', key)) as T | undefined) : undefined;
	}

	async setMeta(key: string, value: unknown) {
		if (this.db) await this.db.put('meta', value, key);
	}
}
