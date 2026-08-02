// ============================================================
// supabase/functions/_shared/statement-core.ts
//
// The deterministic half of commission-statement ingestion. Everything here
// is PURE and synchronous — no network, no Deno/Node globals, no clock — so
// `node --test` runs the exact code the edge functions run.
//
// What lives here:
//   * File-kind detection from magic bytes (never from the extension alone).
//   * Readers that turn PDF-adjacent office formats into a plain grid of
//     strings: ZIP, XLSX, XLS (BIFF8), CSV.
//   * A pure-JS raw-DEFLATE decoder, because .xlsx and .zip are the same
//     container and this repo ships zero third-party dependencies. Using
//     DecompressionStream would work on today's runtimes and quietly stop
//     working on an older one; 200 lines of inflate never will.
//   * Normalizers (amount, date, transaction type) and the projection of a
//     model-derived column mapping onto every row of a sheet.
//   * The dedupe key, which is the row-grain idempotency guarantee.
//
// What deliberately does NOT live here: anything that calls Anthropic (see
// statement-ai.ts) and anything that touches the database (see the two edge
// functions). Keeping this file free of both is what lets the whole parser be
// unit tested without a key or a connection.
// ============================================================

// ------------------------------------------------------------
// Caps. Chosen to sit comfortably inside an edge-function request body and a
// Postgres column, not to match a competitor's marketing number. A real
// carrier commission statement is a few hundred KB.
// ------------------------------------------------------------
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_BATCH_BYTES = 25 * 1024 * 1024; // 25 MB per upload batch
export const MAX_ZIP_MEMBERS = 25;
export const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024; // uncompressed, zip-bomb guard
export const MAX_ROWS_PER_STATEMENT = 20000;

export type FileKind = "pdf" | "xlsx" | "xls" | "csv" | "zip" | "unknown";

export const ALLOWED_KINDS: FileKind[] = ["pdf", "xlsx", "xls", "csv", "zip"];

/** Human sentence for a rejected upload. Never a raw byte count. */
export function tooLargeMessage(name: string, bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  const cap = (MAX_FILE_BYTES / (1024 * 1024)).toFixed(0);
  return `${name} is ${mb} MB. The limit is ${cap} MB per file — split the statement or export a narrower date range.`;
}

// ============================================================
// 1. Raw DEFLATE (RFC 1951) — pure, synchronous, dependency-free.
// ============================================================

// Plain fields rather than a TypeScript parameter property: Node's strip-only
// type removal (what `node --test` uses on these .ts files) rejects
// `constructor(private x)`, and the tests must run the code that ships.
class BitReader {
  data: Uint8Array;
  pos = 0;
  bit = 0;
  constructor(data: Uint8Array) { this.data = data; }

  readBit(): number {
    if (this.pos >= this.data.length) throw new Error("deflate: out of input");
    const b = (this.data[this.pos] >> this.bit) & 1;
    this.bit++;
    if (this.bit === 8) { this.bit = 0; this.pos++; }
    return b;
  }

  readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.readBit() << i;
    return v;
  }

  alignToByte(): void {
    if (this.bit !== 0) { this.bit = 0; this.pos++; }
  }

  readBytes(n: number): Uint8Array {
    const out = this.data.subarray(this.pos, this.pos + n);
    if (out.length !== n) throw new Error("deflate: truncated stored block");
    this.pos += n;
    return out;
  }
}

interface Huffman { counts: Int32Array; symbols: Int32Array }

function buildHuffman(lengths: number[]): Huffman {
  const MAXBITS = 15;
  const counts = new Int32Array(MAXBITS + 1);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  const offsets = new Int32Array(MAXBITS + 2);
  for (let i = 1; i <= MAXBITS; i++) offsets[i + 1] = offsets[i] + counts[i];
  const symbols = new Int32Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym] > 0) symbols[offsets[lengths[sym]]++] = sym;
  }
  return { counts, symbols };
}

function decodeSymbol(br: BitReader, h: Huffman): number {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= br.readBit();
    const count = h.counts[len];
    if (code - first < count) return h.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("deflate: bad symbol");
}

const LENGTH_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LENGTH_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const CLEN_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

let FIXED_LIT: Huffman | null = null;
let FIXED_DIST: Huffman | null = null;

function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (!FIXED_LIT) {
    const l: number[] = [];
    for (let i = 0; i < 144; i++) l.push(8);
    for (let i = 144; i < 256; i++) l.push(9);
    for (let i = 256; i < 280; i++) l.push(7);
    for (let i = 280; i < 288; i++) l.push(8);
    FIXED_LIT = buildHuffman(l);
    FIXED_DIST = buildHuffman(new Array(30).fill(5));
  }
  return { lit: FIXED_LIT!, dist: FIXED_DIST! };
}

/** Inflate a raw DEFLATE stream (no zlib/gzip wrapper). */
export function inflateRaw(input: Uint8Array, expectedSize = 0): Uint8Array {
  const br = new BitReader(input);
  let out = new Uint8Array(Math.max(expectedSize || 0, input.length * 4, 1024));
  let len = 0;
  const push = (b: number) => {
    if (len >= out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[len++] = b;
  };

  for (;;) {
    const final = br.readBit();
    const type = br.readBits(2);

    if (type === 0) {
      br.alignToByte();
      const hdr = br.readBytes(4);
      const blockLen = hdr[0] | (hdr[1] << 8);
      const raw = br.readBytes(blockLen);
      for (let i = 0; i < raw.length; i++) push(raw[i]);
    } else if (type === 1 || type === 2) {
      let lit: Huffman, dist: Huffman;
      if (type === 1) {
        const t = fixedTables();
        lit = t.lit; dist = t.dist;
      } else {
        const hlit = br.readBits(5) + 257;
        const hdist = br.readBits(5) + 1;
        const hclen = br.readBits(4) + 4;
        const clen = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = br.readBits(3);
        const clHuff = buildHuffman(clen);
        const lengths: number[] = [];
        while (lengths.length < hlit + hdist) {
          const sym = decodeSymbol(br, clHuff);
          if (sym < 16) lengths.push(sym);
          else if (sym === 16) {
            const prev = lengths[lengths.length - 1];
            if (prev === undefined) throw new Error("deflate: repeat with no previous length");
            const n = 3 + br.readBits(2);
            for (let i = 0; i < n; i++) lengths.push(prev);
          } else if (sym === 17) {
            const n = 3 + br.readBits(3);
            for (let i = 0; i < n; i++) lengths.push(0);
          } else {
            const n = 11 + br.readBits(7);
            for (let i = 0; i < n; i++) lengths.push(0);
          }
        }
        lit = buildHuffman(lengths.slice(0, hlit));
        dist = buildHuffman(lengths.slice(hlit));
      }

      for (;;) {
        const sym = decodeSymbol(br, lit);
        if (sym === 256) break;
        if (sym < 256) { push(sym); continue; }
        const li = sym - 257;
        if (li >= LENGTH_BASE.length) throw new Error("deflate: bad length code");
        const length = LENGTH_BASE[li] + br.readBits(LENGTH_EXTRA[li]);
        const dsym = decodeSymbol(br, dist);
        if (dsym >= DIST_BASE.length) throw new Error("deflate: bad distance code");
        const distance = DIST_BASE[dsym] + br.readBits(DIST_EXTRA[dsym]);
        if (distance > len) throw new Error("deflate: distance before start");
        const from = len - distance;
        for (let i = 0; i < length; i++) push(out[from + i]);
      }
    } else {
      throw new Error("deflate: reserved block type");
    }

    if (final) break;
  }
  return out.subarray(0, len);
}

// ============================================================
// 2. ZIP container (also the .xlsx container).
// ============================================================

export interface ZipEntry { name: string; bytes: Uint8Array }

function u16(b: Uint8Array, o: number) { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

/**
 * Read a ZIP archive via its central directory (not by scanning for local
 * headers — a local header's sizes can be zeroed with a data descriptor, and
 * the central directory always carries the truth).
 */
export function readZip(bytes: Uint8Array, opts: { maxMembers?: number; maxTotalBytes?: number } = {}): ZipEntry[] {
  const maxMembers = opts.maxMembers ?? MAX_ZIP_MEMBERS;
  const maxTotal = opts.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;

  // End of central directory: signature 0x06054b50, within the last 64 KB.
  let eocd = -1;
  const from = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= from; i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: no end-of-central-directory record");

  const count = u16(bytes, eocd + 10);
  let ptr = u32(bytes, eocd + 16);
  const entries: ZipEntry[] = [];
  let total = 0;

  for (let i = 0; i < count; i++) {
    if (u32(bytes, ptr) !== 0x02014b50) break;
    const method = u16(bytes, ptr + 10);
    const compSize = u32(bytes, ptr + 20);
    const rawSize = u32(bytes, ptr + 24);
    const nameLen = u16(bytes, ptr + 28);
    const extraLen = u16(bytes, ptr + 30);
    const commentLen = u16(bytes, ptr + 32);
    const localOff = u32(bytes, ptr + 42);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // directory entry
    if (entries.length >= maxMembers) {
      throw new Error(`zip: archive holds more than ${maxMembers} files — upload them separately`);
    }
    total += rawSize;
    if (total > maxTotal) throw new Error("zip: archive expands to more than the allowed size");

    // Local header: the extra field length there can differ from the central one.
    if (u32(bytes, localOff) !== 0x04034b50) throw new Error("zip: bad local header");
    const lNameLen = u16(bytes, localOff + 26);
    const lExtraLen = u16(bytes, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);

    let out: Uint8Array;
    if (method === 0) out = comp.slice();
    else if (method === 8) out = inflateRaw(comp, rawSize);
    else throw new Error(`zip: unsupported compression method ${method} in ${name}`);

    entries.push({ name, bytes: out });
  }
  return entries;
}

// ============================================================
// 3. Grids — the common shape every reader produces.
// ============================================================

export interface Sheet { name: string; rows: string[][] }

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
};

function xmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/** Column reference ("BC" in "BC12") to a zero-based index. */
export function colRefToIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// ------------------------------------------------------------
// 3a. XLSX
// ------------------------------------------------------------

function xlsxSharedStrings(xml: string): string[] {
  const out: string[] = [];
  // Each <si> is one string; it may be split across several <t> runs.
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    let s = "";
    while ((t = tRe.exec(m[1])) !== null) s += xmlUnescape(t[1]);
    out.push(s);
  }
  return out;
}

function xlsxSheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) {
    const body = rm[2] ?? "";
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(body)) !== null) {
      const attrs = cm[1] ?? "";
      const inner = cm[2] ?? "";
      const refM = /\br="([A-Z]+)\d+"/.exec(attrs);
      const idx = refM ? colRefToIndex(refM[1]) : cells.length;
      const typeM = /\bt="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : "n";

      let value = "";
      if (type === "inlineStr") {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t: RegExpExecArray | null;
        while ((t = tRe.exec(inner)) !== null) value += xmlUnescape(t[1]);
      } else {
        const vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vM ? xmlUnescape(vM[1]) : "";
        if (type === "s") {
          const i = parseInt(raw, 10);
          value = Number.isFinite(i) ? (shared[i] ?? "") : "";
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
        } else {
          value = raw;
        }
      }
      while (cells.length < idx) cells.push("");
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

export function readXlsx(bytes: Uint8Array): Sheet[] {
  const entries = readZip(bytes, { maxMembers: 500, maxTotalBytes: MAX_ZIP_TOTAL_BYTES });
  const byName = new Map(entries.map((e) => [e.name.replace(/^\//, ""), e.bytes]));
  const dec = new TextDecoder();

  const ssBytes = byName.get("xl/sharedStrings.xml");
  const shared = ssBytes ? xlsxSharedStrings(dec.decode(ssBytes)) : [];

  // Sheet name + rId come from workbook.xml; rId -> file path from its rels.
  const wbBytes = byName.get("xl/workbook.xml");
  const relBytes = byName.get("xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>();
  if (relBytes) {
    const relXml = dec.decode(relBytes);
    const re = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(relXml)) !== null) {
      const target = m[2].replace(/^\/xl\//, "").replace(/^\//, "");
      relMap.set(m[1], target.startsWith("xl/") ? target : `xl/${target}`);
    }
  }

  const sheets: Sheet[] = [];
  if (wbBytes) {
    const wbXml = dec.decode(wbBytes);
    const re = /<sheet\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(wbXml)) !== null) {
      const attrs = m[1];
      const nameM = /\bname="([^"]*)"/.exec(attrs);
      const ridM = /\br:id="([^"]+)"/.exec(attrs);
      n++;
      const path = (ridM && relMap.get(ridM[1])) || `xl/worksheets/sheet${n}.xml`;
      const sheetBytes = byName.get(path);
      if (!sheetBytes) continue;
      sheets.push({
        name: nameM ? xmlUnescape(nameM[1]) : `Sheet${n}`,
        rows: xlsxSheetRows(dec.decode(sheetBytes), shared),
      });
    }
  }

  if (sheets.length === 0) {
    // Fall back to every worksheet part, in path order.
    const paths = [...byName.keys()].filter((k) => /^xl\/worksheets\/.*\.xml$/.test(k)).sort();
    paths.forEach((p, i) => {
      sheets.push({ name: `Sheet${i + 1}`, rows: xlsxSheetRows(dec.decode(byName.get(p)!), shared) });
    });
  }
  return sheets;
}

// ------------------------------------------------------------
// 3b. XLS (OLE2/CFB container + BIFF8 records)
//
// Carriers still export this. A minimal reader is a few hundred lines and
// removes an entire class of "please re-save it as something else" support
// mail. It handles the cell records that carry values in a real statement —
// shared strings, inline labels, numbers, RK/MULRK compressed numbers, and
// formula results — and deliberately ignores everything about formatting.
// ------------------------------------------------------------

const CFB_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

interface CfbStream { name: string; bytes: Uint8Array }

function readCfbStreams(bytes: Uint8Array): CfbStream[] {
  for (let i = 0; i < 8; i++) if (bytes[i] !== CFB_SIG[i]) throw new Error("xls: not an OLE2 container");
  const sectorSize = 1 << u16(bytes, 0x1e);
  const miniSectorSize = 1 << u16(bytes, 0x20);
  const numFatSectors = u32(bytes, 0x2c);
  const dirStart = u32(bytes, 0x30);
  const miniCutoff = u32(bytes, 0x38);
  const miniFatStart = u32(bytes, 0x3c);
  const numDifatSectors = u32(bytes, 0x48);
  const difatStart = u32(bytes, 0x44);

  const sectorOffset = (s: number) => (s + 1) * sectorSize;
  const readSector = (s: number) => bytes.subarray(sectorOffset(s), sectorOffset(s) + sectorSize);

  // DIFAT: 109 entries in the header, then a chain of DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
    const s = u32(bytes, 0x4c + i * 4);
    if (s === 0xffffffff) break;
    fatSectors.push(s);
  }
  let difat = difatStart;
  for (let n = 0; n < numDifatSectors && difat !== 0xffffffff && difat !== 0xfffffffe; n++) {
    const sec = readSector(difat);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector; i++) {
      const s = u32(sec, i * 4);
      if (s === 0xffffffff) continue;
      fatSectors.push(s);
    }
    difat = u32(sec, sectorSize - 4);
  }

  const fat: number[] = [];
  for (const fs of fatSectors) {
    const sec = readSector(fs);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(sec, i * 4));
  }

  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    let s = start;
    let guard = 0;
    while (s !== 0xfffffffe && s !== 0xffffffff && s < table.length && guard++ < 1_000_000) {
      out.push(s);
      s = table[s];
    }
    return out;
  };

  const readChainBytes = (start: number, size: number) => {
    const parts = chain(start, fat).map(readSector);
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { joined.set(p, o); o += p.length; }
    return size > 0 ? joined.subarray(0, size) : joined;
  };

  // Directory
  const dirBytes = readChainBytes(dirStart, 0);
  const entryCount = Math.floor(dirBytes.length / 128);
  interface Dir { name: string; type: number; start: number; size: number }
  const dirs: Dir[] = [];
  for (let i = 0; i < entryCount; i++) {
    const o = i * 128;
    const nameLen = u16(dirBytes, o + 0x40);
    let name = "";
    for (let c = 0; c + 1 < Math.max(0, nameLen - 2); c += 2) {
      name += String.fromCharCode(dirBytes[o + c] | (dirBytes[o + c + 1] << 8));
    }
    dirs.push({ name, type: dirBytes[o + 0x42], start: u32(dirBytes, o + 0x74), size: u32(dirBytes, o + 0x78) });
  }

  const root = dirs.find((d) => d.type === 5);
  let miniStream = new Uint8Array(0);
  let miniFat: number[] = [];
  if (root && root.size > 0) {
    miniStream = readChainBytes(root.start, root.size);
    const mfSectors = chain(miniFatStart, fat);
    for (const s of mfSectors) {
      const sec = readSector(s);
      for (let i = 0; i < sectorSize / 4; i++) miniFat.push(u32(sec, i * 4));
    }
  }

  const readMini = (start: number, size: number) => {
    const parts = chain(start, miniFat).map((s) =>
      miniStream.subarray(s * miniSectorSize, s * miniSectorSize + miniSectorSize)
    );
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { joined.set(p, o); o += p.length; }
    return joined.subarray(0, size);
  };

  return dirs
    .filter((d) => d.type === 2 && d.size > 0)
    .map((d) => ({
      name: d.name,
      bytes: d.size < miniCutoff ? readMini(d.start, d.size) : readChainBytes(d.start, d.size),
    }));
}

