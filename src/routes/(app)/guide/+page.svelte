<svelte:head><title>Day-of Guide · Scholars' Bowl Scoring</title></svelte:head>

<div class="container guide">
	<div class="no-print row between">
		<p class="muted">One page for volunteers. Print it for each room and the scoring table.</p>
		<button class="btn" type="button" onclick={() => window.print()}>Print</button>
	</div>
	<h1>Scholars' Bowl Day-of Guide</h1>

	<div class="cols">
		<section>
			<h2>Room scorers</h2>
			<ol>
				<li><strong>Sign in.</strong> In Chrome (your normal profile if you can, not a Guest window), go to <strong>scoring.suscholarsbowl.com/room</strong> and enter the PIN on your room card.</li>
				<li><strong>Start the round.</strong> The next game is already selected. Check both teams, tick the 4 players for each (it remembers last round), and click <em>Start round</em>.</li>
				<li><strong>Each tossup:</strong> click the player who buzzed (or press <kbd>1</kbd>–<kbd>4</kbd> for team A, <kbd>7</kbd>–<kbd>0</kbd> for team B), then <em>Correct</em> <kbd>C</kbd> or <em>Wrong</em> <kbd>X</kbd>. After a wrong answer the other team gets its turn. If nobody gets it: <em>Dead tossup</em> <kbd>D</kbd>.</li>
				<li><strong>Bonus:</strong> pick the value (10, 20, 25, 30, or Other), the number of parts, tap each part answered correctly, then <em>Save bonus</em> <kbd>Enter</kbd>.</li>
				<li><strong>Mistake?</strong> <em>Undo</em> <kbd>U</kbd>. Press again to keep undoing.</li>
				<li><strong>After tossup 12</strong> a yellow box reminds you to announce the score. Click <em>Done</em>.</li>
				<li><strong>Time called:</strong> <em>End round</em> <kbd>E</kbd> and pick the reason. If the score is tied, start the <em>tiebreaker</em>: first correct answer wins.</li>
				<li><strong>Submit:</strong> read the final score to the moderator, tick the box, and click <em>Submit round</em>. The round then locks. Click <em>Next game</em>.</li>
			</ol>
			<div class="box">
				<h3>Prefer the spreadsheet?</h3>
				<p>At sign-in choose <em>Start scoring with the spreadsheet</em>: the same scoresheet as past years, a tab for each round, with the room, round, schools and players filled in. Type the moderator's name, then <strong>10</strong> under the player who answered (<strong>0</strong> for a wrong answer) and the points in <em>Bonus Points</em>. Row 26 is the tiebreaker. At the end, click <em>Submit round</em>. Kept score in your own Excel file? Open that round's tab and click <em>Import scores</em>. Switch screens any time from <em>Menu</em>.</p>
			</div>
			<div class="box">
				<h3>In a practice (bye) room?</h3>
				<p>The screen says <strong>PRACTICE ROOM · scores here never count</strong>. Pick two teams and click <em>Start practice game</em>, then score as usual. Nothing scored there reaches standings, awards or results. Start another from <em>Games → Start a practice game</em> (spreadsheet: <em>New practice game</em>).</p>
			</div>
			<div class="box">
				<h3>Watch the top-right corner</h3>
				<p><strong>"All changes saved"</strong>: everything is on the server.</p>
				<p><strong>"Offline — N actions waiting"</strong>: keep scoring and <u>don't close the window</u>; it catches up on its own. If the computer must be closed or restarted while offline, first click <em>Download unsaved results</em> and take the file (flash drive) to the head scorekeeper.</p>
				<p><strong>Computer died?</strong> Sign in on another computer with the same PIN and choose <em>score on this computer</em>. It continues from the last saved action.</p>
			</div>
		</section>

		<section>
			<h2>Check-in desk</h2>
			<ol>
				<li>Open <strong>Check-in</strong> and pick the session. Schools that registered online already have their student list.</li>
				<li>Click the school and <strong>read the names back to the coach</strong>: <em>Fix spelling</em>, <em>Remove</em> a student who didn't come, or add a substitute (up to 6).</li>
				<li>Click <strong>Confirm roster &amp; check in</strong>. From then on the website no longer changes that roster.</li>
			</ol>
		</section>

		<section>
			<h2>Head scorekeeper</h2>
			<ol>
				<li><strong>Live tab:</strong> each room shows its game, score, and when its computer was last heard from (green under 30 s, amber under 2 min, red: go check).</li>
				<li><strong>Approve</strong> each round when it's submitted (button in the grid or on the round's page).</li>
				<li><strong>A coach disagrees?</strong> Open the round. Compare the tossup-by-tossup table with the coach's sheet, find the first tossup that differs, and use <em>Correct…</em>, <em>Void…</em>, or <em>Add a missing entry</em>. Every change needs a reason and is logged. <em>Print audit sheet</em> to show the coach.</li>
				<li><strong>A results file from a flash drive:</strong> Live → <em>Import a results file</em>. Actions already saved are skipped.</li>
				<li><strong>Needs attention:</strong> red items must be fixed before finalizing. For a tie at an award place, click <em>Resolve tie</em>, set the order, and record how it was decided.</li>
				<li><strong>Finish:</strong> when every counting round is approved, click <em>Finalize session</em>, then Reports → <em>Awards sheet</em> for the ceremony.</li>
			</ol>
			<div class="box">
				<h3>Brackets</h3>
				<p>When a division's pool-play games are in, the semifinals appear by themselves on the Schedule and on the room computers (seed 1 v 4 and 2 v 3 by win/loss ratio, then total points, then head-to-head). The championship and 3rd-place game appear as soon as the semifinals are submitted. A tie for a seed shows in <em>Needs attention</em> with <em>Resolve tie</em>. To start early, Schedule → <em>Create bracket games now</em>.</p>
			</div>
			<div class="box">
				<h3>Practice (bye) rooms</h3>
				<p>Setup → Rooms: tick <em>Practice / bye room</em> for each bye room (before any games are put in it). The schedule and brackets leave those rooms out, and anything scored there never counts or shows publicly. Practice games are listed on the Schedule under <em>Practice rooms</em>, where they can be added or removed.</p>
			</div>
			<div class="box">
				<h3>Changes on the day</h3>
				<p>Room changed? Rename the room or drag the game on the Schedule. Different pairing? Click the game and change the teams (a bracket game changed by hand stays as you set it). A game won't be played? Delete it. A student can't make it? Check-in → <em>Remove</em>. A team doesn't show? <em>Record forfeit</em>.</p>
			</div>
			<div class="box">
				<h3>A team forfeits</h3>
				<p>Not present within five minutes, a late school's first round, or a team that went home: open the round, choose the team under <em>Record forfeit</em>, and give a reason. The opponent gets the win and neither team scores; it counts as final with no separate approval, and the room's computer shows "Forfeit recorded — nothing to score". If a team withdraws mid-event, the Live tab lists its unplayed games with <em>Record forfeits for all remaining games</em>. To undo a forfeit, void it in the round's action history.</p>
			</div>
			<div class="box">
				<h3>If the system is down</h3>
				<p>Use the printed blank scoresheets (Reports → Blank paper scoresheets, print them beforehand). When the system is back, the room scorer enters the paper sheet into the scorer page tossup by tossup, and the head scorekeeper approves it as usual.</p>
			</div>
			<div class="box">
				<h3>Rules at a glance (defaults)</h3>
				<p>Tossups 10 points; no powers or negs. Bonuses only for the team that answered the tossup; partial credit per part. Individual scores count tossups only. Tiebreaker points decide the game but never count toward total points or individual scores. A forfeit is a win for the opponent with no points for either team. Non-counter games and practice-room games never count. Standings: win/loss ratio (or rounds won), then total points, then head-to-head. Awards: 1st and 2nd in each classification, the overall winner of each division (Private, Public 1A–3A, Public 4A–7A), and all-tournament individual awards for each division's top scorers.</p>
			</div>
		</section>
	</div>
</div>

<style>
	.guide h1 {
		font-size: 1.6rem;
		margin-top: 8px;
	}
	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 24px;
	}
	@media (max-width: 860px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	h2 {
		border-bottom: 3px solid var(--suscc-gold);
		padding-bottom: 4px;
	}
	ol {
		padding-left: 20px;
	}
	li {
		margin-bottom: 6px;
	}
	.box {
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		padding: 10px 12px;
		margin-top: 10px;
		background: var(--surface);
	}
	.box h3 {
		margin-bottom: 4px;
	}
	.box p {
		margin: 0 0 6px;
	}
	kbd {
		border: 1px solid var(--border-strong);
		border-radius: 3px;
		padding: 0 4px;
		font-size: 0.8em;
		background: var(--surface-2);
	}
	@media print {
		.guide {
			padding: 0;
			font-size: 9.5pt;
			max-width: none;
		}
		.cols {
			gap: 14px;
		}
		h1 {
			font-size: 15pt;
		}
		li {
			margin-bottom: 3px;
		}
	}
</style>
