/**
 * A small reader for Excel 97–2003 workbooks (.xls): the compound file container and the BIFF8 cell
 * records. It reads sheet names and cell values only (numbers, text, formula results), which is all
 * the scoresheet import needs. Anything it can't read is skipped, never guessed.
 */

export type XlsValue = number | string | boolean | null;
export interface XlsSheet {
	name: string;
	cells: Map<string, XlsValue>;
}

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** Streams in a compound file (OLE2), by name. */
export function readCompoundFile(buf: Uint8Array): Map<string, Uint8Array> {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
	if (buf.length < 512 || sig.some((b, i) => buf[i] !== b)) throw new Error('Not an Excel 97–2003 file');
	const sectorSize = 1 << dv.getUint16(0x1e, true);
	const miniSize = 1 << dv.getUint16(0x20, true);
	const firstDir = dv.getUint32(0x30, true);
	const cutoff = dv.getUint32(0x38, true);
	const firstMiniFat = dv.getUint32(0x3c, true);
	let difatNext = dv.getUint32(0x44, true);
	const sectorAt = (i: number) => (i + 1) * sectorSize;
	const u32 = (off: number) => (off + 4 <= buf.length ? dv.getUint32(off, true) : FREESECT);

	const fatSectors: number[] = [];
	for (let i = 0; i < 109; i++) {
		const s = u32(0x4c + i * 4);
		if (s !== FREESECT) fatSectors.push(s);
	}
	for (let guard = 0; difatNext !== ENDOFCHAIN && difatNext !== FREESECT && guard < 10000; guard++) {
		const base = sectorAt(difatNext);
		const per = sectorSize / 4 - 1;
		for (let i = 0; i < per; i++) {
			const s = u32(base + i * 4);
			if (s !== FREESECT) fatSectors.push(s);
		}
		difatNext = u32(base + per * 4);
	}
	const fat: number[] = [];
	for (const s of fatSectors) for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(sectorAt(s) + i * 4));

	const chain = (start: number, table: number[]) => {
		const out: number[] = [];
		const seen = new Set<number>();
		for (let s = start; s !== ENDOFCHAIN && s < table.length && !seen.has(s); s = table[s]) {
			seen.add(s);
			out.push(s);
		}
		return out;
	};
	const readChain = (start: number) => {
		const secs = chain(start, fat);
		const out = new Uint8Array(secs.length * sectorSize);
		secs.forEach((s, i) => out.set(buf.subarray(sectorAt(s), sectorAt(s) + sectorSize), i * sectorSize));
		return out;
	};

	const dir = readChain(firstDir);
	const ddv = new DataView(dir.buffer);
	const entries: { name: string; type: number; start: number; size: number }[] = [];
	for (let off = 0; off + 128 <= dir.length; off += 128) {
		const nameLen = ddv.getUint16(off + 64, true);
		const name = new TextDecoder('utf-16le').decode(dir.subarray(off, off + Math.max(0, Math.min(64, nameLen) - 2)));
		entries.push({ name, type: dir[off + 66], start: ddv.getUint32(off + 116, true), size: ddv.getUint32(off + 120, true) });
	}
	const root = entries.find((e) => e.type === 5);
	const miniStream = root ? readChain(root.start) : new Uint8Array();
	const miniFatBytes = firstMiniFat === ENDOFCHAIN || firstMiniFat === FREESECT ? new Uint8Array() : readChain(firstMiniFat);
	const mdv = new DataView(miniFatBytes.buffer);
	const miniFat = Array.from({ length: miniFatBytes.length / 4 }, (_, i) => mdv.getUint32(i * 4, true));

	const streams = new Map<string, Uint8Array>();
	for (const e of entries) {
		if (e.type !== 2) continue;
		if (e.size < cutoff) {
			const secs = chain(e.start, miniFat);
			const out = new Uint8Array(secs.length * miniSize);
			secs.forEach((s, i) => out.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
			streams.set(e.name, out.subarray(0, e.size));
		} else streams.set(e.name, readChain(e.start).subarray(0, e.size));
	}
	return streams;
}

/** Reads bytes across a record and its CONTINUE records (strings in the shared string table may be split). */
class Segments {
	private i = 0;
	private pos = 0;
	constructor(private segs: Uint8Array[]) {}
	get done() {
		return this.i >= this.segs.length || (this.i === this.segs.length - 1 && this.pos >= this.segs[this.i].length);
	}
	private ensure() {
		while (this.i < this.segs.length && this.pos >= this.segs[this.i].length) {
			this.i++;
			this.pos = 0;
		}
		if (this.i >= this.segs.length) throw new Error('Unexpected end of string table');
	}
	byte(): number {
		this.ensure();
		return this.segs[this.i][this.pos++];
	}
	u16() {
		return this.byte() | (this.byte() << 8);
	}
	u32() {
		return (this.u16() | (this.u16() << 16)) >>> 0;
	}
	skip(n: number) {
		while (n > 0) {
			this.ensure();
			const k = Math.min(n, this.segs[this.i].length - this.pos);
			this.pos += k;
			n -= k;
		}
	}
	/** Characters of a string; a CONTINUE boundary inside them starts with a fresh flags byte. */
	chars(count: number, high: boolean): string {
		let s = '';
		while (count > 0) {
			if (this.pos >= this.segs[this.i].length) {
				this.i++;
				this.pos = 0;
				if (this.i >= this.segs.length) throw new Error('Unexpected end of string table');
				high = (this.byte() & 1) === 1;
			}
			const seg = this.segs[this.i];
			const avail = Math.floor((seg.length - this.pos) / (high ? 2 : 1));
			const k = Math.min(count, avail);
			for (let j = 0; j < k; j++) {
				s += String.fromCharCode(high ? seg[this.pos] | (seg[this.pos + 1] << 8) : seg[this.pos]);
				this.pos += high ? 2 : 1;
			}
			count -= k;
			if (k === 0 && count > 0) this.pos = seg.length;
		}
		return s;
	}
	/** An XLUnicodeRichExtendedString (shared string table entry) or XLUnicodeString. */
	string(lenBytes: 1 | 2 = 2): string {
		const cch = lenBytes === 1 ? this.byte() : this.u16();
		const flags = this.byte();
		const runs = flags & 0x08 ? this.u16() : 0;
		const ext = flags & 0x04 ? this.u32() : 0;
		const s = this.chars(cch, (flags & 1) === 1);
		this.skip(runs * 4 + ext);
		return s;
	}
}