function rkToNumber(rk: number): number {
  const isInt = (rk & 2) !== 0;
  const div100 = (rk & 1) !== 0;
  let v: number;
  if (isInt) {
    v = (rk | 0) >> 2;
  } else {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, 0, true);
    dv.setUint32(4, rk & 0xfffffffc, true);
    v = dv.getFloat64(0, true);
  }
  return div100 ? v / 100 : v;
}

/** BIFF8 unicode string starting at `o`; returns the text and bytes consumed. */
function biffString(b: Uint8Array, o: number, cchBytes: 1 | 2): { text: string; next: number } {
  const cch = cchBytes === 1 ? b[o] : u16(b, o);
  let p = o + cchBytes;
  const flags = b[p++];
  const high = (flags & 0x01) !== 0;
  const ext = (flags & 0x04) !== 0;
  const rich = (flags & 0x08) !== 0;
  let runs = 0, extSize = 0;
  if (rich) { runs = u16(b, p); p += 2; }
  if (ext) { extSize = u32(b, p); p += 4; }
  let text = "";
  if (high) {
    for (let i = 0; i < cch; i++) { text += String.fromCharCode(u16(b, p)); p += 2; }
  } else {
    for (let i = 0; i < cch; i++) { text += String.fromCharCode(b[p]); p += 1; }
  }
  p += runs * 4 + extSize;
  return { text, next: p };
}

function parseSst(data: Uint8Array): string[] {
  const out: string[] = [];
  const unique = u32(data, 4);
  let p = 8;
  for (let i = 0; i < unique && p < data.length; i++) {
    const { text, next } = biffString(data, p, 2);
    out.push(text);
    p = next;
  }
  return out;
}

export function readXls(bytes: Uint8Array): Sheet[] {
  const streams = readCfbStreams(bytes);
  const wb = streams.find((s) => s.name === "Workbook") || streams.find((s) => s.name === "Book");
  if (!wb) throw new Error("xls: no Workbook stream");
  const b = wb.bytes;

  // Pass 1: walk records, joining CONTINUE payloads onto the record they follow.
  interface Rec { id: number; data: Uint8Array; offset: number }
  const recs: Rec[] = [];
  let p = 0;
  while (p + 4 <= b.length) {
    const id = u16(b, p);
    const len = u16(b, p + 2);
    const data = b.subarray(p + 4, p + 4 + len);
    if (id === 0x003c && recs.length > 0) {
      const prev = recs[recs.length - 1];
      const joined = new Uint8Array(prev.data.length + data.length);
      joined.set(prev.data, 0);
      joined.set(data, prev.data.length);
      prev.data = joined;
    } else {
      recs.push({ id, data, offset: p });
    }
    p += 4 + len;
  }

  // Shared string table + sheet directory come from the workbook globals.
  let sst: string[] = [];
  const boundsheets: { name: string; pos: number }[] = [];
  for (const r of recs) {
    if (r.id === 0x00fc) { try { sst = parseSst(r.data); } catch { sst = []; } }
    if (r.id === 0x0085) {
      const pos = u32(r.data, 0);
      const { text } = biffString(r.data, 6, 1);
      boundsheets.push({ name: text, pos });
    }
  }

  const sheets: Sheet[] = [];
  const buildSheet = (name: string, startOffset: number): Sheet => {
    const grid: string[][] = [];
    const put = (row: number, col: number, val: string) => {
      while (grid.length <= row) grid.push([]);
      const r = grid[row];
      while (r.length <= col) r.push("");
      r[col] = val;
    };
    let started = false;
    let pendingStringCell: { row: number; col: number } | null = null;
    for (const r of recs) {
      if (r.offset < startOffset) continue;
      if (r.id === 0x0809) {
        if (started) break; // next substream
        started = true;
        continue;
      }
      if (!started) continue;
      if (r.id === 0x000a) break; // EOF of this substream
      const d = r.data;
      switch (r.id) {
        case 0x00fd: { // LABELSST
          const row = u16(d, 0), col = u16(d, 2), isst = u32(d, 6);
          put(row, col, sst[isst] ?? "");
          break;
        }
        case 0x0204: { // LABEL
          const row = u16(d, 0), col = u16(d, 2);
          put(row, col, biffString(d, 6, 2).text);
          break;
        }
        case 0x0203: { // NUMBER
          const row = u16(d, 0), col = u16(d, 2);
          const dv = new DataView(d.buffer, d.byteOffset + 6, 8);
          put(row, col, String(dv.getFloat64(0, true)));
          break;
        }
        case 0x027e: { // RK
          const row = u16(d, 0), col = u16(d, 2);
          put(row, col, String(rkToNumber(u32(d, 6))));
          break;
        }
        case 0x00bd: { // MULRK
          const row = u16(d, 0), first = u16(d, 2);
          const n = Math.floor((d.length - 6) / 6);
          for (let i = 0; i < n; i++) put(row, first + i, String(rkToNumber(u32(d, 4 + i * 6 + 2))));
          break;
        }
        case 0x0006: { // FORMULA — number result, or a marker for a STRING record
          const row = u16(d, 0), col = u16(d, 2);
          if (d[6] === 0 && u16(d, 12) === 0xffff) { pendingStringCell = { row, col }; }
          else {
            const dv = new DataView(d.buffer, d.byteOffset + 6, 8);
            put(row, col, String(dv.getFloat64(0, true)));
          }
          break;
        }
        case 0x0207: { // STRING — the result of the preceding FORMULA
          if (pendingStringCell) {
            put(pendingStringCell.row, pendingStringCell.col, biffString(d, 0, 2).text);
            pendingStringCell = null;
          }
          break;
        }
        default:
          break;
      }
    }
    return { name, rows: grid };
  };

  if (boundsheets.length > 0) {
    for (const bs of boundsheets) sheets.push(buildSheet(bs.name, bs.pos));
  } else {
    sheets.push(buildSheet("Sheet1", 0));
  }
  return sheets;
}

// ------------------------------------------------------------
// 3c. CSV -> grid (positional, unlike _shared/csv.ts which keys by header —
// a commission statement often has blank or duplicated header cells, and a
// preamble above the header row, so positions are the only stable handle).
// ------------------------------------------------------------

export function readCsvGrid(text: string, delimiter?: string): string[][] {
  const src = (text ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const delim = delimiter ?? sniffDelimiter(src);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field.trim()); field = ""; continue; }
    if (ch === "\n") { row.push(field.trim()); rows.push(row); field = ""; row = []; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field.trim()); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Comma, semicolon, tab or pipe — whichever is most consistent across the first lines. */
export function sniffDelimiter(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "").slice(0, 10);
  if (lines.length === 0) return ",";
  let best = ",", bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const mean = total / counts.length;
    const variance = counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length;
    const score = mean - variance; // consistent AND frequent beats merely frequent
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// ============================================================
// 4. File-kind detection — magic bytes first, extension only as a tiebreak.
// ============================================================

/**
 * What a file actually is.
 *
 * Magic bytes win, always. PDF, XLSX/ZIP and XLS are all binary formats with
 * a mandatory signature, so a file carrying one of those extensions WITHOUT
 * the signature is not that format — it is something an agent renamed, and
 * guessing from the name is how a CSV ends up being handed to a PDF reader.
 * The extension is consulted only for the text formats, which have no magic
 * to check.
 */
export function detectFileKind(filename: string, bytes: Uint8Array): FileKind {
  const ext = (filename.split(".").pop() || "").toLowerCase();

  // %PDF, allowing for the junk some generators emit before the header.
  const scan = bytes.subarray(0, 1024);
  for (let i = 0; i + 4 <= scan.length; i++) {
    if (scan[i] === 0x25 && scan[i + 1] === 0x50 && scan[i + 2] === 0x44 && scan[i + 3] === 0x46) return "pdf";
  }

  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    // Both .xlsx and .zip are PK archives. Decide on contents, not on the name.
    try {
      const names = readZip(bytes, { maxMembers: 500 }).map((e) => e.name);
      return names.some((n) => n.startsWith("xl/")) ? "xlsx" : "zip";
    } catch {
      return ext === "xlsx" ? "xlsx" : "zip";
    }
  }

  if (bytes.length >= 8) {
    let cfb = true;
    for (let i = 0; i < 8; i++) if (bytes[i] !== CFB_SIG[i]) { cfb = false; break; }
    if (cfb) return "xls";
  }

  // Anything that decodes as text is a delimited file, whatever it is called.
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 4096));
    if (text.trim() !== "" && (/[,;\t|]/.test(text) || ext === "csv" || ext === "txt" || ext === "tsv")) return "csv";
  } catch { /* not text */ }

  return "unknown";
}

// ============================================================
// 5. Header detection + preview.
// ============================================================

const HEADER_HINTS = [
  "policy", "insured", "client", "name", "carrier", "premium", "commission",
  "amount", "date", "product", "plan", "agent", "writing", "npn", "rate",
  "type", "status", "period", "paid", "earned", "advance", "chargeback",
];

