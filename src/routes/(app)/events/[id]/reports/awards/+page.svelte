<script lang="ts">
	let { data } = $props();
	const a = $derived(data.awards);
	const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
</script>

<svelte:head><title>Awards · {a.event.name}</title></svelte:head>

<div class="report">
	<div class="no-print bar"><button class="btn" type="button" onclick={() => window.print()}>Print</button></div>
	{#each a.sessions as s (s.id)}
		<section class="page">
			<header>
				<img src="/suscc-logo-navy.svg" alt="Southern Union State Community College" />
				<div>
					<h1>{a.event.name}{a.event.isTest ? ' — PRACTICE' : ''}</h1>
					<div class="sub">{s.name} session awards · {fmtDate(s.date)}</div>
				</div>
			</header>
			{#if s.mode !== 'final'}
				<div class="prov">PROVISIONAL — this session has not been finalized{s.unapproved ? ` (${s.unapproved} counting round${s.unapproved === 1 ? '' : 's'} not approved)` : ''}</div>
			{/if}
			{#if s.openTies}<div class="prov">{s.openTies} tie(s) at award places still need a decision</div>{/if}

			{#if a.rules.awards.classPlaces > 0}
				<h2>Classification awards</h2>
				{#each s.divisions as c (c.label)}
					{#each c.classes as k (k.classification)}
						<div class="award">
							<h3>{k.classification} <span class="div-note">({c.label})</span></h3>
							{#each k.places as p (p.team)}
								<div class="place">
									<span class="pl">{p.placeLabel} place</span>
									<span class="who">{p.team}</span>
									<span class="detail">{p.record}, {p.points} pts</span>
								</div>
								{#if p.tied}<div class="note">⚠ Tied — not yet decided</div>{/if}
								{#if p.pending}<div class="note">Waiting on bracket games</div>{/if}
							{/each}
						</div>
					{/each}
				{/each}
			{/if}

			<h2>{a.rules.awards.teamPlaces === 1 ? 'Overall division winners' : 'Division awards'}</h2>
			{#each s.divisions as c (c.label)}
				<div class="award">
					<h3>{c.label}</h3>
					{#each c.places as p (p.team)}
						<div class="place">
							<span class="pl">{p.placeLabel} place</span>
							<span class="who">{p.team}</span>
							<span class="detail">{p.classification} · {p.record}, {p.points} pts{p.bracketResult ? ` · ${p.bracketResult}` : ''}</span>
						</div>
						{#if p.tied}<div class="note">⚠ Tied — not yet decided</div>{/if}
						{#if p.resolved}<div class="note">Tie decided: {p.resolved}</div>{/if}
					{/each}
					{#if c.soleTeam}<div class="note">Only team in this division.</div>{/if}
					{#if c.spans}<div class="note">Ranked across the {c.spans} sessions.</div>{/if}
					{#if c.provisional && s.mode === 'final'}<div class="note">Provisional: another session in this division is not finalized.</div>{/if}
				</div>
			{/each}

			{#if s.individuals.length && a.rules.awards.individualPlaces > 0}
				<h2>All-tournament individual awards</h2>
				{#each s.individuals as g (g.label)}
					<div class="award">
						<h3>{g.label}</h3>
						{#each g.places as p (p.name + p.team)}
							<div class="place">
								<span class="pl">{p.placeLabel}</span>
								<span class="who">{p.name}</span>
								<span class="detail">{p.team} · {p.points} pts</span>
							</div>
							{#if p.tied}<div class="note">⚠ Tied — not yet decided</div>{/if}
							{#if p.resolved}<div class="note">Tie decided: {p.resolved}</div>{/if}
						{/each}
					</div>
				{/each}
			{/if}
		</section>
	{/each}
</div>

<style>
	.report {
		max-width: 8.5in;
		margin: 0 auto;
		padding: 16px;
		color: #000;
	}
	.bar {
		margin-bottom: 12px;
	}
	.page {
		background: #fff;
		padding: 0.4in;
		margin-bottom: 20px;
		break-after: page;
		border: 1px solid var(--border);
	}
	header {
		display: flex;
		gap: 18px;
		align-items: center;
		border-bottom: 3px solid var(--suscc-navy);
		padding-bottom: 10px;
	}
	header img {
		height: 36px;
	}
	h1 {
		margin: 0;
		font-size: 20pt;
	}
	.sub {
		font-size: 12pt;
	}
	.prov {
		margin-top: 10px;
		padding: 6px 10px;
		border: 2px solid #b42318;
		color: #b42318;
		font-weight: 800;
		text-align: center;
	}
	h2 {
		margin: 22px 0 6px;
		font-size: 15pt;
		border-bottom: 1px solid #999;
	}
	.award {
		margin: 10px 0 14px;
		break-inside: avoid;
	}
	.div-note {
		font-size: 10pt;
		color: #444;
		font-weight: 400;
	}
	h3 {
		margin: 0 0 4px;
		font-size: 14pt;
		color: var(--suscc-blue);
	}
	.place {
		display: grid;
		grid-template-columns: 1.2in 1fr auto;
		gap: 10px;
		align-items: baseline;
		font-size: 15pt;
		padding: 2px 0;
	}
	.pl {
		font-weight: 700;
		font-size: 12pt;
		color: #333;
	}
	.who {
		font-weight: 800;
	}
	.detail {
		font-size: 10pt;
		color: #444;
	}
	.note {
		font-size: 10pt;
		color: #8a5a00;
		margin-left: 1.3in;
	}
	@media print {
		.report {
			padding: 0;
			max-width: none;
		}
		.page {
			border: 0;
			padding: 0;
			margin: 0;
		}
	}
</style>
