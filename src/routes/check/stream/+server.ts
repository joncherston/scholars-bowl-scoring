/** Sends a short burst of Server-Sent Events so a room PC can confirm live updates get through the campus network. */
export function GET() {
	let timer: ReturnType<typeof setInterval>;
	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			controller.enqueue(enc.encode(`: ${' '.repeat(2048)}\n\n`));
			let n = 0;
			timer = setInterval(() => {
				n++;
				controller.enqueue(enc.encode(`data: ${JSON.stringify({ n, t: Date.now() })}\n\n`));
				if (n >= 6) {
					clearInterval(timer);
					controller.close();
				}
			}, 1000);
		},
		cancel() {
			clearInterval(timer);
		}
	});
	return new Response(stream, {
		headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' }
	});
}