/**
 * Index of the row most likely to be the header. Carrier statements routinely
 * put a logo, an address block and a date range above the real header, so
 * "row 0" is wrong more often than it is right.
 */
export function findHeaderRow(rows: string[][], scan = 25): number {
  let bestIdx = 0, bestScore = -1;
  const limit = Math.min(rows.length, scan);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map((c) => String(c ?? "").trim().toLowerCase());
    const filled = cells.filter((c) => c !== "").length;
    if (filled < 2) continue;
    let score = filled;
    for (const c of cells) {
      if (HEADER_HINTS.some((h) => c.includes(h))) score += 4;
      if (/^-?[\d.,$()%\s]+$/.test(c) && c !== "") score -= 2; // numbers are data, not headers
    }
    const next = rows[i + 1];
    if (next && next.filter((c) => String(c ?? "").trim() !== "").length >= Math.max(2, filled - 2)) score += 3;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestScore < 0 ? 0 : bestIdx;
}

export interface SheetPreview {
  sheetName: string;
  headerRowIndex: number;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
}

/** Header row + a handful of data rows: everything the one AI call ever sees. */
export function previewSheet(sheet: Sheet, sampleCount = 8): SheetPreview {
  const headerRowIndex = findHeaderRow(sheet.rows);
  const headers = (sheet.rows[headerRowIndex] ?? []).map((h) => String(h ?? "").trim());
  const data = sheet.rows.slice(headerRowIndex + 1).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  return {
    sheetName: sheet.name,
    headerRowIndex,
    headers,
    sampleRows: data.slice(0, sampleCount).map((r) => r.map((c) => String(c ?? "").slice(0, 80))),
    totalRows: data.length,
  };
}

// ============================================================
// 6. Normalizers.
// ============================================================

/**
 * Money to integer cents. Handles $, thousands separators, trailing minus,
 * accounting parentheses, and a trailing "CR". Returns null when there is no
 * number at all, so "no amount" and "zero" stay distinguishable.
 *
 * The final step works on the DECIMAL STRING, never on `value * 100`. A
 * float multiply turns "0.145" into 14.499999999999998 and silently loses a
 * cent — on money, in a table that is meant to reconcile against a carrier's
 * own totals. Numbers are stringified first so both inputs take the same
 * exact path.
 */
export function parseAmountCents(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  let s: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Math.abs(input) >= 1e15) return null;
    s = input.toFixed(4); // fixed notation, so no exponent survives into the parse
  } else {
    s = String(input).trim();
  }
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/(^|\s)(cr|credit)(\s|$)/i.test(s)) negative = true;
  if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, ""); }
  s = s.replace(/[^0-9.,\-]/g, "");
  if (s === "" || s === "-" || s === "." || s === ",") return null;
  // 1.234,56 (European) vs 1,234.56 (US): the LAST separator is the decimal one.
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  s = s.replace(/-/g, "");

  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const whole = m[1] === "" ? 0 : Number(m[1]);
  if (!Number.isFinite(whole)) return null;
  const frac = (m[2] ?? "").replace(/[eE].*$/, "");
  // Two decimal places, rounding half-up on the third — decimal arithmetic,
  // not binary, so 0.145 is 15 cents and stays 15 cents.
  let cents = whole * 100 + Number((frac + "00").slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  return negative ? -cents : cents;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Anything a carrier prints as a date to YYYY-MM-DD, or null.
 *
 * Excel serial numbers are accepted because XLSX/XLS store dates as numbers
 * and we deliberately do not read cell formats. The 1900 leap-year bug is
 * reproduced (serial 60 = 1900-02-29, which never existed) because that is
 * what the file means, not what the calendar means.
 */
export function parseDateISO(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (s === "") return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return fmt(+iso[1], +iso[2], +iso[3]);

  const us = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (us) {
    let y = +us[3];
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    return fmt(y, +us[1], +us[2]);
  }

  const named = /^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-](\d{2,4})$/.exec(s)
    || /^([A-Za-z]{3,})[\s\-](\d{1,2}),?[\s\-](\d{2,4})$/.exec(s);
  if (named) {
    const isDayFirst = /^\d/.test(s);
    const monKey = (isDayFirst ? named[2] : named[1]).slice(0, 3).toLowerCase();
    const day = +(isDayFirst ? named[1] : named[2]);
    let y = +named[3];
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    const m = MONTHS[monKey];
    if (m) return fmt(y, m, day);
  }

  if (/^\d{8}$/.test(s)) return fmt(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));

  if (/^\d{1,6}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial >= 1 && serial <= 400000) {
      const epoch = Date.UTC(1899, 11, 30);
      const d = new Date(epoch + serial * 86400000);
      if (serial < 60) d.setUTCDate(d.getUTCDate() + 1); // pre-bug half of the 1900 system
      return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  return null;

  function fmt(y: number, m: number, d: number): string | null {
    if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
}

// ------------------------------------------------------------
// Partial dates — `MM-DD` with no year at all.
//
// American-Amicable's AGENT LEDGER STATEMENT prints its ACCTG DATE and DUE
// DATE as bare `MM-DD` (`07-09`, `08-13`), sometimes with a marker beside it
// (`06-15*`). `parseDateISO` cannot read those — it wants three components —
// so every one of them became null, and a null transaction_date drops the row
// out of the trend chart, the persistency windows and the debt drill-down.
//
// The year has to come from the STATEMENT, never from today: re-reading a
// July statement next February must not move its lines into next year.
// ------------------------------------------------------------

/** Milliseconds in a day — only ever used to compare two UTC midnights. */
const DAY_MS = 86400000;

/** True when (y, m, d) is a real calendar date, so 02-30 is rejected. */
function isRealDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Resolve a bare `MM-DD` against the statement's own date.
 *
 * The year is whichever of {anchor-1, anchor, anchor+1} lands NEAREST the
 * anchor. That single rule covers both directions of the rollover, which a
 * naive "use the statement's year" gets wrong once a year for every agent:
 *
 *   `12-15` on a 2027-01-31 statement -> 2026-12-15 (47 days back), not 2027
 *   `01-05` on a 2027-01-31 statement -> 2027-01-05 (26 days back)
 *   `08-13` on a 2026-07-31 statement -> 2026-08-13 (13 days FORWARD)
 *
 * That last one is why it is "nearest" and not "on or before": a DUE DATE is
 * legitimately in the future, and forcing it backwards would silently invent a
 * date a year early.
 *
 * Returns null for anything that is not exactly two numeric components, or
 * that is not a real date, or when there is no anchor to resolve against — an
 * unresolvable date must fall through the chain, never be guessed.
 *
 * 🔴 NOT applied to an issue/effective date. This carrier prints THOSE as
 * `MM-YY` (`06-26` = June 2026), which is indistinguishable from `MM-DD`
 * (June 26th) as a string. Reading one as the other invents a day, so the
 * caller deliberately only offers this function the slots that carriers print
 * as `MM-DD` — see `resolvePdfRowDates`.
 */
export function resolvePartialDate(input: unknown, anchorISO: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  // Carriers print markers beside a date ("06-15*", "07-01 †"). Strip anything
  // that is not part of the number pattern before matching.
  const s = String(input).trim().replace(/[^0-9\/\-.]+$/, "").trim();
  if (s === "") return null;

  const m = /^(\d{1,2})[\/\-.](\d{1,2})$/.exec(s);
  if (!m) return null;
  const mon = +m[1];
  const day = +m[2];
  if (!(mon >= 1 && mon <= 12) || !(day >= 1 && day <= 31)) return null;

  const anchor = parseDateISO(anchorISO);
  if (!anchor) return null;
  const [ay, am, ad] = anchor.split("-").map(Number);
  const anchorMs = Date.UTC(ay, am - 1, ad);

  let best: { iso: string; dist: number } | null = null;
  for (const y of [ay - 1, ay, ay + 1]) {
    if (!isRealDate(y, mon, day)) continue;
    const dist = Math.abs(Date.UTC(y, mon - 1, day) - anchorMs) / DAY_MS;
    if (!best || dist < best.dist) {
      best = { iso: `${y}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`, dist };
    }
  }
  return best ? best.iso : null;
}

/** A full date if the line printed one, else a `MM-DD` resolved against the statement. */
export function resolveDateWithAnchor(input: unknown, anchorISO: string | null | undefined): string | null {
  return parseDateISO(input) ?? resolvePartialDate(input, anchorISO);
}

export interface PdfRowDateInput {
  /** ACCTG / booked / posted / transaction date — when the carrier booked it. */
  transactionDate?: unknown;
  /** When the agent was paid, if the line says. */
  paidDate?: unknown;
  /** Policy effective / issue date, if the line says. */
  effectiveDate?: unknown;
  /** Premium due date, if the line says. */
  dueDate?: unknown;
}

export interface PdfRowDates {
  transactionDate: string | null;
  effectiveDate: string | null;
  paidDate: string | null;
  /** Which hop of the chain supplied `transactionDate`. For tests and triage. */
  source: "transaction" | "paid" | "effective" | "due" | "period_end" | "none";
}

/**
 * The PDF path's date chain — the counterpart of the one `applyMapping` has
 * carried since the tabular path shipped.
 *
 * WHERE THE TWO AGREE: the first three hops, in the same order —
 * `transaction ?? paid ?? effective`. That is deliberate; two definitions of
 * "when did this line happen" one file format apart is the bug class this
 * repo keeps paying for.
 *
 * WHERE THEY DELIBERATELY DIFFER: this one adds `?? due ?? periodEnd`.
 *   * `due` because a PDF has no column mapping — there is no `-1` to tell us
 *     a date column is simply absent, so any date the line printed is better
 *     evidence than none.
 *   * `periodEnd` as the floor, because it is already sitting on the same
 *     object and a line the carrier printed on a July statement is July money
 *     even when the line itself carries no date. The alternative is null, and
 *     null does not mean "undated" downstream — it means the row silently
 *     disappears from the trend chart, the persistency windows and the debt
 *     drill-down while the totals above them still count it.
 *
 * The tabular path is NOT given these two extra hops. It shipped working and
 * its mapping already distinguishes "no such column" from "empty cell".
 */
export function resolvePdfRowDates(
  input: PdfRowDateInput,
  opts: { anchorDate?: string | null; periodEnd?: string | null },
): PdfRowDates {
  // The anchor is the statement's own date, falling back to the period it
  // covers. Never `new Date()` — re-reading an old statement must not move it.
  const anchor = parseDateISO(opts.anchorDate) ?? parseDateISO(opts.periodEnd);

  const transaction = resolveDateWithAnchor(input.transactionDate, anchor);
  const paid = resolveDateWithAnchor(input.paidDate, anchor);
  const due = resolveDateWithAnchor(input.dueDate, anchor);
  // Full dates only — see the MM-YY warning on resolvePartialDate.
  const effective = parseDateISO(input.effectiveDate);
  const periodEnd = parseDateISO(opts.periodEnd);

  const chain: [string | null, PdfRowDates["source"]][] = [
    [transaction, "transaction"],
    [paid, "paid"],
    [effective, "effective"],
    [due, "due"],
    [periodEnd, "period_end"],
  ];
  const hit = chain.find(([v]) => v !== null);

  return {
    transactionDate: hit ? hit[0] : null,
    effectiveDate: effective,
    paidDate: paid,
    source: hit ? hit[1] : "none",
  };
}

export type TxnType =
  | "advance" | "renewal" | "chargeback" | "adjustment"
  | "bonus" | "override" | "unknown";

export const TXN_TYPES: TxnType[] = ["advance", "renewal", "chargeback", "adjustment", "bonus", "override", "unknown"];

/**
 * Text meaning "this is first-year money", in the wordings carriers actually
 * print as a section heading.
 *
 * Split out of the advance pattern below because two callers need to ask this
 * exact question: `normalizeTxnType`, and `refineTxnTypeFromText`, which uses
 * it to overrule a model that called a first-year line a renewal. They are
 * mutually exclusive claims — first year is by definition not a renewal — so
 * the carrier's own printed heading settles it.
 *
 * `1st year` was the gap that shipped: an American-Amicable AGENT LEDGER
 * STATEMENT prints `ORDINARY LIFE - 1ST YEAR`, which matched nothing here, so
 * five real first-year lines were labelled renewal on a statement whose own
 * summary read TOTAL RENEWAL .00.
 */
export const FIRST_YEAR_RE = /(?:1st|first)\s*(?:year|yr)\b|\binitial\b|new\s*business/;

/**
 * A carrier's own word for what a line is, mapped onto our seven.
 *
 * The amount sign is a tiebreak, not the rule: a negative "commission" line is
 * a chargeback, but a line that already says "adjustment" stays an adjustment
 * whichever way it points.
 *
 * Order is load-bearing and unchanged: chargeback wins over everything, and a
 * negative amount still falls back to chargeback when nothing matched.
 */
export function normalizeTxnType(raw: unknown, amountCents: number | null = null): TxnType {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s) {
    if (/charge\s*-?\s*back|chgbk|cb\b|clawback|recover|reversal|reverse|refund|return/.test(s)) return "chargeback";
    if (/override|ovr\b|orid|hierarch|differential/.test(s)) return "override";
    if (/bonus|incentive|contest|production\s*credit/.test(s)) return "bonus";
    if (/renew|persist|residual|service\s*fee|trail/.test(s)) return "renewal";
    if (/advance|adv\b|fy\b/.test(s) || FIRST_YEAR_RE.test(s)) return "advance";
    if (/adjust|adj\b|correct|true\s*-?\s*up|misc|other|debt|balance/.test(s)) return "adjustment";
    if (/commission|comm\b|earned|paid/.test(s)) {
      return amountCents !== null && amountCents < 0 ? "chargeback" : "advance";
    }
  }
  if (amountCents !== null && amountCents < 0) return "chargeback";
  return "unknown";
}

