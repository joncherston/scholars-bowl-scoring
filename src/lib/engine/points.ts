import type { RoundingMode } from './rules';

/** Points are integer hundredths everywhere: 1000 = 10 points. */
export type Hundredths = number;

export interface BonusShare {
	/** Points awarded, in hundredths, after the rounding rule. */
	points: Hundredths;
	/** The exact share is not a whole number of points (e.g. 12.5). */
	fractional: boolean;
	/** The exact share cannot be represented in hundredths (e.g. thirds), so it was rounded. */
	inexact: boolean;
	/** Exact share as a fraction of hundredths: numerator / denominator. */
	exact: { numerator: number; denominator: number };
}

/**
 * Proportional bonus credit: `value × partsWon / partsTotal`, computed with
 * integers only.
 *  - exact:   keep fractional points, rounded half-up to the nearest hundredth
 *  - half_up: round to whole points, halves up
 *  - down:    round down to whole points
 */
export function bonusShare(
	value: Hundredths,
	partsTotal: number,
	partsWon: number,
	mode: RoundingMode
): BonusShare {
	if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid bonus value ${value}`);
	if (!Number.isInteger(partsTotal) || partsTotal < 1) throw new Error(`Invalid part count ${partsTotal}`);
	if (!Number.isInteger(partsWon) || partsWon < 0 || partsWon > partsTotal)
		throw new Error(`Invalid parts won ${partsWon}/${partsTotal}`);

	const numerator = value * partsWon;
	const denominator = partsTotal;
	const fractional = numerator % (denominator * 100) !== 0;
	const inexact = numerator % denominator !== 0;

	let points: number;
	switch (mode) {
		case 'exact':
			points = Math.floor((2 * numerator + denominator) / (2 * denominator));
			break;
		case 'half_up':
			points = Math.floor((2 * numerator + 100 * denominator) / (200 * denominator)) * 100;
			break;
		case 'down':
			points = Math.floor(numerator / (100 * denominator)) * 100;
			break;
	}
	return { points, fractional, inexact, exact: { numerator, denominator } };
}

/** Format hundredths for display: 1250 → "12.5", 1000 → "10", -500 → "-5", 333 → "3.33". */
export function formatPoints(h: Hundredths): string {
	const sign = h < 0 ? '-' : '';
	const abs = Math.abs(h);
	const whole = Math.floor(abs / 100);
	const frac = abs % 100;
	if (frac === 0) return `${sign}${whole}`;
	const fracStr = frac % 10 === 0 ? String(frac / 10) : String(frac).padStart(2, '0');
	return `${sign}${whole}.${fracStr}`;
}

/** Parse a points string typed by a person ("12.5", "20") into hundredths. Returns null if invalid. */
export function parsePoints(input: string): Hundredths | null {
	const m = /^\s*(-?)(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(input);
	if (!m) return null;
	const whole = Number(m[2]);
	const frac = m[3] ? Number(m[3].padEnd(2, '0')) : 0;
	const v = whole * 100 + frac;
	return m[1] === '-' ? -v : v;
}
