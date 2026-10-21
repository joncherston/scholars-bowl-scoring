<script lang="ts">
	let { data } = $props();
	const base = $derived(`/events/${data.event.id}/reports`);
	const pdf = (path: string, name: string) => `${base}/pdf?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;

	let packetBusy = $state(false);
	let packetStatus = $state<{ kind: 'success' | 'warning' | 'error'; text: string } | null>(null);

	/** Fetch the review packet and save it (one download), reporting progress and problems on the page. */
	async function downloadPacket() {
		packetBusy = true;
		packetStatus = null;
		try {
			const res = await fetch(`${base}/packet.zip`, { headers: { Accept: 'application/zip, application/json' } });
			if (!res.ok) {
				const message = await res.json().then((b) => b?.message, () => null);
				packetStatus = { kind: 'error', text: message ?? `The review packet could not be made (error ${res.status}).` };
				return;
			}
			const blob = await res.blob();
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'review-packet.zip';
			document.body.append(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
			const missing = Number(res.headers.get('X-Packet-Missing') ?? 0);
			packetStatus = missing
				? { kind: 'warning', text: `Downloaded, but ${missing} PDF${missing === 1 ? '' : 's'} could not be made. The Read me lists which; download them below.` }
				: { kind: 'success', text: 'Review packet downloaded.' };
		} catch {
			packetStatus = { kind: 'error', text: 'The review packet could not be downloaded. Check the connection and try again.' };
		} finally {
			packetBusy = false;
		}
	}
</script>

<svelte:head><title>Reports · {data.event.name}</title></svelte:head>

<div class="container wide">
	<h2>Reports</h2>
	<p class="muted">Every report is calculated from the scoring log when you open it. Sessions that aren't finalized are marked <strong>provisional</strong>.</p>

	<div class="card">
		<h3>Whole event</h3>
		<div class="row">
			<a class="btn" href="{base}/awards">Awards sheet</a>
			<a class="btn secondary" href={pdf(`${base}/awards`, 'awards')}>Awards sheet PDF</a>
			<a class="btn secondary" href="{base}/export.xlsx">Excel workbook (.xlsx)</a>
		</div>
		{#if data.can.reports}
			<h4 style="margin: 16px 0 4px">Review packet</h4>
			<p class="small muted" style="margin: 0 0 8px">One .zip for checking results: the awards sheet, each session's full results, completed scoresheets and schedule as PDFs, the Excel workbook, and a Read me with the rules and anything still open. It takes a minute or two.</p>
			<div class="row">
				<button class="btn" type="button" onclick={downloadPacket} disabled={packetBusy}>{packetBusy ? 'Preparing the review packet…' : 'Download review packet'}</button>
			</div>
			{#if packetStatus}<div class="alert {packetStatus.kind}" role={packetStatus.kind === 'error' ? 'alert' : 'status'} style="margin-top: 8px">{packetStatus.text}</div>{/if}
		{/if}
	</div>

	{#each data.sessionList as s (s.id)}
		<div class="card">
			<div class="row between">
				<h3>{s.name}</h3>
				{#if s.finalizedAt}<span class="badge ok">Finalized</span>{:else}<span class="badge warn">Provisional</span>{/if}
			</div>
			<div class="row">
				<a class="btn secondary" href="{base}/awards?session={s.id}">Awards</a>
				<a class="btn secondary" href={pdf(`${base}/awards?session=${s.id}`, `awards-${s.name}`)}>Awards PDF</a>
				<a class="btn secondary" href="{base}/results?session={s.id}">Full results</a>
				<a class="btn secondary" href={pdf(`${base}/results?session=${s.id}`, `results-${s.name}`)}>Full results PDF</a>
				<a class="btn secondary" href="{base}/scoresheets?session={s.id}">Completed scoresheets</a>
				<a class="btn secondary" href={pdf(`${base}/scoresheets?session=${s.id}`, `scoresheets-${s.name}`)}>Completed scoresheets PDF</a>
				<a class="btn secondary" href={pdf(`/events/${data.event.id}/schedule/print?session=${s.id}`, `schedule-${s.name}`)}>Schedule PDF</a>
			</div>
			<p class="small muted" style="margin: 12px 0 4px">Blank paper scoresheets (teams and players filled in), for a paper backup:</p>
			<div class="row">
				{#each Array.from({ length: s.roundCount }, (_, i) => i + 1) as r (r)}
					<a class="btn small secondary" href={pdf(`${base}/scoresheets?session=${s.id}&round=${r}&blank=1`, `blank-scoresheets-${s.name}-round-${r}`)}>Round {r}</a>
				{/each}
				<a class="btn small" href={pdf(`${base}/scoresheets?session=${s.id}&blank=1`, `blank-scoresheets-${s.name}`)}>All rounds</a>
			</div>
		</div>
	{/each}
	<p class="muted small">Per-round audit printouts are on each round's page in the Live dashboard (Print audit sheet).</p>
</div>