function rk(v: number): number {
	let n: number;
	if (v & 2) n = (v | 0) >> 2;
	else {
		const b = new DataView(new ArrayBuffer(8));
		b.setUint32(4, v & 0xfffffffc, true);
		n = b.getFloat64(0, true);
	}
	return v & 1 ? n / 100 : n;
}

/** Sheets and their cell values from an .xls file. */
export function readXls(buf: Uint8Array): XlsSheet[] {
	const streams = readCompoundFile(buf);
	const wb = streams.get('Workbook') ?? streams.get('Book');
	if (!wb) throw new Error('This file has no workbook in it');
	const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);

	type Rec = { type: number; off: number; len: number };
	const recs: Rec[] = [];
	for (let off = 0; off + 4 <= wb.length; ) {
		const type = dv.getUint16(off, true);
		const len = dv.getUint16(off + 2, true);
		recs.push({ type, off: off + 4, len });
		off += 4 + len;
	}
	const data = (r: Rec) => wb.subarray(r.off, r.off + r.len);

	const sheets: { name: string; pos: number }[] = [];
	let sst: string[] = [];
	for (let i = 0; i < recs.length; i++) {
		const r = recs[i];
		if (r.type === 0x000a) break; // end of the workbook globals
		if (r.type === 0x0085) {
			const pos = dv.getUint32(r.off, true);
			const kind = wb[r.off + 5];
			if (kind === 0) sheets.push({ name: new Segments([data(r).subarray(6)]).string(1), pos });
		} else if (r.type === 0x00fc) {
			const segs = [data(r).subarray(8)];
			for (let j = i + 1; j < recs.length && recs[j].type === 0x003c; j++) segs.push(data(recs[j]));
			const count = dv.getUint32(r.off + 4, true);
			const rd = new Segments(segs);
			sst = [];
			try {
				for (let k = 0; k < count && !rd.done; k++) sst.push(rd.string());
			} catch {
				/* keep the strings read so far */
			}
		}
	}

	const byPos = new Map(recs.map((r, i) => [r.off - 4, i]));
	return sheets.map(({ name, pos }) => {
		const cells = new Map<string, XlsValue>();
		const set = (row: number, col: number, v: XlsValue) => cells.set(`${row},${col}`, v);
		let i = (byPos.get(pos) ?? recs.length) + 1;
		let pendingString: [number, number] | null = null;
		for (; i < recs.length; i++) {
			const r = recs[i];
			const o = r.off;
			if (r.type === 0x000a || r.type === 0x0809) break;
			const row = () => dv.getUint16(o, true);
			const col = () => dv.getUint16(o + 2, true);
			switch (r.type) {
				case 0x00fd: // LABELSST
					set(row(), col(), sst[dv.getUint32(o + 6, true)] ?? '');
					break;
				case 0x0204: // LABEL
					set(row(), col(), new Segments([data(r).subarray(6)]).string());
					break;
				case 0x0203: // NUMBER
					set(row(), col(), dv.getFloat64(o + 6, true));
					break;
				case 0x027e: // RK
					set(row(), col(), rk(dv.getUint32(o + 6, true)));
					break;
				case 0x00bd: {
					// MULRK
					const first = col();
					const n = (r.len - 6) / 6;
					for (let k = 0; k < n; k++) set(row(), first + k, rk(dv.getUint32(o + 4 + k * 6 + 2, true)));
					break;
				}
				case 0x0205: // BOOLERR
					if (wb[o + 7] === 0) set(row(), col(), wb[o + 6] === 1);
					break;
				case 0x0006: {
					// FORMULA: keep the last calculated result
					if (dv.getUint16(o + 12, true) === 0xffff) {
						const kind = wb[o + 6];
						if (kind === 0) pendingString = [row(), col()];
						else if (kind === 1) set(row(), col(), wb[o + 8] === 1);
						else if (kind === 3) set(row(), col(), '');
					} else set(row(), col(), dv.getFloat64(o + 6, true));
					break;
				}
				case 0x0207: // STRING (a formula's text result)
					if (pendingString) {
						const segs = [data(r)];
						for (let j = i + 1; j < recs.length && recs[j].type === 0x003c; j++) segs.push(data(recs[j]));
						set(pendingString[0], pendingString[1], new Segments(segs).string());
						pendingString = null;
					}
					break;
			}
		}
		return { name, cells };
	});
}