/**
 * Let the carrier's PRINTED wording correct a model's classification.
 *
 * The PDF path is the only one that needs this. On the tabular path the model
 * returns a `type_map` keyed by the values actually printed in the sheet, and
 * `applyMapping` runs the printed value through `normalizeTxnType` when the
 * map misses — so the carrier's own words already get a vote. On the PDF path
 * the model returns nothing but the enum, so a misclassification is final and
 * silent, and there is no deterministic layer to catch it. This is that layer.
 *
 * Deliberately narrow. It does THREE things and nothing else:
 *
 *   1. A line the carrier printed under a FIRST-YEAR heading is `advance`,
 *      even if the model said `renewal`. Those are contradictory claims about
 *      the same line and the printed heading is the evidence.
 *   2. When the model gave up (`unknown`), fall back to reading the printed
 *      text the ordinary way.
 *   3. 🔴 NEGATIVE COMMISSION IS A CHARGEBACK WHATEVER SECTION IT SITS UNDER.
 *
 * Rule 3 is not decoration, it is a regression this round caused and caught.
 * A section heading is a PRODUCT CATEGORY, not a transaction-type word, and
 * `normalizeTxnType` deliberately treats the sign as a tiebreak only for lines
 * that do not name themselves — correct on the tabular path, where the type
 * column really does carry the carrier's own word and "Adjustment" must stay
 * an adjustment whichever way it points. On the PDF path the "type" now comes
 * from a heading like `ORDINARY LIFE - INITIAL`, so once the prompt taught the
 * model to answer `advance` for that heading, the −$41.33 chargeback on the
 * real statement stopped being caught by the sign and was booked as money
 * PAID OUT. The net still reconciled, so nothing would have complained; the
 * line would simply have left the Debt tab, which counts `chargeback` and
 * `adjustment` only. An advance that is negative is money coming back.
 *
 * It will NOT overrule a confident model answer in any other direction. A
 * negative `adjustment` stays an adjustment (a fee is not a chargeback, and
 * both already count as debt), and it never relabels an existing `chargeback`
 * — a product name containing "renewable" must not be able to undo one. That
 * last case is why this is not just `normalizeTxnType(printedText)`.
 */
export function refineTxnTypeFromText(
  modelType: unknown,
  printedText: unknown,
  amountCents: number | null = null,
): TxnType {
  const current = TXN_TYPES.includes(modelType as TxnType) ? modelType as TxnType : "unknown";
  const text = String(printedText ?? "").toLowerCase().trim();

  // Money taken back is settled by the money, not by a heading.
  if (current === "chargeback") return current;

  let out = current;
  if (text !== "") {
    if (FIRST_YEAR_RE.test(text) && (current === "renewal" || current === "unknown")) out = "advance";
    else if (current === "unknown") out = normalizeTxnType(text, amountCents);
  }

  // Rule 3. Commission paid to an agent cannot be negative; that is a reversal.
  if (amountCents !== null && amountCents < 0 && (out === "advance" || out === "renewal")) return "chargeback";
  return out;
}

/** Loose name normalization for fuzzy matching. "SMITH, JOHN A." -> "john a smith". */
export function normalizeName(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (s === "") return "";
  if (s.includes(",")) {
    const [last, ...rest] = s.split(",");
    s = `${rest.join(" ").trim()} ${last.trim()}`;
  }
  return s
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|dr|jr|sr|ii|iii|iv)\b\.?/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Policy numbers compare on alphanumerics only; carriers print separators inconsistently. */
export function normalizePolicyNumber(raw: unknown): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ============================================================
// 7. Applying a model-derived column mapping to every row.
// ============================================================

/** The canonical fields the AI is asked to locate. */
export const MAPPING_FIELDS = [
  "policy_number", "insured_name", "carrier", "producer_code", "product",
  "transaction_type", "amount", "premium", "commission_rate",
  "transaction_date", "effective_date", "paid_date",
] as const;
export type MappingField = typeof MAPPING_FIELDS[number];

