import { EventEmitter } from 'node:events';

/** In-process notifications for live views (one app process, so no broker is needed). */
export interface BusMessage {
	type: 'round' | 'room' | 'schedule' | 'session' | 'teams';
	eventId: number;
	matchId?: number;
	roomId?: number;
	sessionId?: number;
}

const bus = new EventEmitter();
bus.setMaxListeners(500);

export function publish(msg: BusMessage) {
	bus.emit('msg', msg);
}

export function subscribe(fn: (msg: BusMessage) => void): () => void {
	bus.on('msg', fn);
	return () => bus.off('msg', fn);
}

/**
 * A Server-Sent Events response. `filter` picks which bus messages to send;
 * a heartbeat comment every 15 s keeps proxies from closing the connection.
 */
export function sseResponse(filter: (m: BusMessage) => boolean, request: Request): Response {
	let unsubscribe = () => {};
	let heartbeat: ReturnType<typeof setInterval>;
	let id = 0;
	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			const send = (chunk: string) => {
				try {
					controller.enqueue(enc.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const cleanup = () => {
				unsubscribe();
				clearInterval(heartbeat);
			};
			send(`retry: 3000\n: ${' '.repeat(2048)}\n\n`);
			send(`event: hello\ndata: {}\n\n`);
			unsubscribe = subscribe((m) => {
				if (filter(m)) send(`id: ${++id}\nevent: ${m.type}\ndata: ${JSON.stringify(m)}\n\n`);
			});
			heartbeat = setInterval(() => send(`: ping ${Date.now()}\n\n`), 15000);
			request.signal.addEventListener('abort', () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		},
		cancel() {
			unsubscribe();
			clearInterval(heartbeat);
		}
	});
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
}