export interface ColumnMapping {
  /** field -> zero-based column index in the sheet's rows. */
  columns: Partial<Record<MappingField, number>>;
  /** Carrier the whole sheet belongs to when no per-row column carries it. */
  carrier?: string | null;
  /** Statement-level dates when no per-row column carries them. */
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Verbatim value in the transaction-type column -> our canonical type. */
  typeMap?: Record<string, TxnType>;
  /** Column whose non-empty value means the row is a subtotal/footer to skip. */
  notes?: string | null;
}

export interface NormalizedRow {
  rowIndex: number;
  carrier: string | null;
  producerCode: string | null;
  policyNumber: string | null;
  insuredName: string | null;
  product: string | null;
  transactionType: TxnType;
  amountCents: number;
  premiumCents: number | null;
  commissionRate: number | null;
  transactionDate: string | null;
  effectiveDate: string | null;
  paidDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  raw: Record<string, string>;
}

const SUMMARY_ROW_RE = /^\s*(grand\s+)?(total|totals|subtotal|sub-total|sum|balance forward|page \d+|continued)\b/i;

/** True for the "TOTAL" line every carrier statement ends its sections with. */
export function isSummaryRow(cells: string[]): boolean {
  const filled = cells.filter((c) => String(c ?? "").trim() !== "");
  if (filled.length === 0) return true;
  if (filled.some((c) => SUMMARY_ROW_RE.test(String(c)))) return true;
  return false;
}

/**
 * Project a mapping onto a sheet. Pure, deterministic, and the reason a
 * 10,000-row statement costs exactly one API call: the model derives the
 * mapping once from a preview, and this applies it to everything.
 */
export function applyMapping(sheet: Sheet, preview: SheetPreview, mapping: ColumnMapping): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const cols = mapping.columns || {};
  const headers = preview.headers;
  const at = (cells: string[], f: MappingField): string => {
    const i = cols[f];
    if (i === undefined || i === null || i < 0) return "";
    return String(cells[i] ?? "").trim();
  };

  const body = sheet.rows.slice(preview.headerRowIndex + 1);
  for (let i = 0; i < body.length; i++) {
    const cells = body[i];
    if (isSummaryRow(cells)) continue;

    const amountCents = parseAmountCents(at(cells, "amount"));
    const policyNumber = at(cells, "policy_number") || null;
    const insuredName = at(cells, "insured_name") || null;

    // A row with neither an amount nor anything identifying is padding.
    if (amountCents === null && !policyNumber && !insuredName) continue;

    const rawTypeValue = at(cells, "transaction_type");
    const mapped = mapping.typeMap?.[rawTypeValue] ?? mapping.typeMap?.[rawTypeValue.toLowerCase()];
    const transactionType: TxnType = mapped && TXN_TYPES.includes(mapped)
      ? mapped
      : normalizeTxnType(rawTypeValue, amountCents);

    const raw: Record<string, string> = {};
    for (let c = 0; c < cells.length; c++) {
      const key = (headers[c] || "").trim() || `col_${c}`;
      const v = String(cells[c] ?? "").trim();
      if (v !== "") raw[key] = v.slice(0, 300);
    }

    const rate = at(cells, "commission_rate");
    const rateNum = rate ? Number(rate.replace(/[^0-9.\-]/g, "")) : NaN;

    // Every downstream screen — the trend chart, the persistency windows, the
    // debt drill-down — buckets on `transactionDate`. Plenty of carriers print
    // only a "Paid Date" or only an "Effective Date", and leaving the row with
    // no date at all would quietly drop it out of every one of those. Fall
    // back to the best date the line actually carries; the specific fields
    // stay exactly as printed alongside it.
    const effectiveDate = parseDateISO(at(cells, "effective_date"));
    const paidDate = parseDateISO(at(cells, "paid_date"));
    const transactionDate = parseDateISO(at(cells, "transaction_date")) ?? paidDate ?? effectiveDate;

    out.push({
      rowIndex: i,
      carrier: at(cells, "carrier") || mapping.carrier || null,
      producerCode: at(cells, "producer_code") || null,
      policyNumber,
      insuredName,
      product: at(cells, "product") || null,
      transactionType,
      amountCents: amountCents ?? 0,
      premiumCents: parseAmountCents(at(cells, "premium")),
      commissionRate: Number.isFinite(rateNum) ? rateNum : null,
      transactionDate,
      effectiveDate,
      paidDate,
      periodStart: mapping.periodStart ? parseDateISO(mapping.periodStart) : null,
      periodEnd: mapping.periodEnd ? parseDateISO(mapping.periodEnd) : null,
      raw,
    });
  }
  return out;
}

/**
 * One line as the model returns it from a PDF. Structural on purpose — the
 * concrete `PdfRow` lives in statement-ai.ts, which imports from here, so
 * naming it would close a circle.
 */
export interface PdfLineInput {
  policy_number?: string;
  insured_name?: string;
  product?: string;
  transaction_type?: string;
  transaction_type_text?: string;
  amount?: string;
  premium?: string;
  transaction_date?: string;
  paid_date?: string;
  effective_date?: string;
  due_date?: string;
  producer_code?: string;
}

/**
 * The PDF path's counterpart to `applyMapping` — model rows to NormalizedRow.
 *
 * It lives here rather than inline in statement-parse for the reason every
 * core block in this repo exists: the tests extract and execute this file, so
 * a projection written in the edge function is a projection no test runs. The
 * date chain and the type refinement are the two things this round changed and
 * both are decided here.
 */
export function normalizePdfRows(
  lines: PdfLineInput[],
  opts: {
    carrier?: string | null;
    /** The statement header's own date — the anchor for a `MM-DD` line date. */
    statementDate?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
  },
): NormalizedRow[] {
  const periodStart = opts.periodStart ?? null;
  const periodEnd = opts.periodEnd ?? null;
  const anchorDate = parseDateISO(opts.statementDate) ?? periodEnd ?? periodStart;

  return (lines || []).map((r, i) => {
    const amountCents = parseAmountCents(r.amount);

    const dates = resolvePdfRowDates({
      transactionDate: r.transaction_date,
      paidDate: r.paid_date,
      effectiveDate: r.effective_date,
      dueDate: r.due_date,
    }, { anchorDate, periodEnd });

    // The model's enum first, then let the carrier's own printed heading
    // correct a first-year line it called a renewal, or answer for it when it
    // gave up. See refineTxnTypeFromText for why this is not a free-for-all.
    const modelType = normalizeTxnType(r.transaction_type, amountCents);
    const printedType = String(r.transaction_type_text ?? "").trim() || String(r.product ?? "").trim();

    return {
      rowIndex: i,
      carrier: opts.carrier ?? null,
      producerCode: String(r.producer_code ?? "").trim() || null,
      policyNumber: String(r.policy_number ?? "").trim() || null,
      insuredName: String(r.insured_name ?? "").trim() || null,
      product: String(r.product ?? "").trim() || null,
      transactionType: refineTxnTypeFromText(modelType, printedType, amountCents),
      amountCents: amountCents ?? 0,
      premiumCents: parseAmountCents(r.premium),
      commissionRate: null,
      transactionDate: dates.transactionDate,
      effectiveDate: dates.effectiveDate,
      paidDate: dates.paidDate,
      periodStart,
      periodEnd,
      raw: r as unknown as Record<string, string>,
    } as NormalizedRow;
  }).filter((r) => r.policyNumber || r.insuredName || r.amountCents !== 0);
}

// ============================================================
// 8. Dedupe keys — the row-grain idempotency guarantee.
// ============================================================

/**
 * A stable, order-independent identity for a statement line, plus an
 * occurrence ordinal.
 *
 * The ordinal is the whole point. Two genuinely identical lines on one
 * statement (the same policy adjusted twice for the same amount on the same
 * day) are both real and must both survive; re-parsing that same statement
 * must still produce exactly those two keys and write nothing new. Counting
 * occurrences in row order gives both properties at once.
 *
 * `hash` is injected so this stays synchronous and pure — the callers supply
 * a real digest.
 */
export function buildDedupeKeys(
  rows: NormalizedRow[],
  hash: (s: string) => string,
): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const parts = [
      (r.carrier || "").toLowerCase().trim(),
      normalizePolicyNumber(r.policyNumber),
      normalizeName(r.insuredName),
      r.transactionDate || r.paidDate || r.effectiveDate || "",
      String(r.amountCents),
      r.transactionType,
    ].join("|");
    const n = (seen.get(parts) ?? 0) + 1;
    seen.set(parts, n);
    return hash(n === 1 ? parts : `${parts}#${n}`);
  });
}

// ============================================================
// 9. Matching a row to a policy. Pure — candidates are passed in.
// ============================================================

export interface PolicyCandidate {
  id: string;
  policyNumber: string | null;
  clientName: string | null;
  carrier: string | null;
}

export interface MatchResult {
  policyId: string | null;
  method: "policy_number" | "policy_number_suffix" | "name_carrier" | "name" | "none";
  confidence: number;
  reason?: string;
}

/**
 * Exact policy number first, then a masked-suffix match (Transamerica prints
 * `xxxxx76911`), then a unique normalized name match — preferring a candidate
 * on the same carrier. An ambiguous name never auto-matches; it goes to
 * review, which is the whole reason this returns a reason string.
 */
export function matchRowToPolicy(row: NormalizedRow, candidates: PolicyCandidate[]): MatchResult {
  const rowPol = normalizePolicyNumber(row.policyNumber);
  if (rowPol.length >= 4) {
    const exact = candidates.filter((c) => normalizePolicyNumber(c.policyNumber) === rowPol);
    if (exact.length === 1) return { policyId: exact[0].id, method: "policy_number", confidence: 1 };
    if (exact.length > 1) {
      return { policyId: null, method: "none", confidence: 0, reason: "more than one policy carries that policy number" };
    }
    // Masked numbers: match on the last 5 printed digits.
    const tail = rowPol.slice(-5);
    if (tail.length === 5 && /^\d+$/.test(tail)) {
      const suffix = candidates.filter((c) => {
        const p = normalizePolicyNumber(c.policyNumber);
        return p.length >= 5 && p.slice(-5) === tail;
      });
      if (suffix.length === 1) return { policyId: suffix[0].id, method: "policy_number_suffix", confidence: 0.9 };
    }
  }

  const rowName = normalizeName(row.insuredName);
  if (rowName.length >= 4) {
    const nameHits = candidates.filter((c) => normalizeName(c.clientName) === rowName);
    if (nameHits.length === 1) return { policyId: nameHits[0].id, method: "name", confidence: 0.75 };
    if (nameHits.length > 1) {
      const carrier = (row.carrier || "").toLowerCase().trim();
      if (carrier) {
        const sameCarrier = nameHits.filter((c) => (c.carrier || "").toLowerCase().trim() === carrier);
        if (sameCarrier.length === 1) {
          return { policyId: sameCarrier[0].id, method: "name_carrier", confidence: 0.8 };
        }
      }
      return { policyId: null, method: "none", confidence: 0, reason: `${nameHits.length} policies share that insured name` };
    }
  }

  if (!row.policyNumber && !row.insuredName) {
    return { policyId: null, method: "none", confidence: 0, reason: "the row carries neither a policy number nor an insured name" };
  }
  return { policyId: null, method: "none", confidence: 0, reason: "no policy in the tracker matches this line" };
}

// ============================================================
// 10. Carrier detection from free text (a fallback for when the sheet
// does not name the carrier in a column).
// ============================================================

const CARRIER_PATTERNS: [RegExp, string][] = [
  [/american[\s-]?amicable|am-?am\b/i, "American-Amicable"],
  [/americo/i, "Americo"],
  [/transamerica|\btrans\b/i, "Transamerica"],
  [/mutual of omaha|\bmoo\b|united of omaha/i, "Mutual of Omaha"],
  [/foresters/i, "Foresters Financial"],
  [/ethos|truestage/i, "Ethos / TrueStage"],
  [/corebridge|aig life|american general/i, "Corebridge"],
  [/aetna|accendo|\bcvs\b/i, "Aetna / Accendo"],
  [/chubb/i, "Chubb Life"],
  [/united home life|\buhl\b/i, "United Home Life"],
  [/american home life/i, "American Home Life"],
  [/\bsbli\b/i, "SBLI"],
  [/baltimore life/i, "Baltimore Life"],
  [/elco mutual/i, "Elco Mutual"],
  [/mutual trust/i, "Mutual Trust Life"],
  [/royal neighbors/i, "Royal Neighbors"],
  [/aflac/i, "Aflac"],
  [/liberty bankers/i, "Liberty Bankers"],
  [/gerber life/i, "Gerber Life"],
  [/prosperity life|\bsli\b/i, "Prosperity Life"],
  [/occidental|\bomaha ins/i, "Occidental Life"],
  [/national life group|\bnlg\b/i, "National Life Group"],
  [/protective life/i, "Protective Life"],
  [/prudential/i, "Prudential"],
  [/lincoln financial/i, "Lincoln Financial"],
  [/john hancock/i, "John Hancock"],
  [/legal\s*&?\s*general|banner life/i, "Legal & General"],
  [/kansas city life/i, "Kansas City Life"],
  [/north american company|north american for life/i, "North American"],
  [/allianz/i, "Allianz Life"],
  [/athene/i, "Athene"],
  [/principal (financial|life)/i, "Principal Financial"],
  [/northwestern mutual/i, "Northwestern Mutual"],
];

/** Best-effort carrier name from a filename or the top of a statement. */
export function sniffCarrier(text: string): string | null {
  const s = String(text ?? "");
  for (const [re, name] of CARRIER_PATTERNS) if (re.test(s)) return name;
  return null;
}

// ============================================================
// 11. Small helpers shared with the edge functions.
// ============================================================

/** Trim a grid to the rows/cols that actually hold something. */
export function trimGrid(rows: string[][]): string[][] {
  const out = rows.map((r) => r.map((c) => String(c ?? "")));
  while (out.length > 0 && out[out.length - 1].every((c) => c.trim() === "")) out.pop();
  return out;
}

/** A compact, token-cheap rendering of a preview for the model. */
export function previewToText(p: SheetPreview): string {
  const head = p.headers.map((h, i) => `${i}:${h || "(blank)"}`).join(" | ");
  const body = p.sampleRows
    .map((r, n) => `row ${n + 1}: ` + r.map((c, i) => `${i}=${c}`).filter((_, i) => r[i] !== "").join(" | "))
    .join("\n");
  return `Sheet: ${p.sheetName}\nTotal data rows: ${p.totalRows}\nHeader columns (index:name):\n${head}\n\nSample rows:\n${body}`;
}

// ============================================================
// 12. Statement-authoritative policy status (Back Office Phase 3).
//
// A carrier's own commission statement is better evidence about two things
// than anything else the app holds: that a policy PAID, and that a policy was
// CHARGED BACK. Both are facts about money that already moved, reported by the
// party that moved it. So statement ingestion is allowed to advance a policy's
// status — but only into those two, only forward, and only through
// policy_status_history so the agent can see what changed it and why.
//
// Deliberately NOT inferred: a LAPSE. Our seven transaction types have no
// "lapse", and the shapes that might imply one — a negative adjustment, a
// missing renewal — are also what an ordinary fee or a timing difference looks
// like. Guessing a lapse from a debit would mark live business dead on the
// strength of a bookkeeping line. A lapse still arrives through the
// carrier-email parser, which reads a carrier SAYING the policy lapsed.
// ============================================================

/** The statuses a policy is allowed to reach because a statement said so. */
export const STATEMENT_AUTHORITATIVE_STATUSES = ["paid", "chargeback"];

/** Statuses a "this paid" line may promote FROM. Never from an ended one. */
const PAYABLE_FROM = new Set(["pending", "approved", "issued"]);

/**
 * The status one statement line implies, or null for "leave the policy alone".
 *
 * A chargeback wins from any status except itself: money taken back is a
 * carrier fact, and refusing to record it because the tracker says "lapsed"
 * would hide a debt the agent owes. A payment only promotes from a status that
 * was still waiting to be paid, so a policy that has already lapsed or charged
 * back is never quietly resurrected by a trailing renewal line.
 */
export function nextPolicyStatusFromStatement(
  current: string | null | undefined,
  txnType: string,
  amountCents: number,
): string | null {
  const cur = current || "pending";
  if (txnType === "chargeback") return cur === "chargeback" ? null : "chargeback";
  if ((txnType === "advance" || txnType === "renewal") && amountCents > 0) {
    return PAYABLE_FROM.has(cur) ? "paid" : null;
  }
  return null;
}

export interface StatementStatusChange {
  policyId: string;
  from: string | null;
  to: string;
  reason: string;
}

/**
 * Fold a statement's matched lines into at most one status change per policy.
 *
 * Lines are applied in the order they appear, each against the status the
 * previous line left behind, which is what makes a chargeback sticky without a
 * special case: once a policy reads `chargeback`, a later advance line
 * evaluates to null rather than promoting it back to paid.
 *
 * Re-parsing an already-ingested statement produces NO changes, because every
 * line is evaluated against the status it already produced. That is the same
 * property the row-grain dedupe key gives the commission rows.
 */
export function planStatementStatusChanges(
  lines: Array<{ matched_policy_id?: string | null; transaction_type?: string; amount_cents?: number; policy_number?: string | null; insured_name?: string | null }>,
  currentStatusByPolicyId: Map<string, string | null>,
): StatementStatusChange[] {
  const started = new Map<string, string | null>();
  const working = new Map<string, string | null>();
  const reason = new Map<string, string>();

  for (const l of lines || []) {
    const id = l.matched_policy_id;
    if (!id) continue;
    if (!working.has(id)) {
      const cur = currentStatusByPolicyId.get(id) ?? null;
      started.set(id, cur);
      working.set(id, cur);
    }
    const next = nextPolicyStatusFromStatement(
      working.get(id), String(l.transaction_type || "unknown"), Number(l.amount_cents || 0),
    );
    if (!next) continue;
    working.set(id, next);
    reason.set(id, next === "chargeback"
      ? "A chargeback line on this statement"
      : "A commission payment on this statement");
  }

  const out: StatementStatusChange[] = [];
  for (const [id, end] of working) {
    const from = started.get(id) ?? null;
    if (!end || end === from) continue;
    out.push({ policyId: id, from, to: end, reason: reason.get(id) || "This statement" });
  }
  return out;
}

// ============================================================
// 13. Removing a statement, and re-reading one in place (FIX3).
//
// Two operations that move commission rows around without re-interpreting a
// single one of them. Nothing here parses, dates or types anything — that is
// sections 6-8's job and FIX2 settled it.
//
// WHY THIS EXISTS. `commission_rows` is UNIQUE (agent_id, dedupe_key) and the
// key is built (section 8) from carrier|policy|insured|DATE|amount|type plus an
// occurrence ordinal. The date is in there on purpose and must stay — but it
// means ANY parser improvement that changes a date, an amount or an ordinal
// re-fingerprints every line of every statement already ingested. The upsert
// uses ignoreDuplicates, so a re-read after such a fix does not update the old
// rows: it inserts a full second set BESIDE them. FIX2 turned nine null dates
// into real ones, so the owner's $262.45 statement would have re-read to
// $524.90. The dedupe key is correct. What was missing is a replace path.
// ============================================================

/**
 * The fields of an existing `commission_rows` row that a replace has to reason
 * about: the three that identify the line, and the ones a PERSON decided.
 */
export interface ExistingRowFacts {
  id?: string;
  policy_number: string | null;
  insured_name: string | null;
  amount_cents: number | null;
  review_status?: string | null;
  matched_policy_id?: string | null;
  match_method?: string | null;
  match_confidence?: number | null;
  review_reason?: string | null;
  review_note?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
}

/** What is copied onto a new row when its predecessor is recognised. */
export interface CarriedHandWork {
  review_status: string;
  matched_policy_id: string | null;
  match_method: string | null;
  match_confidence: number | null;
  review_reason: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface HandWorkCarry {
  /** Parallel to the new rows: hand work to apply, or null to leave the parse alone. */
  carried: (CarriedHandWork | null)[];
  /** How many resolved lines existed before the re-read. */
  handWorkBefore: number;
  carriedCount: number;
  /** Resolved lines whose replacement did not come back identical. Reported, never guessed at. */
  lostCount: number;
}

/**
 * HAND WORK IS A DECISION A PERSON MADE, not merely a populated column.
 *
 * `auto` / `needs_review` carrying a parser-proposed match is the PARSER's
 * opinion, and copying it forward would freeze a stale verdict on top of a
 * fresh one — a re-read exists precisely because the new parse knows more.
 * What carries is an approval, a rejection, or a match the agent chose by hand.
 */
export function rowCarriesHandWork(row: ExistingRowFacts): boolean {
  const st = String(row.review_status || "");
  return st === "approved" || st === "rejected" || row.match_method === "manual";
}

/**
 * The three-field identity a carry-over needs: policy number, insured name,
 * amount. All three, normalized with the SAME normalizers the dedupe key uses
 * (section 8) so a re-read that merely reformats a name is still recognised.
 *
 * Deliberately NOT the dedupe key: that carries the date and the type, which
 * are exactly what a parser fix is expected to change. A rule strict enough to
 * include them would carry nothing forward on the only statements that need it.
 */
export function handWorkCarryKey(row: ExistingRowFacts): string {
  return [
    normalizePolicyNumber(row.policy_number),
    normalizeName(row.insured_name),
    String(Number(row.amount_cents ?? 0)),
  ].join("|");
}

/**
 * Match old rows to new ones and say which decisions survive.
 *
 * 🔴 POSITIONAL WITHIN THE DUPLICATE GROUP. A carrier legitimately prints the
 * same line twice — the owner's own ledger has Browning $36.95 twice and Smith
 * $90.46 twice, identical on all three fields, which is why the dedupe key
 * carries an occurrence ordinal at all. First-match-wins would attach one
 * twin's approval to the other. So old rows are queued IN ORDER per key and
 * consumed in order.
 *
 * Every old row joins its queue, including ones carrying no hand work — the
 * queue models POSITION, and filtering first would shift an approved second
 * twin onto an untouched first one.
 */
export function carryStatementHandWork(
  oldRows: ExistingRowFacts[],
  newRows: ExistingRowFacts[],
): HandWorkCarry {
  const queues = new Map<string, ExistingRowFacts[]>();
  let handWorkBefore = 0;
  for (const r of oldRows || []) {
    const k = handWorkCarryKey(r);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k)!.push(r);
    if (rowCarriesHandWork(r)) handWorkBefore++;
  }

  const carried = (newRows || []).map((n) => {
    const q = queues.get(handWorkCarryKey(n));
    if (!q || q.length === 0) return null;
    const old = q.shift()!;
    if (!rowCarriesHandWork(old)) return null;
    return {
      review_status: String(old.review_status || "approved"),
      matched_policy_id: old.matched_policy_id ?? null,
      match_method: old.match_method ?? null,
      match_confidence: old.match_confidence ?? null,
      review_reason: old.review_reason ?? null,
      review_note: old.review_note ?? null,
      reviewed_at: old.reviewed_at ?? null,
      reviewed_by: old.reviewed_by ?? null,
    } as CarriedHandWork;
  });

  const carriedCount = carried.filter(Boolean).length;
  return { carried, handWorkBefore, carriedCount, lostCount: handWorkBefore - carriedCount };
}

// ------------------------------------------------------------
// The delete impact
// ------------------------------------------------------------

/** One policy this statement moved, as recorded in `policy_status_history`. */
export interface MovedPolicy {
  policy_id: string | null;
  policy_client_id: number | null;
  policy_number: string | null;
  insured_name: string | null;
  from_status: string | null;
  to_status: string | null;
  changed_at: string | null;
}

export interface StatementDeleteImpact {
  statement_id: string;
  filename: string;
  /** ZIP members. They cascade with the parent, so the confirmation has to count them. */
  child_count: number;
  child_filenames: string[];
  line_count: number;
  net_amount_cents: number;
  moved_policies: MovedPolicy[];
}

/**
 * Shape what a delete is about to remove, from rows already read out of the
 * database. Pure, so the arithmetic and the wording are testable.
 *
 * 🔴 `moved_policies` is REPORTED, NOT REVERTED (decision 1). Deleting a
 * statement removes the statement; it does not rewrite the book. A carrier
 * saying a policy was charged back stays true after the paperwork proving it is
 * removed, and `policy_status_history` is append-only by design — nothing here
 * may rewrite it. What the owner is owed is the LIST, so he can check those
 * policies himself.
 */
export function summarizeStatementDeletion(input: {
  statement: { id: string; filename?: string | null };
  children?: { id: string; filename?: string | null }[];
  rows?: { amount_cents?: number | null }[];
  /** History rows, oldest first. */
  history?: MovedPolicy[];
}): StatementDeleteImpact {
  const children = input.children || [];
  const rows = input.rows || [];
  return {
    statement_id: input.statement.id,
    filename: String(input.statement.filename || "this statement"),
    child_count: children.length,
    child_filenames: children.map((c) => String(c.filename || "file")),
    line_count: rows.length,
    net_amount_cents: rows.reduce((n, r) => n + Number(r.amount_cents || 0), 0),
    moved_policies: collapseMovedPolicies(input.history || []),
  };
}

/**
 * ONE ENTRY PER POLICY — the question is "which policies did this statement
 * move, and to what", not "how many rows are in the trail".
 *
 * A statement writes at most one history row per policy per parse, but a
 * re-read can write another if the status moved again in between, and the
 * confirmation listing the same person twice with the same status reads as a
 * bug rather than as history. Collapsed to `from` the EARLIEST change and `to`
 * the LATEST, which is what the statement actually did to that policy end to
 * end. Input is oldest-first, so the last one wins.
 *
 * The trail itself is untouched — this collapses the DISPLAY, not the record.
 */
export function collapseMovedPolicies(history: MovedPolicy[]): MovedPolicy[] {
  const out = new Map<string, MovedPolicy>();
  for (const h of history || []) {
    // A history row with no policy id cannot be collapsed against anything, and
    // dropping it would hide a change. Key it uniquely instead.
    const key = h.policy_id || `#${out.size}`;
    const seen = out.get(key);
    out.set(key, seen ? { ...h, from_status: seen.from_status } : h);
  }
  return [...out.values()];
}
