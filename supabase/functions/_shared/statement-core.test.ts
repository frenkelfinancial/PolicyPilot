// ============================================================
// statement-core.test.ts — run with:  npm run test:backoffice   (Node 24, no deps)
//
// The fixtures here are BUILT, not checked in as binaries: a real ZIP written
// with node:zlib's deflateRaw, a real XLSX assembled part by part, and a real
// OLE2/BIFF8 .xls written record by record. That is deliberate — a binary
// blob in the repo proves the parser handles that one blob; a generator proves
// it handles the format, and it fails loudly if the format assumptions drift.
//
// node:zlib is used ONLY in this test (to *write* the fixtures). The module
// under test decodes with its own pure-JS inflate and imports nothing.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

import {
  inflateRaw,
  readZip,
  readXlsx,
  readXls,
  readCsvGrid,
  sniffDelimiter,
  detectFileKind,
  findHeaderRow,
  previewSheet,
  previewToText,
  parseAmountCents,
  parseDateISO,
  normalizeTxnType,
  normalizeName,
  normalizePolicyNumber,
  colRefToIndex,
  isSummaryRow,
  applyMapping,
  buildDedupeKeys,
  matchRowToPolicy,
  sniffCarrier,
  tooLargeMessage,
  nextPolicyStatusFromStatement,
  planStatementStatusChanges,
  resolvePartialDate,
  resolveDateWithAnchor,
  resolvePdfRowDates,
  refineTxnTypeFromText,
  normalizePdfRows,
  carryStatementHandWork,
  rowCarriesHandWork,
  handWorkCarryKey,
  summarizeStatementDeletion,
  STATEMENT_AUTHORITATIVE_STATUSES,
  MAX_FILE_BYTES,
  type Sheet,
  type ColumnMapping,
  type NormalizedRow,
  type PdfLineInput,
} from "./statement-core.ts";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------
// Fixture builders
// ------------------------------------------------------------

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Minimal ZIP writer. `store` forces method 0 so the stored-block path is covered too. */
function buildZip(files: { name: string; data: Uint8Array }[], store = false): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const comp = store ? f.data : new Uint8Array(deflateRawSync(Buffer.from(f.data)));
    const method = store ? 0 : 8;
    const nameBytes = enc(f.name);
    const crc = crc32(f.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, method, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, comp.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, comp);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cen.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(10, method, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, comp.length, true);
    cdv.setUint32(24, f.data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + comp.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of all) { out.set(c, o); o += c.length; }
  return out;
}

/** A real .xlsx: shared strings, workbook, rels and one worksheet. */
function buildXlsx(sheetName: string, rows: (string | number)[][]): Uint8Array {
  const shared: string[] = [];
  const sharedIdx = new Map<string, number>();
  const sIdx = (s: string) => {
    if (!sharedIdx.has(s)) { sharedIdx.set(s, shared.length); shared.push(s); }
    return sharedIdx.get(s)!;
  };
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const colName = (i: number) => {
    let n = i + 1, s = "";
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  const rowXml = rows.map((r, ri) => {
    const cells = r.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
      if (v === "") return "";
      return `<c r="${ref}" t="s"><v>${sIdx(v)}</v></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join("");

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  const sstXml =
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("") + `</sst>`;
  const wbXml =
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relsXml =
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const ctXml =
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;

  return buildZip([
    { name: "[Content_Types].xml", data: enc(ctXml) },
    { name: "xl/workbook.xml", data: enc(wbXml) },
    { name: "xl/_rels/workbook.xml.rels", data: enc(relsXml) },
    { name: "xl/sharedStrings.xml", data: enc(sstXml) },
    { name: "xl/worksheets/sheet1.xml", data: enc(sheetXml) },
  ]);
}

/**
 * A real OLE2/BIFF8 .xls.
 *
 * Real Excel stores a stream shorter than the 4096-byte cutoff in the MINI
 * stream and a longer one in the ordinary FAT chain, and a reader that only
 * handles one of those fails on half the files it meets. `padRows` inflates
 * the workbook past the cutoff so both layouts get exercised by real fixtures
 * rather than by assertion.
 */
function buildXls(sheetName: string, rows: (string | number)[][]): Uint8Array {
  const recs: Uint8Array[] = [];
  const rec = (id: number, payload: Uint8Array) => {
    const r = new Uint8Array(4 + payload.length);
    new DataView(r.buffer).setUint16(0, id, true);
    new DataView(r.buffer).setUint16(2, payload.length, true);
    r.set(payload, 4);
    recs.push(r);
    return r;
  };
  const u8 = (n: number) => { const b = new Uint8Array(1); b[0] = n & 0xff; return b; };
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const le16 = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
  const le32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const f64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, n, true); return b; };
  /** BIFF8 short unicode string (1-byte cch), compressed (latin-1) form. */
  const shortStr = (s: string) => cat(u8(s.length), u8(0), new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff)));
  /** BIFF8 unicode string (2-byte cch), compressed form. */
  const longStr = (s: string) => cat(le16(s.length), u8(0), new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff)));

  // Shared string table
  const strings: string[] = [];
  const sIdx = new Map<string, number>();
  for (const r of rows) for (const v of r) {
    if (typeof v === "string" && v !== "" && !sIdx.has(v)) { sIdx.set(v, strings.length); strings.push(v); }
  }

  // --- Workbook globals substream
  rec(0x0809, cat(le16(0x0600), le16(0x0005), le16(0), le16(0), le32(0), le32(0)));
  const sstPayload = cat(le32(strings.length), le32(strings.length), ...strings.map(longStr));
  rec(0x00fc, sstPayload);
  const boundsheetIdx = recs.length;
  rec(0x0085, cat(le32(0), u8(0), u8(0), shortStr(sheetName))); // position patched below
  rec(0x000a, new Uint8Array(0));
  const globalsLen = recs.reduce((n, r) => n + r.length, 0);

  // --- Worksheet substream
  rec(0x0809, cat(le16(0x0600), le16(0x0010), le16(0), le16(0), le32(0), le32(0)));
  rows.forEach((r, ri) => {
    r.forEach((v, ci) => {
      if (v === "" || v === null || v === undefined) return;
      if (typeof v === "number") {
        // Alternate NUMBER and RK so both decoders are exercised.
        if (Number.isInteger(v) && Math.abs(v) < 1 << 29 && ci % 2 === 0) {
          rec(0x027e, cat(le16(ri), le16(ci), le16(0), le32(((v << 2) | 2) >>> 0)));
        } else {
          rec(0x0203, cat(le16(ri), le16(ci), le16(0), f64(v)));
        }
      } else {
        rec(0x00fd, cat(le16(ri), le16(ci), le16(0), le32(sIdx.get(v)!)));
      }
    });
  });
  rec(0x000a, new Uint8Array(0));

  // Patch BOUNDSHEET with the worksheet BOF offset.
  new DataView(recs[boundsheetIdx].buffer).setUint32(4, globalsLen, true);

  const workbook = cat(...recs);

  // --- Wrap in a CFB container: 512-byte sectors, one FAT sector.
  const SECTOR = 512;
  const MINI = 64;
  const CUTOFF = 4096;
  const useMini = workbook.length < CUTOFF;

  // Layout: 0 = FAT, 1 = directory, 2 = mini FAT (only when used), then payload.
  const payloadStart = useMini ? 3 : 2;
  const miniSectors = useMini ? Math.ceil(workbook.length / MINI) : 0;
  const payloadBytes = useMini ? miniSectors * MINI : workbook.length;
  const payloadSectors = Math.max(1, Math.ceil(payloadBytes / SECTOR));
  const totalSectors = payloadStart + payloadSectors;
  const out = new Uint8Array(SECTOR * (1 + totalSectors));
  const dv = new DataView(out.buffer);

  out.set(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 0);
  dv.setUint16(0x1e, 9, true);    // sector shift -> 512
  dv.setUint16(0x20, 6, true);    // mini sector shift -> 64
  dv.setUint32(0x2c, 1, true);    // 1 FAT sector
  dv.setUint32(0x30, 1, true);    // directory starts at sector 1
  dv.setUint32(0x38, CUTOFF, true);
  dv.setUint32(0x3c, useMini ? 2 : 0xfffffffe, true); // mini FAT sector
  dv.setUint32(0x40, useMini ? 1 : 0, true);          // mini FAT sector count
  dv.setUint32(0x44, 0xfffffffe, true);               // no DIFAT chain
  dv.setUint32(0x48, 0, true);
  dv.setUint32(0x4c, 0, true);    // DIFAT[0] = sector 0 holds the FAT
  for (let i = 1; i < 109; i++) dv.setUint32(0x4c + i * 4, 0xffffffff, true);

  const secOff = (s: number) => (s + 1) * SECTOR;

  // FAT: 0 = itself, 1 = directory, (2 = mini FAT), then the payload chain.
  const fat = new DataView(out.buffer, secOff(0), SECTOR);
  for (let i = 0; i < SECTOR / 4; i++) fat.setUint32(i * 4, 0xffffffff, true);
  fat.setUint32(0, 0xfffffffd, true);
  fat.setUint32(4, 0xfffffffe, true);
  if (useMini) fat.setUint32(8, 0xfffffffe, true);
  for (let i = 0; i < payloadSectors; i++) {
    const s = payloadStart + i;
    fat.setUint32(s * 4, i === payloadSectors - 1 ? 0xfffffffe : s + 1, true);
  }

  // Mini FAT: one chained entry per mini sector of the workbook stream.
  if (useMini) {
    const mfat = new DataView(out.buffer, secOff(2), SECTOR);
    for (let i = 0; i < SECTOR / 4; i++) mfat.setUint32(i * 4, 0xffffffff, true);
    for (let i = 0; i < miniSectors; i++) {
      mfat.setUint32(i * 4, i === miniSectors - 1 ? 0xfffffffe : i + 1, true);
    }
  }

  // Directory: entry 0 root (owns the mini stream), entry 1 "Workbook".
  const dirBase = secOff(1);
  const writeDir = (idx: number, name: string, type: number, start: number, size: number) => {
    const o = dirBase + idx * 128;
    for (let i = 0; i < name.length; i++) dv.setUint16(o + i * 2, name.charCodeAt(i), true);
    dv.setUint16(o + 0x40, name ? (name.length + 1) * 2 : 0, true);
    out[o + 0x42] = type;
    dv.setUint32(o + 0x44, 0xffffffff, true);
    dv.setUint32(o + 0x48, 0xffffffff, true);
    dv.setUint32(o + 0x4c, 0xffffffff, true);
    dv.setUint32(o + 0x74, start, true);
    dv.setUint32(o + 0x78, size, true);
  };
  for (let i = 0; i < 4; i++) writeDir(i, "", 0, 0xffffffff, 0);
  writeDir(0, "Root Entry", 5, useMini ? payloadStart : 0xfffffffe, useMini ? payloadBytes : 0);
  writeDir(1, "Workbook", 2, useMini ? 0 : payloadStart, workbook.length);

  out.set(workbook, secOff(payloadStart));
  return out;
}

// ============================================================
// inflate
// ============================================================

test("inflateRaw round-trips a real deflate stream", () => {
  const original = "policy,insured,amount\n".repeat(200) + "BU1,Jane Smith,1234.56\n";
  const compressed = new Uint8Array(deflateRawSync(Buffer.from(original)));
  assert.ok(compressed.length < original.length, "fixture should actually be compressed");
  assert.equal(Buffer.from(inflateRaw(compressed)).toString("utf8"), original);
});

test("inflateRaw handles a stored (uncompressed) block", () => {
  const original = "tiny";
  const compressed = new Uint8Array(deflateRawSync(Buffer.from(original), { level: 0 }));
  assert.equal(Buffer.from(inflateRaw(compressed)).toString("utf8"), original);
});

test("inflateRaw handles binary bytes and long back-references", () => {
  const bytes = new Uint8Array(50_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 8)) & 0xff;
  const round = inflateRaw(new Uint8Array(deflateRawSync(Buffer.from(bytes))));
  assert.equal(round.length, bytes.length);
  assert.ok(Buffer.from(round).equals(Buffer.from(bytes)));
});

// ============================================================
// zip
// ============================================================

test("readZip reads deflated members", () => {
  const zip = buildZip([
    { name: "a.csv", data: enc("one,two\n1,2\n") },
    { name: "nested/b.csv", data: enc("three\n3\n") },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ["a.csv", "nested/b.csv"]);
  assert.equal(Buffer.from(entries[0].bytes).toString(), "one,two\n1,2\n");
  assert.equal(Buffer.from(entries[1].bytes).toString(), "three\n3\n");
});

test("readZip reads stored members", () => {
  const zip = buildZip([{ name: "a.csv", data: enc("x,y\n1,2\n") }], true);
  assert.equal(Buffer.from(readZip(zip)[0].bytes).toString(), "x,y\n1,2\n");
});

test("readZip refuses an archive with too many members", () => {
  const files = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.csv`, data: enc("a\n1\n") }));
  assert.throws(() => readZip(buildZip(files), { maxMembers: 3 }), /more than 3 files/);
});

test("readZip refuses a zip bomb by uncompressed size", () => {
  const zip = buildZip([{ name: "big.csv", data: enc("a".repeat(100_000)) }]);
  assert.throws(() => readZip(zip, { maxTotalBytes: 1000 }), /expands to more than/);
});

// ============================================================
// xlsx
// ============================================================

test("readXlsx reads a real workbook, shared strings and numbers", () => {
  const xlsx = buildXlsx("Commissions", [
    ["Policy", "Insured", "Amount"],
    ["BU6691749", "Jane Smith", 1234.56],
    ["BU6691750", "John Doe", -75],
  ]);
  const sheets = readXlsx(xlsx);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, "Commissions");
  assert.deepEqual(sheets[0].rows[0], ["Policy", "Insured", "Amount"]);
  assert.deepEqual(sheets[0].rows[1], ["BU6691749", "Jane Smith", "1234.56"]);
  assert.equal(sheets[0].rows[2][2], "-75");
});

test("readXlsx keeps column positions when a cell is skipped", () => {
  // No B2 cell at all — the reader must not shift C2 left into B2.
  const xlsx = buildXlsx("S", [["A", "B", "C"], ["a1", "", "c1"]]);
  const rows = readXlsx(xlsx)[0].rows;
  assert.deepEqual(rows[1], ["a1", "", "c1"]);
});

test("readXlsx unescapes XML entities in shared strings", () => {
  const xlsx = buildXlsx("S", [["Name"], ["Smith & Sons <LLC>"]]);
  assert.equal(readXlsx(xlsx)[0].rows[1][0], "Smith & Sons <LLC>");
});

// ============================================================
// xls (BIFF8)
// ============================================================

test("readXls reads a real BIFF8 workbook", () => {
  const xls = buildXls("Statement", [
    ["Policy", "Insured", "Amount"],
    ["BU6691749", "Jane Smith", 1234.56],
    ["BU6691750", "John Doe", 40],
  ]);
  const sheets = readXls(xls);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, "Statement");
  assert.deepEqual(sheets[0].rows[0], ["Policy", "Insured", "Amount"]);
  assert.equal(sheets[0].rows[1][0], "BU6691749");
  assert.equal(sheets[0].rows[1][1], "Jane Smith");
  assert.equal(Number(sheets[0].rows[1][2]).toFixed(2), "1234.56");
});

test("readXls decodes RK-compressed integers", () => {
  // Column 2 is even, so buildXls emits an RK record rather than a NUMBER.
  const xls = buildXls("S", [["A", "B", "C"], ["x", "y", 40]]);
  assert.equal(readXls(xls)[0].rows[1][2], "40");
});

test("readXls reads a workbook stored in the FAT chain, not the mini stream", () => {
  // >4096 bytes, so Excel would put this one in the ordinary sector chain.
  const rows: (string | number)[][] = [["Policy", "Insured", "Amount"]];
  for (let i = 0; i < 400; i++) rows.push([`BU${100000 + i}`, `Client Number ${i}`, i * 1.25]);
  const sheets = readXls(buildXls("Big", rows));
  assert.equal(sheets[0].name, "Big");
  assert.equal(sheets[0].rows.length, 401);
  assert.equal(sheets[0].rows[400][0], "BU100399");
  assert.equal(Number(sheets[0].rows[400][2]).toFixed(2), "498.75");
});

test("readXls rejects a file that is not an OLE2 container", () => {
  assert.throws(() => readXls(enc("just some text")), /not an OLE2 container/);
});

// ============================================================
// csv
// ============================================================

test("readCsvGrid keeps positions, including blank cells", () => {
  const grid = readCsvGrid("a,b,c\n1,,3\n");
  assert.deepEqual(grid, [["a", "b", "c"], ["1", "", "3"]]);
});

test("readCsvGrid handles quoted commas and doubled quotes", () => {
  const grid = readCsvGrid('policy,insured\nBU1,"Smith, Jane"\nBU2,"She said ""hi"""\n');
  assert.equal(grid[1][1], "Smith, Jane");
  assert.equal(grid[2][1], 'She said "hi"');
});

test("readCsvGrid strips a UTF-8 BOM", () => {
  assert.equal(readCsvGrid("policy,amount\nBU1,10\n")[0][0], "policy");
});

test("sniffDelimiter picks semicolons and tabs over commas when they are the real delimiter", () => {
  assert.equal(sniffDelimiter("a;b;c\n1;2;3\n4;5;6\n"), ";");
  assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3\n"), "\t");
  assert.equal(sniffDelimiter("a,b,c\n1,2,3\n"), ",");
});

test("readCsvGrid follows the sniffed delimiter", () => {
  assert.deepEqual(readCsvGrid("policy;insured\nBU1;Jane\n"), [["policy", "insured"], ["BU1", "Jane"]]);
});

// ============================================================
// file-kind detection
// ============================================================

test("detectFileKind reads magic bytes, not the extension", () => {
  assert.equal(detectFileKind("statement.xlsx", enc("%PDF-1.7\nstuff")), "pdf");
  assert.equal(detectFileKind("statement.pdf", enc("a,b\n1,2\n")), "csv");
});

test("detectFileKind tells an xlsx from a plain zip by its contents", () => {
  assert.equal(detectFileKind("book.zip", buildXlsx("S", [["A"], ["1"]])), "xlsx");
  assert.equal(detectFileKind("archive.xlsx", buildZip([{ name: "a.csv", data: enc("a\n1\n") }])), "zip");
});

test("detectFileKind recognises an OLE2 .xls", () => {
  assert.equal(detectFileKind("old.xls", buildXls("S", [["A"], ["1"]])), "xls");
});

test("detectFileKind falls back to unknown for binary junk", () => {
  const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x7f, 0x80]);
  assert.equal(detectFileKind("mystery.bin", junk), "unknown");
});

// ============================================================
// header detection
// ============================================================

test("findHeaderRow skips a carrier's letterhead preamble", () => {
  const rows = [
    ["AMERICO FINANCIAL LIFE", "", "", ""],
    ["PO Box 410288, Kansas City MO", "", "", ""],
    ["", "", "", ""],
    ["Statement period: 07/01/2026 - 07/31/2026", "", "", ""],
    ["Policy Number", "Insured Name", "Commission Amount", "Paid Date"],
    ["BU6691749", "Jane Smith", "1,234.56", "07/15/2026"],
    ["BU6691750", "John Doe", "(75.00)", "07/15/2026"],
  ];
  assert.equal(findHeaderRow(rows), 4);
});

test("findHeaderRow returns 0 when the header really is the first row", () => {
  assert.equal(findHeaderRow([["Policy", "Insured", "Amount"], ["A", "B", "1"]]), 0);
});

test("previewSheet reports the header, samples and total row count", () => {
  const sheet: Sheet = {
    name: "S",
    rows: [
      ["Carrier statement", "", ""],
      ["Policy", "Insured", "Amount"],
      ...Array.from({ length: 30 }, (_, i) => [`P${i}`, `Name ${i}`, String(i)]),
    ],
  };
  const p = previewSheet(sheet, 5);
  assert.equal(p.headerRowIndex, 1);
  assert.deepEqual(p.headers, ["Policy", "Insured", "Amount"]);
  assert.equal(p.totalRows, 30);
  assert.equal(p.sampleRows.length, 5);
  assert.match(previewToText(p), /0:Policy \| 1:Insured \| 2:Amount/);
});

test("colRefToIndex handles multi-letter columns", () => {
  assert.equal(colRefToIndex("A"), 0);
  assert.equal(colRefToIndex("Z"), 25);
  assert.equal(colRefToIndex("AA"), 26);
  assert.equal(colRefToIndex("BC"), 54);
});

// ============================================================
// normalizers
// ============================================================

test("parseAmountCents handles the shapes carriers actually print", () => {
  assert.equal(parseAmountCents("$1,234.56"), 123456);
  assert.equal(parseAmountCents("1234.56"), 123456);
  assert.equal(parseAmountCents("(75.00)"), -7500);
  assert.equal(parseAmountCents("-75"), -7500);
  assert.equal(parseAmountCents("75.00-"), -7500);
  assert.equal(parseAmountCents("1.234,56"), 123456);
  assert.equal(parseAmountCents("$0.00"), 0);
  assert.equal(parseAmountCents(1234.56), 123456);
  assert.equal(parseAmountCents("120.50 CR"), -12050);
});

test("parseAmountCents distinguishes 'no amount' from zero", () => {
  assert.equal(parseAmountCents(""), null);
  assert.equal(parseAmountCents("   "), null);
  assert.equal(parseAmountCents("N/A"), null);
  assert.equal(parseAmountCents(null), null);
  assert.equal(parseAmountCents("0"), 0);
});

test("parseAmountCents rounds to whole cents rather than carrying float error", () => {
  assert.equal(parseAmountCents("0.145"), 15);
  assert.equal(parseAmountCents(19.99 * 3), 5997);
});

test("parseDateISO reads every common carrier date format", () => {
  assert.equal(parseDateISO("2026-07-15"), "2026-07-15");
  assert.equal(parseDateISO("07/15/2026"), "2026-07-15");
  assert.equal(parseDateISO("7/5/26"), "2026-07-05");
  assert.equal(parseDateISO("15-Jul-2026"), "2026-07-15");
  assert.equal(parseDateISO("July 15, 2026"), "2026-07-15");
  assert.equal(parseDateISO("20260715"), "2026-07-15");
  assert.equal(parseDateISO(""), null);
  assert.equal(parseDateISO("not a date"), null);
});

test("parseDateISO reads an Excel serial date", () => {
  // 45000 = 2023-03-15 in the 1900 date system.
  assert.equal(parseDateISO("45000"), "2023-03-15");
  assert.equal(parseDateISO(" 46234 "), "2026-07-31");
});

test("normalizeTxnType reads the carrier's own vocabulary", () => {
  assert.equal(normalizeTxnType("Chargeback"), "chargeback");
  assert.equal(normalizeTxnType("CHGBK"), "chargeback");
  assert.equal(normalizeTxnType("Reversal"), "chargeback");
  assert.equal(normalizeTxnType("Renewal Commission"), "renewal");
  assert.equal(normalizeTxnType("First Year Advance"), "advance");
  assert.equal(normalizeTxnType("Override"), "override");
  assert.equal(normalizeTxnType("Production Bonus"), "bonus");
  assert.equal(normalizeTxnType("Adjustment"), "adjustment");
});

test("normalizeTxnType uses the sign only as a tiebreak", () => {
  // A bare "Commission" line is decided by its sign...
  assert.equal(normalizeTxnType("Commission", -5000), "chargeback");
  assert.equal(normalizeTxnType("Commission", 5000), "advance");
  // ...but a line that names itself keeps its own name whichever way it points.
  assert.equal(normalizeTxnType("Adjustment", -5000), "adjustment");
  assert.equal(normalizeTxnType("Renewal", -100), "renewal");
  // Nothing to go on at all.
  assert.equal(normalizeTxnType("", null), "unknown");
  assert.equal(normalizeTxnType("", -100), "chargeback");
});

test("normalizeName folds 'LAST, FIRST' and drops honorifics", () => {
  assert.equal(normalizeName("SMITH, JOHN A."), "john a smith");
  assert.equal(normalizeName("Mr. John Smith Jr."), "john smith");
  assert.equal(normalizeName("  Jane   Doe  "), "jane doe");
  assert.equal(normalizeName(""), "");
});

test("normalizePolicyNumber compares on alphanumerics only", () => {
  assert.equal(normalizePolicyNumber("bu-669 1749"), "BU6691749");
  assert.equal(normalizePolicyNumber("xxxxx76911"), "XXXXX76911");
});

test("isSummaryRow catches totals and blank padding", () => {
  assert.equal(isSummaryRow(["Total", "", "1,234.56"]), true);
  assert.equal(isSummaryRow(["GRAND TOTAL", "", "9"]), true);
  assert.equal(isSummaryRow(["", "", ""]), true);
  assert.equal(isSummaryRow(["BU1", "Jane Smith", "12.00"]), false);
});

test("sniffCarrier recognises carriers from a filename or letterhead", () => {
  assert.equal(sniffCarrier("americo_commissions_july.csv"), "Americo");
  assert.equal(sniffCarrier("AMERICAN-AMICABLE LIFE INSURANCE"), "American-Amicable");
  assert.equal(sniffCarrier("Mutual of Omaha statement"), "Mutual of Omaha");
  assert.equal(sniffCarrier("random file"), null);
});

test("tooLargeMessage names the real size and the cap, in plain words", () => {
  const msg = tooLargeMessage("big.pdf", MAX_FILE_BYTES * 2);
  assert.match(msg, /big\.pdf is 20\.0 MB/);
  assert.match(msg, /limit is 10 MB per file/);
});

// ============================================================
// applyMapping
// ============================================================

const SAMPLE_SHEET: Sheet = {
  name: "Commissions",
  rows: [
    ["AMERICO — Commission Statement", "", "", "", ""],
    ["Policy", "Insured", "Type", "Amount", "Paid"],
    ["BU6691749", "Smith, Jane", "First Year", "$1,234.56", "07/15/2026"],
    ["BU6691750", "Doe, John", "Chargeback", "(75.00)", "07/15/2026"],
    ["BU6691751", "Roe, Mary", "Renewal", "42.00", "07/15/2026"],
    ["", "", "TOTAL", "1,201.56", ""],
  ],
};

const SAMPLE_MAPPING: ColumnMapping = {
  columns: { policy_number: 0, insured_name: 1, transaction_type: 2, amount: 3, paid_date: 4 },
  carrier: "Americo",
  typeMap: { "First Year": "advance", "Chargeback": "chargeback", "Renewal": "renewal" },
};

test("applyMapping projects the mapping onto every row", () => {
  const preview = previewSheet(SAMPLE_SHEET);
  const rows = applyMapping(SAMPLE_SHEET, preview, SAMPLE_MAPPING);
  assert.equal(rows.length, 3, "the TOTAL row is dropped");
  assert.equal(rows[0].policyNumber, "BU6691749");
  assert.equal(rows[0].insuredName, "Smith, Jane");
  assert.equal(rows[0].transactionType, "advance");
  assert.equal(rows[0].amountCents, 123456);
  assert.equal(rows[0].paidDate, "2026-07-15");
  assert.equal(rows[0].carrier, "Americo", "sheet-level carrier fills in");
  assert.equal(rows[1].transactionType, "chargeback");
  assert.equal(rows[1].amountCents, -7500);
  assert.equal(rows[2].transactionType, "renewal");
});

test("applyMapping gives every row a transaction date, falling back to what the line actually carries", () => {
  // Found by the live end-to-end run: a carrier that prints only "Paid Date"
  // produced rows with a null transaction_date, which is the column the trend
  // chart, the persistency windows and the debt drill-down all bucket on —
  // every such row would have silently vanished from all three.
  const preview = previewSheet(SAMPLE_SHEET);
  const rows = applyMapping(SAMPLE_SHEET, preview, SAMPLE_MAPPING);
  assert.equal(rows[0].transactionDate, "2026-07-15", "falls back to the paid date");
  assert.equal(rows[0].paidDate, "2026-07-15", "and the paid date is still recorded as itself");

  // An explicit transaction-date column always wins over the fallback.
  const sheet: Sheet = {
    name: "S",
    rows: [
      ["Policy", "Amount", "Trade Date", "Paid"],
      ["BU1", "10.00", "07/01/2026", "07/15/2026"],
    ],
  };
  const r = applyMapping(sheet, previewSheet(sheet), {
    columns: { policy_number: 0, amount: 1, transaction_date: 2, paid_date: 3 },
  });
  assert.equal(r[0].transactionDate, "2026-07-01");
  assert.equal(r[0].paidDate, "2026-07-15");

  // Effective date is the last resort, not a peer of the paid date.
  const sheet2: Sheet = { name: "S", rows: [["Policy", "Amount", "Effective"], ["BU1", "10.00", "06/02/2026"]] };
  const r2 = applyMapping(sheet2, previewSheet(sheet2), {
    columns: { policy_number: 0, amount: 1, effective_date: 2 },
  });
  assert.equal(r2[0].transactionDate, "2026-06-02");
  assert.equal(r2[0].effectiveDate, "2026-06-02");

  // No date anywhere stays null rather than inventing today.
  const sheet3: Sheet = { name: "S", rows: [["Policy", "Amount"], ["BU1", "10.00"]] };
  const r3 = applyMapping(sheet3, previewSheet(sheet3), { columns: { policy_number: 0, amount: 1 } });
  assert.equal(r3[0].transactionDate, null);
});

test("applyMapping keeps the source row verbatim in `raw`", () => {
  const preview = previewSheet(SAMPLE_SHEET);
  const rows = applyMapping(SAMPLE_SHEET, preview, SAMPLE_MAPPING);
  assert.deepEqual(rows[0].raw, {
    Policy: "BU6691749", Insured: "Smith, Jane", Type: "First Year", Amount: "$1,234.56", Paid: "07/15/2026",
  });
});

test("applyMapping falls back to the vocabulary reader when the type map misses a value", () => {
  const mapping: ColumnMapping = { ...SAMPLE_MAPPING, typeMap: {} };
  const rows = applyMapping(SAMPLE_SHEET, previewSheet(SAMPLE_SHEET), mapping);
  assert.equal(rows[0].transactionType, "advance");
  assert.equal(rows[1].transactionType, "chargeback");
});

test("applyMapping drops padding rows but keeps a zero-amount row that identifies a policy", () => {
  const sheet: Sheet = {
    name: "S",
    rows: [
      ["Policy", "Insured", "Amount"],
      ["BU1", "Jane Smith", "0.00"],
      ["", "", ""],
      ["", "", "  "],
    ],
  };
  const rows = applyMapping(sheet, previewSheet(sheet), {
    columns: { policy_number: 0, insured_name: 1, amount: 2 },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountCents, 0);
});

// ============================================================
// dedupe keys
// ============================================================

function rowsFor(spec: Partial<NormalizedRow>[]): NormalizedRow[] {
  return spec.map((s, i) => ({
    rowIndex: i, carrier: "Americo", producerCode: null, policyNumber: "BU1",
    insuredName: "Jane Smith", product: null, transactionType: "advance",
    amountCents: 1000, premiumCents: null, commissionRate: null,
    transactionDate: "2026-07-15", effectiveDate: null, paidDate: null,
    periodStart: null, periodEnd: null, raw: {}, ...s,
  } as NormalizedRow));
}

test("buildDedupeKeys is stable across re-parses of the same statement", () => {
  const rows = rowsFor([{}, { policyNumber: "BU2" }, { amountCents: 2000 }]);
  assert.deepEqual(buildDedupeKeys(rows, sha), buildDedupeKeys(rows, sha));
});

test("buildDedupeKeys gives two genuinely identical lines distinct keys", () => {
  const keys = buildDedupeKeys(rowsFor([{}, {}, {}]), sha);
  assert.equal(new Set(keys).size, 3, "three identical lines must survive as three rows");
});

test("buildDedupeKeys re-derives those same ordinals on a re-parse", () => {
  const a = buildDedupeKeys(rowsFor([{}, {}]), sha);
  const b = buildDedupeKeys(rowsFor([{}, {}]), sha);
  assert.deepEqual(a, b, "a re-upload writes nothing new");
});

test("buildDedupeKeys ignores cosmetic differences the carrier may change", () => {
  const a = buildDedupeKeys(rowsFor([{ policyNumber: "BU-1", insuredName: "SMITH, JANE" }]), sha);
  const b = buildDedupeKeys(rowsFor([{ policyNumber: "bu 1", insuredName: "Jane Smith" }]), sha);
  assert.deepEqual(a, b);
});

test("buildDedupeKeys separates rows that differ in any identity field", () => {
  const base = rowsFor([{}])[0];
  const variants: NormalizedRow[] = [
    base,
    { ...base, amountCents: 1001 },
    { ...base, transactionDate: "2026-07-16" },
    { ...base, transactionType: "chargeback" },
    { ...base, carrier: "Transamerica" },
    { ...base, policyNumber: "BU2" },
  ];
  assert.equal(new Set(buildDedupeKeys(variants, sha)).size, variants.length);
});

// ============================================================
// matching
// ============================================================

const CANDIDATES = [
  { id: "p1", policyNumber: "BU6691749", clientName: "Jane Smith", carrier: "Americo" },
  { id: "p2", policyNumber: "TA5551234", clientName: "John Doe", carrier: "Transamerica" },
  { id: "p3", policyNumber: null, clientName: "Mary Roe", carrier: "Americo" },
  { id: "p4", policyNumber: null, clientName: "Mary Roe", carrier: "Transamerica" },
];

const row = (o: Partial<NormalizedRow>) => rowsFor([o])[0];

test("matchRowToPolicy matches an exact policy number", () => {
  const m = matchRowToPolicy(row({ policyNumber: "bu-669 1749", insuredName: null }), CANDIDATES);
  assert.equal(m.policyId, "p1");
  assert.equal(m.method, "policy_number");
  assert.equal(m.confidence, 1);
});

test("matchRowToPolicy matches a carrier-masked number on its last five digits", () => {
  const m = matchRowToPolicy(row({ policyNumber: "xxxxx51234", insuredName: null }), CANDIDATES);
  assert.equal(m.policyId, "p2");
  assert.equal(m.method, "policy_number_suffix");
});

test("matchRowToPolicy matches a unique insured name when there is no policy number", () => {
  const m = matchRowToPolicy(row({ policyNumber: null, insuredName: "SMITH, JANE" }), CANDIDATES);
  assert.equal(m.policyId, "p1");
  assert.equal(m.method, "name");
});

test("matchRowToPolicy uses the carrier to break a name tie", () => {
  const m = matchRowToPolicy(
    row({ policyNumber: null, insuredName: "Mary Roe", carrier: "Transamerica" }),
    CANDIDATES,
  );
  assert.equal(m.policyId, "p4");
  assert.equal(m.method, "name_carrier");
});

test("matchRowToPolicy refuses an ambiguous name and says why", () => {
  const m = matchRowToPolicy(row({ policyNumber: null, insuredName: "Mary Roe", carrier: null }), CANDIDATES);
  assert.equal(m.policyId, null);
  assert.match(m.reason!, /2 policies share that insured name/);
});

test("matchRowToPolicy never silently matches nothing", () => {
  const none = matchRowToPolicy(row({ policyNumber: "ZZ999", insuredName: "Nobody Here" }), CANDIDATES);
  assert.equal(none.policyId, null);
  assert.ok(none.reason, "an unmatched row always carries a reason for the review queue");

  const empty = matchRowToPolicy(row({ policyNumber: null, insuredName: null }), CANDIDATES);
  assert.match(empty.reason!, /neither a policy number nor an insured name/);
});

// ============================================================
// end-to-end through the pure layer
// ============================================================

test("a whole XLSX statement flows through preview -> mapping -> rows -> keys -> match", () => {
  const xlsx = buildXlsx("July", [
    ["AMERICO FINANCIAL LIFE", "", "", "", ""],
    ["Statement period 07/01/2026 - 07/31/2026", "", "", "", ""],
    ["Policy Number", "Insured Name", "Transaction", "Commission", "Paid Date"],
    ["BU6691749", "Smith, Jane", "First Year", 1234.56, "07/15/2026"],
    ["TA5551234", "Doe, John", "Chargeback", -75, "07/15/2026"],
    ["", "", "Total", 1159.56, ""],
  ]);
  const sheet = readXlsx(xlsx)[0];
  const preview = previewSheet(sheet);
  assert.equal(preview.headerRowIndex, 2);

  const rows = applyMapping(sheet, preview, {
    columns: { policy_number: 0, insured_name: 1, transaction_type: 2, amount: 3, paid_date: 4 },
    carrier: "Americo",
    typeMap: { "First Year": "advance", "Chargeback": "chargeback" },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amountCents, 123456);
  assert.equal(rows[1].amountCents, -7500);
  assert.equal(rows[1].transactionType, "chargeback");

  const keys = buildDedupeKeys(rows, sha);
  assert.equal(new Set(keys).size, 2);

  assert.equal(matchRowToPolicy(rows[0], CANDIDATES).policyId, "p1");
  assert.equal(matchRowToPolicy(rows[1], CANDIDATES).policyId, "p2");
});

test("a ZIP of statements yields each member for its own pass", () => {
  const zip = buildZip([
    { name: "americo.csv", data: enc("Policy,Insured,Amount\nBU1,Jane Smith,10.00\n") },
    { name: "trans.xlsx", data: buildXlsx("S", [["Policy", "Insured", "Amount"], ["TA1", "John Doe", 20]]) },
  ]);
  assert.equal(detectFileKind("batch.zip", zip), "zip");
  const members = readZip(zip);
  assert.equal(members.length, 2);
  assert.equal(detectFileKind(members[0].name, members[0].bytes), "csv");
  assert.equal(detectFileKind(members[1].name, members[1].bytes), "xlsx");
  assert.equal(readXlsx(members[1].bytes)[0].rows[1][0], "TA1");
});

// ============================================================
// Statement-authoritative policy status (Back Office Phase 3)
// ============================================================

test("a statement may only move a policy into paid or chargeback", () => {
  assert.deepEqual(STATEMENT_AUTHORITATIVE_STATUSES, ["paid", "chargeback"]);
});

test("a commission payment promotes a policy that was waiting to be paid", () => {
  assert.equal(nextPolicyStatusFromStatement("pending", "advance", 12345), "paid");
  assert.equal(nextPolicyStatusFromStatement("approved", "advance", 12345), "paid");
  assert.equal(nextPolicyStatusFromStatement("issued", "renewal", 500), "paid");
  // No current status at all reads as pending, which is the tracker's default.
  assert.equal(nextPolicyStatusFromStatement(null, "advance", 100), "paid");
});

test("a payment never resurrects a policy that has already ended", () => {
  for (const ended of ["lapsed", "chargeback", "denied", "withdrawn", "surrendered", "claim"]) {
    assert.equal(nextPolicyStatusFromStatement(ended, "advance", 5000), null,
      `${ended} must not be promoted to paid by a trailing commission line`);
  }
  // Already paid is not a change either.
  assert.equal(nextPolicyStatusFromStatement("paid", "renewal", 5000), null);
});

test("a chargeback wins from any status except itself", () => {
  for (const cur of ["pending", "approved", "issued", "paid", "lapsed", "denied", "claim"]) {
    assert.equal(nextPolicyStatusFromStatement(cur, "chargeback", -5000), "chargeback");
  }
  assert.equal(nextPolicyStatusFromStatement("chargeback", "chargeback", -5000), null);
});

test("a LAPSE is never inferred from a debit — that would kill live business", () => {
  // An adjustment, a bonus, an override and an unknown line all leave the
  // tracker alone however they point. The carrier-email parser is what reads a
  // carrier actually saying a policy lapsed.
  for (const t of ["adjustment", "bonus", "override", "unknown"]) {
    assert.equal(nextPolicyStatusFromStatement("issued", t, -9999), null);
    assert.equal(nextPolicyStatusFromStatement("issued", t, 9999), null);
  }
});

test("a zero or negative amount is not a payment", () => {
  assert.equal(nextPolicyStatusFromStatement("pending", "advance", 0), null);
  // A negative "advance" is normalized to a chargeback upstream, but if one
  // reaches here it must not read as a payment.
  assert.equal(nextPolicyStatusFromStatement("pending", "renewal", -100), null);
});

test("a statement produces at most one status change per policy", () => {
  const lines = [
    { matched_policy_id: "p1", transaction_type: "advance", amount_cents: 10000 },
    { matched_policy_id: "p1", transaction_type: "renewal", amount_cents: 500 },
    { matched_policy_id: "p2", transaction_type: "advance", amount_cents: 20000 },
  ];
  const plan = planStatementStatusChanges(lines, new Map([["p1", "pending"], ["p2", "approved"]]));
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map(p => p.policyId).sort(), ["p1", "p2"]);
  assert.equal(plan.find(p => p.policyId === "p1").to, "paid");
  assert.equal(plan.find(p => p.policyId === "p1").from, "pending");
});

test("a chargeback later in the same statement beats an earlier payment", () => {
  const lines = [
    { matched_policy_id: "p1", transaction_type: "advance", amount_cents: 10000 },
    { matched_policy_id: "p1", transaction_type: "chargeback", amount_cents: -10000 },
  ];
  const plan = planStatementStatusChanges(lines, new Map([["p1", "pending"]]));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].to, "chargeback");
  assert.equal(plan[0].from, "pending");
});

test("a payment AFTER a chargeback in the same statement does not undo it", () => {
  // Order matters and chargeback is sticky: once the fold reaches 'chargeback'
  // the advance line evaluates against that, not against the original status.
  const lines = [
    { matched_policy_id: "p1", transaction_type: "chargeback", amount_cents: -10000 },
    { matched_policy_id: "p1", transaction_type: "advance", amount_cents: 10000 },
  ];
  const plan = planStatementStatusChanges(lines, new Map([["p1", "pending"]]));
  assert.equal(plan[0].to, "chargeback");
});

test("re-parsing an ingested statement plans NO further status change", () => {
  const lines = [{ matched_policy_id: "p1", transaction_type: "advance", amount_cents: 10000 }];
  const first = planStatementStatusChanges(lines, new Map([["p1", "pending"]]));
  assert.equal(first.length, 1);
  // Second pass sees the status the first pass produced.
  const second = planStatementStatusChanges(lines, new Map([["p1", first[0].to]]));
  assert.equal(second.length, 0, "a re-parse must be a no-op on policy status too");
});

test("an unmatched line changes no policy at all", () => {
  const plan = planStatementStatusChanges(
    [{ matched_policy_id: null, transaction_type: "chargeback", amount_cents: -100 }],
    new Map(),
  );
  assert.deepEqual(plan, []);
});

test("every planned change carries a plain-English reason", () => {
  const plan = planStatementStatusChanges(
    [
      { matched_policy_id: "p1", transaction_type: "advance", amount_cents: 100 },
      { matched_policy_id: "p2", transaction_type: "chargeback", amount_cents: -100 },
    ],
    new Map([["p1", "pending"], ["p2", "paid"]]),
  );
  plan.forEach(p => {
    assert.ok(p.reason && p.reason.length > 8, "a status change must explain itself");
    assert.ok(!/null|undefined/.test(p.reason));
  });
});

// ============================================================
// The American-Amicable AGENT LEDGER STATEMENT — the shape that broke
//
// A real one of these was uploaded on 2026-08-02 and came back with all nine
// amounts exact and NOT ONE DATE, plus five first-year lines labelled renewal
// on a statement whose own summary read TOTAL RENEWAL .00.
//
// 🔴 EVERY NAME AND POLICY NUMBER BELOW IS INVENTED. The layout is the real
// one; the people are not. Never put the owner's statement, or anything off
// it, in this repo — it carries real client names and real policy numbers.
//
// The layout facts that matter, all reproduced here:
//   * THREE date columns per line — ACCTG DATE, DUE DATE, ISSUE DATE — and
//     none of them is called "transaction date".
//   * ACCTG/DUE are bare `MM-DD` with no year; ISSUE is `MM-YY`.
//   * Some dates carry a trailing marker: `06-15*`.
//   * A due date can be AFTER the statement date (`08-13` on a 07-31 run).
//   * The type lives in a SECTION HEADING, not on the line.
//   * A chargeback line has a negative premium as well as a negative amount.
//   * A misc adjustment line names no insured.
//   * Two lines are legitimately identical and both are real.
// ============================================================

const AMAM_STATEMENT_DATE = "2026-07-31";

/** The nine lines as the model returns them, in the real statement's order. */
const AMAM_LINES: PdfLineInput[] = [
  {
    // Misc adjustment. No insured — the ledger prints an explanation here and
    // the model must NOT copy that into insured_name.
    policy_number: "0009990001", insured_name: "", product: "",
    transaction_type: "adjustment", transaction_type_text: "MISC ADJUSTMENT",
    amount: "45.00-", premium: "",
    transaction_date: "07-27", paid_date: "", effective_date: "", due_date: "",
    producer_code: "0009990001",
  },
  {
    // Chargeback: negative amount AND negative premium, sitting under an
    // INITIAL heading — so the model calls it `advance`, which is what the
    // real one did once the prompt started teaching headings. Only the SIGN
    // says this is money coming back, and it has to be enough.
    policy_number: "0111111111", insured_name: "TESTER, ALAN",
    product: "ORDINARY LIFE - INITIAL",
    transaction_type: "advance", transaction_type_text: "ORDINARY LIFE - INITIAL",
    amount: "41.33-", premium: "63.58-",
    transaction_date: "06-15*", paid_date: "", effective_date: "05-26", due_date: "",
    producer_code: "0009990001-01",
  },
  {
    // INITIAL, positive. The model gave up; the heading answers for it.
    policy_number: "0122222222", insured_name: "EXAMPLE, RITA",
    product: "ORDINARY LIFE - INITIAL",
    transaction_type: "unknown", transaction_type_text: "ORDINARY LIFE - INITIAL",
    amount: "90.46", premium: "180.92",
    transaction_date: "07-01*", paid_date: "", effective_date: "06-26", due_date: "08-01",
    producer_code: "0009990001-01",
  },
  {
    // 1ST YEAR called a renewal by the model. The printed heading overrules it.
    policy_number: "0133333333", insured_name: "SAMPLE, DEREK",
    product: "ORDINARY LIFE - 1ST YEAR",
    transaction_type: "renewal", transaction_type_text: "ORDINARY LIFE - 1ST YEAR",
    amount: "30.19", premium: "60.38",
    transaction_date: "07-05", paid_date: "", effective_date: "06-26", due_date: "08-05",
    producer_code: "0009990001-01",
  },
  {
    // Repeated line, occurrence 1 of 2 — both are real money.
    policy_number: "0144444444", insured_name: "PLACEHOLDER, MAY",
    product: "ORDINARY LIFE - 1ST YEAR",
    transaction_type: "renewal", transaction_type_text: "ORDINARY LIFE - 1ST YEAR",
    amount: "36.95", premium: "73.89",
    transaction_date: "07-13", paid_date: "", effective_date: "06-26", due_date: "08-13",
    producer_code: "0009990001-01",
  },
  {
    // Repeated line, occurrence 2 of 2.
    policy_number: "0144444444", insured_name: "PLACEHOLDER, MAY",
    product: "ORDINARY LIFE - 1ST YEAR",
    transaction_type: "renewal", transaction_type_text: "ORDINARY LIFE - 1ST YEAR",
    amount: "36.95", premium: "73.89",
    transaction_date: "07-13", paid_date: "", effective_date: "06-26", due_date: "08-13",
    producer_code: "0009990001-01",
  },
  {
    // No accounting date at all — this one has to fall down the chain to the
    // due date, which is 13 days AFTER the statement date.
    policy_number: "0155555555", insured_name: "FIXTURE, NORA",
    product: "ORDINARY LIFE - 1ST YEAR",
    transaction_type: "renewal", transaction_type_text: "ORDINARY LIFE - 1ST YEAR",
    amount: "90.46", premium: "180.92",
    transaction_date: "", paid_date: "", effective_date: "", due_date: "08-13",
    producer_code: "0009990001-01",
  },
  {
    // No date of any kind. Only `periodEnd` can save it from being invisible.
    policy_number: "0166666666", insured_name: "SPECIMEN, HUGO",
    product: "ORDINARY LIFE - 1ST YEAR",
    transaction_type: "renewal", transaction_type_text: "ORDINARY LIFE - 1ST YEAR",
    amount: "50.02", premium: "100.04",
    transaction_date: "", paid_date: "", effective_date: "", due_date: "",
    producer_code: "0009990001-01",
  },
  {
    // Paid date only.
    policy_number: "0177777777", insured_name: "DUMMY, IRIS",
    product: "ORDINARY LIFE - 1ST YEAR",
    transaction_type: "renewal", transaction_type_text: "ORDINARY LIFE - 1ST YEAR",
    amount: "13.75", premium: "22.92",
    transaction_date: "", paid_date: "07-20", effective_date: "", due_date: "08-20",
    producer_code: "0009990001-01",
  },
];

const amamRows = () => normalizePdfRows(AMAM_LINES, {
  carrier: "American-Amicable",
  statementDate: AMAM_STATEMENT_DATE,
  periodStart: null,
  periodEnd: AMAM_STATEMENT_DATE,
});

test("🔴 EVERY line off the ledger statement gets a transaction_date", () => {
  const rows = amamRows();
  assert.equal(rows.length, 9, "all nine lines survive normalization");
  const undated = rows.filter(r => r.transactionDate === null);
  assert.deepEqual(
    undated.map(r => r.insuredName ?? r.policyNumber),
    [],
    "A null transaction_date does NOT read as 'undated' downstream — it removes the row " +
    "from the trend chart, the persistency windows and the debt drill-down, silently, " +
    "while the totals above them still count it. That is worse than a slightly wrong date.",
  );
});

test("the date chain's precedence, one hop at a time", () => {
  const opts = { anchorDate: "2026-07-31", periodEnd: "2026-07-31" };

  // 1. Accounting/transaction beats everything below it.
  assert.deepEqual(
    resolvePdfRowDates(
      { transactionDate: "07-05", paidDate: "07-20", effectiveDate: "2026-06-01", dueDate: "08-05" }, opts,
    ),
    { transactionDate: "2026-07-05", effectiveDate: "2026-06-01", paidDate: "2026-07-20", source: "transaction" },
  );

  // 2. Paid beats effective and due.
  assert.equal(
    resolvePdfRowDates({ paidDate: "07-20", effectiveDate: "2026-06-01", dueDate: "08-05" }, opts).transactionDate,
    "2026-07-20",
  );

  // 3. Effective beats due.
  assert.equal(
    resolvePdfRowDates({ effectiveDate: "2026-06-01", dueDate: "08-05" }, opts).transactionDate,
    "2026-06-01",
  );

  // 4. Due beats the period end.
  assert.equal(resolvePdfRowDates({ dueDate: "08-05" }, opts).transactionDate, "2026-08-05");

  // 5. The period end is the floor.
  assert.equal(resolvePdfRowDates({}, opts).transactionDate, "2026-07-31");

  // 6. Nothing at all, not even a period — null, and it says so.
  assert.deepEqual(resolvePdfRowDates({}, { anchorDate: null, periodEnd: null }), {
    transactionDate: null, effectiveDate: null, paidDate: null, source: "none",
  });
});

test("the first three hops are the tabular path's chain, in the tabular path's order", () => {
  // applyMapping has always done `transaction ?? paid ?? effective`. Two
  // definitions of "when did this line happen" one file format apart is the
  // bug class this repo keeps paying for, so the overlap must be identical.
  const sheet: Sheet = {
    name: "s",
    rows: [
      ["Policy", "Insured", "Amount", "Txn Date", "Paid Date", "Eff Date"],
      ["P1", "A One", "100.00", "", "", "2026-06-01"],
      ["P2", "B Two", "100.00", "", "07-20-2026", "2026-06-01"],
      ["P3", "C Three", "100.00", "07-05-2026", "07-20-2026", "2026-06-01"],
    ],
  };
  const mapping: ColumnMapping = {
    columns: { policy_number: 0, insured_name: 1, amount: 2, transaction_date: 3, paid_date: 4, effective_date: 5 },
  };
  const tabular = applyMapping(sheet, previewSheet(sheet), mapping);
  assert.deepEqual(tabular.map(r => r.transactionDate), ["2026-06-01", "2026-07-20", "2026-07-05"]);

  const pdf = [
    { transaction_date: "", paid_date: "", effective_date: "2026-06-01" },
    { transaction_date: "", paid_date: "07-20-2026", effective_date: "2026-06-01" },
    { transaction_date: "07-05-2026", paid_date: "07-20-2026", effective_date: "2026-06-01" },
  ].map(l => resolvePdfRowDates({
    transactionDate: l.transaction_date, paidDate: l.paid_date, effectiveDate: l.effective_date,
  }, { anchorDate: "2026-07-31", periodEnd: null }));
  assert.deepEqual(pdf.map(r => r.transactionDate), ["2026-06-01", "2026-07-20", "2026-07-05"]);
});

// ------------------------------------------------------------
// The year trap
// ------------------------------------------------------------

test("🔴 a bare MM-DD takes its year from the STATEMENT, over the December rollover", () => {
  // December on a January statement is LAST December. A naive "use the
  // statement's year" is wrong here, once a year, for every agent.
  assert.equal(resolvePartialDate("12-15", "2027-01-31"), "2026-12-15");
  assert.equal(resolvePartialDate("11-02", "2027-01-05"), "2026-11-02");
});

test("🔴 ...and the other direction: January on a January statement is THIS January", () => {
  assert.equal(resolvePartialDate("01-05", "2027-01-31"), "2027-01-05");
  assert.equal(resolvePartialDate("01-31", "2027-01-31"), "2027-01-31");
});

test("a due date a few days in the future stays in the future", () => {
  // 'Nearest year', not 'on or before'. A premium due date is legitimately
  // ahead of the statement; forcing it backwards invents a date a year early.
  assert.equal(resolvePartialDate("08-13", "2026-07-31"), "2026-08-13");
  assert.equal(resolvePartialDate("08-01", "2026-07-31"), "2026-08-01");
});

test("the year comes from the statement, never from the clock", () => {
  // The same string against two different statements must give two different
  // years — that is the whole property. Re-reading a 2021 statement today
  // must not drag its lines into this year.
  assert.equal(resolvePartialDate("07-09", "2021-07-31"), "2021-07-09");
  assert.equal(resolvePartialDate("07-09", "2026-07-31"), "2026-07-09");
});

test("a date marker beside the number is stripped, not fatal", () => {
  assert.equal(resolvePartialDate("06-15*", "2026-07-31"), "2026-06-15");
  assert.equal(resolvePartialDate("07-01 *", "2026-07-31"), "2026-07-01");
  assert.equal(resolveDateWithAnchor("07-01*", "2026-07-31"), "2026-07-01");
});

test("an unresolvable partial date falls through rather than being guessed", () => {
  assert.equal(resolvePartialDate("07-09", null), null, "no anchor means no answer");
  assert.equal(resolvePartialDate("13-09", "2026-07-31"), null, "month 13");
  assert.equal(resolvePartialDate("02-30", "2026-07-31"), null, "February 30th is not a date");
  assert.equal(resolvePartialDate("", "2026-07-31"), null);
  assert.equal(resolvePartialDate("Q3", "2026-07-31"), null);
  // Three components is a whole date; parseDateISO's job, not this one's.
  assert.equal(resolvePartialDate("07-09-26", "2026-07-31"), null);
});

test("🔴 an ISSUE date is never partial-resolved, because MM-YY reads as MM-DD", () => {
  // This carrier prints ISSUE DATE as `06-26` meaning June 2026. As a string
  // that is indistinguishable from June 26th, so reading it would invent a
  // day and then bucket the row on it. Falling through is the right answer.
  const r = resolvePdfRowDates(
    { effectiveDate: "06-26", dueDate: "08-13" },
    { anchorDate: "2026-07-31", periodEnd: "2026-07-31" },
  );
  assert.equal(r.effectiveDate, null, "a two-part issue date is ambiguous, so it is not read");
  assert.equal(r.transactionDate, "2026-08-13", "and the chain moves on to the due date");
  // A full issue date is still read normally.
  assert.equal(resolvePdfRowDates({ effectiveDate: "06-15-2026" }, {}).effectiveDate, "2026-06-15");
});

test("resolveDateWithAnchor prefers a real full date and never rewrites one", () => {
  assert.equal(resolveDateWithAnchor("2026-03-04", "2027-01-31"), "2026-03-04");
  assert.equal(resolveDateWithAnchor("03/04/2026", "2027-01-31"), "2026-03-04");
});

// ------------------------------------------------------------
// First year is not a renewal
// ------------------------------------------------------------

test("🔴 normalizeTxnType reads '1st year', which is what shipped broken", () => {
  assert.equal(normalizeTxnType("1st year"), "advance");
  assert.equal(normalizeTxnType("1ST YEAR"), "advance");
  assert.equal(normalizeTxnType("ordinary life - 1st year"), "advance");
  assert.equal(normalizeTxnType("ORDINARY LIFE - 1ST YEAR"), "advance");
  assert.equal(normalizeTxnType("1st yr"), "advance");
  assert.equal(normalizeTxnType("1styr"), "advance");
  assert.equal(normalizeTxnType("first yr"), "advance");
  // The wordings that already worked must keep working.
  assert.equal(normalizeTxnType("First Year"), "advance");
  assert.equal(normalizeTxnType("ORDINARY LIFE - INITIAL"), "advance");
  assert.equal(normalizeTxnType("New Business"), "advance");
});

test("a genuine renewal is still a renewal", () => {
  assert.equal(normalizeTxnType("Renewal"), "renewal");
  assert.equal(normalizeTxnType("ORDINARY LIFE - RENEWAL"), "renewal");
  assert.equal(normalizeTxnType("Renewal Commission"), "renewal");
  assert.equal(normalizeTxnType("Persistency Fee"), "renewal");
  // Renewal is checked before advance, so a line claiming both stays renewal.
  assert.equal(normalizeTxnType("2nd year renewal"), "renewal");
});

test("🔴 the printed heading overrules a model that called first-year money a renewal", () => {
  assert.equal(refineTxnTypeFromText("renewal", "ORDINARY LIFE - 1ST YEAR", 3019), "advance");
  assert.equal(refineTxnTypeFromText("unknown", "ORDINARY LIFE - INITIAL", 9046), "advance");
  // A real renewal heading is left exactly alone.
  assert.equal(refineTxnTypeFromText("renewal", "ORDINARY LIFE - RENEWAL", 1000), "renewal");
});

test("🔴 refinement never relabels a chargeback, whatever the heading says", () => {
  // The money moving backwards establishes a chargeback. A product name with
  // "renewable" or a section headed "1ST YEAR" must not be able to undo it —
  // which is why this is not just normalizeTxnType(printedText).
  assert.equal(refineTxnTypeFromText("chargeback", "ORDINARY LIFE - 1ST YEAR", -4133), "chargeback");
  assert.equal(refineTxnTypeFromText("chargeback", "RENEWABLE TERM", -4133), "chargeback");
});

test("🔴 NEGATIVE COMMISSION IS A CHARGEBACK EVEN WHEN THE MODEL SAYS advance", () => {
  // The regression this round CAUSED and caught, on the owner's real file.
  // Teaching the prompt that `ORDINARY LIFE - INITIAL` means `advance` made
  // the model answer confidently for a line whose amount was -41.33 — and a
  // confident answer switches OFF normalizeTxnType's sign tiebreak. The net
  // still reconciled to the cent, so nothing would have complained, while the
  // line quietly left the Debt tab, which counts chargeback and adjustment
  // only. Commission paid to an agent cannot be negative.
  assert.equal(refineTxnTypeFromText("advance", "ORDINARY LIFE - INITIAL", -4133), "chargeback");
  assert.equal(refineTxnTypeFromText("advance", "ORDINARY LIFE - 1ST YEAR", -1), "chargeback");
  assert.equal(refineTxnTypeFromText("renewal", "ORDINARY LIFE - RENEWAL", -500), "chargeback");
  // Positive money under the same headings is untouched.
  assert.equal(refineTxnTypeFromText("advance", "ORDINARY LIFE - INITIAL", 4133), "advance");
  assert.equal(refineTxnTypeFromText("renewal", "ORDINARY LIFE - RENEWAL", 500), "renewal");
  // A negative ADJUSTMENT stays an adjustment — a fee is not a reversal, and
  // both already count as debt. Same for an override or a bonus.
  assert.equal(refineTxnTypeFromText("adjustment", "MISC ADJUSTMENT", -4500), "adjustment");
  assert.equal(refineTxnTypeFromText("override", "OVERRIDE", -100), "override");
});

test("the tabular path's sign rule is deliberately NOT changed", () => {
  // normalizeTxnType still treats the sign as a tiebreak only. On a sheet the
  // type column carries the carrier's own transaction word, and "Adjustment"
  // must stay an adjustment whichever way it points. Only the PDF path, where
  // the "type" is a product heading, needs the stronger rule above.
  assert.equal(normalizeTxnType("First Year Advance", -100), "advance");
  assert.equal(normalizeTxnType("Renewal", -100), "renewal");
  assert.equal(normalizeTxnType("Adjustment", -5000), "adjustment");
});

test("refinement does not overrule a confident model answer in any other direction", () => {
  assert.equal(refineTxnTypeFromText("override", "ORDINARY LIFE - 1ST YEAR", 100), "override");
  assert.equal(refineTxnTypeFromText("bonus", "ORDINARY LIFE - RENEWAL", 100), "bonus");
  assert.equal(refineTxnTypeFromText("adjustment", "MISC", -100), "adjustment");
  // Nothing printed, nothing to say.
  assert.equal(refineTxnTypeFromText("renewal", "", 100), "renewal");
  assert.equal(refineTxnTypeFromText("unknown", "", 100), "unknown");
});

test("🔴 a negative amount is still a chargeback whatever section it sits in", () => {
  const rows = amamRows();
  const cb = rows.find(r => r.amountCents === -4133)!;
  assert.equal(cb.transactionType, "chargeback");
  assert.equal(cb.premiumCents, -6358, "the negative premium survives too");
  // And the bare rule underneath it is untouched.
  assert.equal(normalizeTxnType("", -1), "chargeback");
  assert.equal(normalizeTxnType("ORDINARY LIFE - 1ST YEAR", -1), "advance",
    "a named line still keeps its name — the sign is only a tiebreak");
});

test("🔴 the whole ledger statement types out correctly", () => {
  const rows = amamRows();
  assert.deepEqual(rows.map(r => r.transactionType), [
    "adjustment",   // misc
    "chargeback",   // negative, under an INITIAL heading
    "advance",      // INITIAL, model said unknown
    "advance",      // 1ST YEAR, model said renewal
    "advance",      // 1ST YEAR, repeated line 1
    "advance",      // 1ST YEAR, repeated line 2
    "advance",      // 1ST YEAR
    "advance",      // 1ST YEAR
    "advance",      // 1ST YEAR
  ]);
  assert.equal(rows.filter(r => r.transactionType === "renewal").length, 0,
    "this statement's own summary reads TOTAL RENEWAL .00 — not one line here is a renewal");
  assert.equal(rows.filter(r => r.transactionType === "unknown").length, 0);
});

test("the ledger statement's dates resolve to the right day, per line", () => {
  const rows = amamRows();
  assert.deepEqual(rows.map(r => r.transactionDate), [
    "2026-07-27",  // acctg 07-27
    "2026-06-15",  // acctg 06-15* — marker stripped
    "2026-07-01",  // acctg 07-01*
    "2026-07-05",  // acctg 07-05
    "2026-07-13",  // acctg 07-13
    "2026-07-13",  // acctg 07-13, the repeat
    "2026-08-13",  // no acctg -> due date, which is after the statement date
    "2026-07-31",  // nothing at all -> the period end floor
    "2026-07-20",  // no acctg -> paid date
  ]);
  // The specific fields stay as printed alongside, exactly as the tabular
  // path keeps them. The MM-YY issue dates are correctly not guessed.
  assert.deepEqual(rows.map(r => r.effectiveDate), [null, null, null, null, null, null, null, null, null]);
  assert.equal(rows[8].paidDate, "2026-07-20");
});

test("the misc adjustment line carries no insured name", () => {
  const rows = amamRows();
  assert.equal(rows[0].insuredName, null,
    "ledger explanation text is not a person; an adjustment line names nobody and empty is correct");
  assert.equal(rows[0].transactionType, "adjustment");
  assert.equal(rows[0].amountCents, -4500);
});

test("🔴 the two identical lines both survive — the occurrence ordinal still works", () => {
  const rows = amamRows();
  const pair = rows.filter(r => r.amountCents === 3695);
  assert.equal(pair.length, 2, "both are real money and both must be kept");

  const keys = buildDedupeKeys(rows, sha);
  assert.equal(new Set(keys).size, keys.length, "nine lines, nine distinct dedupe keys");

  // ...and re-parsing the same statement produces the same nine keys, so the
  // upsert writes nothing new.
  assert.deepEqual(buildDedupeKeys(amamRows(), sha), keys);
});

test("🔴 the money is untouched — the net still reconciles to the carrier's own total", () => {
  const rows = amamRows();
  const net = rows.reduce((n, r) => n + r.amountCents, 0);
  const positives = rows.filter(r => r.amountCents > 0).reduce((n, r) => n + r.amountCents, 0);
  assert.equal(positives, 34878);
  assert.equal(net, 34878 - 4500 - 4133, "commission less the chargeback less the misc adjustment");
  assert.equal(net, 26245);
  // The amounts themselves, line by line, exactly as printed.
  assert.deepEqual(rows.map(r => r.amountCents), [-4500, -4133, 9046, 3019, 3695, 3695, 9046, 5002, 1375]);
});

test("normalizePdfRows still drops a line that is padding, and keeps a zero-value real line", () => {
  const rows = normalizePdfRows([
    { policy_number: "", insured_name: "", amount: "", transaction_type: "unknown" },
    { policy_number: "P9", insured_name: "", amount: "0.00", transaction_type: "adjustment" },
  ], { carrier: "X", statementDate: "2026-07-31", periodEnd: "2026-07-31" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policyNumber, "P9");
});

// ============================================================
// FIX3 — a statement you can remove, and a re-read that replaces
// ============================================================

/** The same nine lines as the fixture, fingerprinted the way the PRE-FIX2 parser left them: no dates at all. */
const amamRowsUndated = () => amamRows().map(r => ({
  ...r, transactionDate: null, paidDate: null, effectiveDate: null,
}));

test("🔴 A PARSER FIX RE-FINGERPRINTS EVERY LINE — which is why re-read had to start replacing", () => {
  // This is the whole mechanism, stated as a test. The dedupe key carries the
  // transaction DATE (section 8). FIX2 turned nine null dates into real July
  // ones, so not one of the nine keys survived the change — and the upsert
  // uses ignoreDuplicates, so nothing collides and nothing is updated.
  const before = buildDedupeKeys(amamRowsUndated(), sha);
  const after = buildDedupeKeys(amamRows(), sha);
  assert.equal(before.length, 9);
  assert.equal(after.length, 9);

  const overlap = after.filter(k => before.includes(k));
  assert.deepEqual(overlap, [],
    "Every line re-fingerprints after a date fix, so an APPENDING re-read inserts a second full set beside " +
    "the first: the owner's 9-line $262.45 statement becomes 18 lines and $524.90. This is why the re-read " +
    "path deletes the statement's rows before inserting.");

  // The arithmetic of the bug this round exists to prevent, spelled out.
  const net = amamRows().reduce((n, r) => n + r.amountCents, 0);
  assert.equal(net, 26245);
  assert.equal(net * 2, 52490, "$262.45 doubled is $524.90");
});

test("re-reading UNCHANGED lines still fingerprints identically — the dedupe key is not the problem", () => {
  // The key is correct and this round does not touch it. A re-read of a
  // statement the parser reads the same way writes nothing new either way.
  assert.deepEqual(buildDedupeKeys(amamRows(), sha), buildDedupeKeys(amamRows(), sha));
});

// ---- what counts as hand work ----

test("hand work is a decision a PERSON made, not merely a populated column", () => {
  assert.equal(rowCarriesHandWork({ policy_number: "1", insured_name: "A", amount_cents: 1, review_status: "approved" }), true);
  assert.equal(rowCarriesHandWork({ policy_number: "1", insured_name: "A", amount_cents: 1, review_status: "rejected" }), true);
  assert.equal(rowCarriesHandWork({
    policy_number: "1", insured_name: "A", amount_cents: 1,
    review_status: "needs_review", match_method: "manual",
  }), true, "a match the agent chose by hand is hand work even before it is approved");

  // The parser's own opinion is NOT hand work. Carrying it would freeze a
  // stale verdict on top of the fresh parse the re-read exists to get.
  assert.equal(rowCarriesHandWork({
    policy_number: "1", insured_name: "A", amount_cents: 1,
    review_status: "auto", matched_policy_id: "p1", match_method: "policy_number",
  }), false);
  assert.equal(rowCarriesHandWork({ policy_number: "1", insured_name: "A", amount_cents: 1, review_status: "needs_review" }), false);
});

test("the carry key is the three fields, normalized — and deliberately NOT the dedupe key", () => {
  // Same line, reformatted by the new parse: still the same line.
  assert.equal(
    handWorkCarryKey({ policy_number: "01-4444-4444", insured_name: "PLACEHOLDER, MAY", amount_cents: 3695 }),
    handWorkCarryKey({ policy_number: "0144444444", insured_name: "May Placeholder", amount_cents: 3695 }),
  );
  // A key including the date or the type would carry nothing forward on
  // exactly the statements that need it — the ones a parser fix re-dated.
  const k = handWorkCarryKey({ policy_number: "P1", insured_name: "A B", amount_cents: 100 });
  assert.equal(k.includes("2026"), false);
  assert.equal(k.includes("advance"), false);
});

// ---- carry-over ----

const HW = (o: Record<string, unknown>) => ({
  policy_number: null, insured_name: null, amount_cents: 0,
  review_status: "auto", matched_policy_id: null, match_method: null,
  match_confidence: null, review_reason: null, review_note: null,
  reviewed_at: null, reviewed_by: null, ...o,
});

test("an approval carries over onto an identical line, with its match", () => {
  const before = [HW({
    policy_number: "0122222222", insured_name: "SAMPLE, ORSON", amount_cents: 9046,
    review_status: "approved", matched_policy_id: "pol-1", match_method: "manual", match_confidence: 1,
    reviewed_by: "agent-1", reviewed_at: "2026-08-01T12:00:00Z",
  })];
  // Same three fields; the parse now dates and types it differently, which is
  // the entire point — those are not part of the identity.
  const after = [HW({ policy_number: "0122222222", insured_name: "Sample, Orson", amount_cents: 9046 })];

  const c = carryStatementHandWork(before, after);
  assert.equal(c.handWorkBefore, 1);
  assert.equal(c.carriedCount, 1);
  assert.equal(c.lostCount, 0);
  assert.equal(c.carried[0]!.review_status, "approved");
  assert.equal(c.carried[0]!.matched_policy_id, "pol-1");
  assert.equal(c.carried[0]!.match_method, "manual", "the match must stay coherent with the id it points at");
  assert.equal(c.carried[0]!.reviewed_by, "agent-1");
});

test("hand work does NOT carry when the amount, the insured or the policy number changed", () => {
  const approved = (o: Record<string, unknown>) => HW({
    policy_number: "0122222222", insured_name: "SAMPLE, ORSON", amount_cents: 9046,
    review_status: "approved", matched_policy_id: "pol-1", ...o,
  });
  for (const [what, changed] of [
    ["the amount", HW({ policy_number: "0122222222", insured_name: "SAMPLE, ORSON", amount_cents: 9047 })],
    ["the insured", HW({ policy_number: "0122222222", insured_name: "OTHER, PERSON", amount_cents: 9046 })],
    ["the policy number", HW({ policy_number: "0199999999", insured_name: "SAMPLE, ORSON", amount_cents: 9046 })],
  ] as const) {
    const c = carryStatementHandWork([approved({})], [changed]);
    assert.equal(c.carried[0], null, `${what} changed, so this is a different line — do not guess`);
    assert.equal(c.carriedCount, 0);
    assert.equal(c.lostCount, 1, "a decision that did not survive is COUNTED, never quietly absorbed");
  }
});

test("🔴 THE DUPLICATE GROUP: two identical lines keep their OWN decisions, positionally", () => {
  // The owner's real ledger carries Browning $36.95 twice and Smith $90.46
  // twice — identical on policy number, insured and amount, which is exactly
  // why the dedupe key has an occurrence ordinal. First-match-wins would
  // attach the first twin's approval to both, or one twin's approval to its
  // sibling. Names here are the fixture's, not his.
  const before = [
    HW({ policy_number: "0144444444", insured_name: "BROWNING, A", amount_cents: 3695, review_status: "approved", matched_policy_id: "pol-brown", match_method: "manual" }),
    HW({ policy_number: "0144444444", insured_name: "BROWNING, A", amount_cents: 3695, review_status: "rejected" }),
    HW({ policy_number: "0155555555", insured_name: "SMITH, B", amount_cents: 9046, review_status: "rejected" }),
    HW({ policy_number: "0155555555", insured_name: "SMITH, B", amount_cents: 9046, review_status: "approved", matched_policy_id: "pol-smith", match_method: "manual" }),
  ];
  const after = before.map(r => HW({
    policy_number: r.policy_number, insured_name: r.insured_name, amount_cents: r.amount_cents,
  }));

  const c = carryStatementHandWork(before, after);
  assert.equal(c.carriedCount, 4);
  assert.equal(c.lostCount, 0);
  assert.deepEqual(c.carried.map(x => x!.review_status),
    ["approved", "rejected", "rejected", "approved"],
    "each twin keeps its OWN decision — first-match-wins would return approved,approved,rejected,rejected");
  assert.equal(c.carried[0]!.matched_policy_id, "pol-brown");
  assert.equal(c.carried[1]!.matched_policy_id, null, "the rejected twin never had a match to inherit");
  assert.equal(c.carried[3]!.matched_policy_id, "pol-smith");
});

test("position is preserved even when only the SECOND twin was touched", () => {
  // Every old row joins its queue, hand work or not. Filtering the untouched
  // first twin out would shift the second twin's approval onto it.
  const before = [
    HW({ policy_number: "P", insured_name: "TWIN, A", amount_cents: 3695 }),
    HW({ policy_number: "P", insured_name: "TWIN, A", amount_cents: 3695, review_status: "approved", matched_policy_id: "pol-2" }),
  ];
  const after = before.map(() => HW({ policy_number: "P", insured_name: "TWIN, A", amount_cents: 3695 }));
  const c = carryStatementHandWork(before, after);
  assert.equal(c.carried[0], null, "the untouched first twin must stay untouched");
  assert.equal(c.carried[1]!.review_status, "approved");
  assert.equal(c.carriedCount, 1);
  assert.equal(c.lostCount, 0);
});

test("a re-read that finds FEWER copies of a repeated line reports the lost decision", () => {
  const before = [
    HW({ policy_number: "P", insured_name: "TWIN, A", amount_cents: 3695, review_status: "approved" }),
    HW({ policy_number: "P", insured_name: "TWIN, A", amount_cents: 3695, review_status: "approved" }),
  ];
  const c = carryStatementHandWork(before, [HW({ policy_number: "P", insured_name: "TWIN, A", amount_cents: 3695 })]);
  assert.equal(c.handWorkBefore, 2);
  assert.equal(c.carriedCount, 1);
  assert.equal(c.lostCount, 1);
});

test("the whole nine-line statement carries every decision when nothing but the dates moved", () => {
  // The owner's case end to end: nine lines re-read after FIX2. Every dedupe
  // key changed (test above) and every decision survives anyway, because the
  // carry key is the three fields the fix did not touch.
  const before = amamRowsUndated().map((r, i) => HW({
    policy_number: r.policyNumber, insured_name: r.insuredName, amount_cents: r.amountCents,
    review_status: i % 2 === 0 ? "approved" : "auto",
    matched_policy_id: i % 2 === 0 ? `pol-${i}` : null,
  }));
  const after = amamRows().map(r => HW({
    policy_number: r.policyNumber, insured_name: r.insuredName, amount_cents: r.amountCents,
  }));
  const c = carryStatementHandWork(before, after);
  assert.equal(after.length, 9, "nine lines in, nine lines out — never eighteen");
  assert.equal(c.lostCount, 0, "a date fix must not cost the agent a single approval");
  assert.equal(c.carriedCount, c.handWorkBefore);
});

// ---- the delete impact ----

test("the delete impact counts the lines, the net and the ZIP members that go with it", () => {
  const impact = summarizeStatementDeletion({
    statement: { id: "st-1", filename: "doc.pdf" },
    children: [{ id: "st-2", filename: "americo.csv" }, { id: "st-3", filename: "trans.xlsx" }],
    rows: amamRows().map(r => ({ amount_cents: r.amountCents })),
    history: [],
  });
  assert.equal(impact.line_count, 9);
  assert.equal(impact.net_amount_cents, 26245);
  assert.equal(impact.child_count, 2, "a ZIP's members cascade with it and are invisible from the row clicked");
  assert.deepEqual(impact.child_filenames, ["americo.csv", "trans.xlsx"]);
});

test("🔴 the delete impact NAMES the policies the statement moved, and what it set them to", () => {
  // Decision 1: deleting a statement does not revert a policy. The agent is
  // owed the list so they can check them, which means every entry has to carry
  // the status it was set TO.
  const impact = summarizeStatementDeletion({
    statement: { id: "st-1", filename: "doc.pdf" },
    rows: [{ amount_cents: -4133 }],
    history: [
      { policy_id: "p1", policy_client_id: 12, policy_number: "0111111111", insured_name: "Sample Orson", from_status: "issued", to_status: "chargeback", changed_at: "2026-08-01T12:00:00Z" },
      { policy_id: "p2", policy_client_id: 13, policy_number: null, insured_name: "Fixture Nora", from_status: "approved", to_status: "paid", changed_at: "2026-08-01T12:00:01Z" },
    ],
  });
  assert.equal(impact.moved_policies.length, 2);
  assert.deepEqual(impact.moved_policies.map(p => p.to_status), ["chargeback", "paid"]);
  assert.deepEqual(impact.moved_policies.map(p => p.from_status), ["issued", "approved"]);
  assert.equal(impact.moved_policies[0].insured_name, "Sample Orson");
  assert.equal(impact.moved_policies[1].policy_number, null, "a policy with no number is still named");
});

test("🔴 one entry per policy, even when the trail holds several changes for it", () => {
  // Caught by the live shadow run, not by a unit test: a statement that moved
  // the same policy twice listed that person twice in the confirmation, which
  // reads as a bug rather than as history. Collapsed to where the policy
  // STARTED and where the statement LEFT it.
  const impact = summarizeStatementDeletion({
    statement: { id: "st-1", filename: "doc.pdf" },
    history: [
      { policy_id: "p1", policy_client_id: 1, policy_number: "A", insured_name: "Sample Orson", from_status: "approved", to_status: "paid", changed_at: "2026-08-01T10:00:00Z" },
      { policy_id: "p1", policy_client_id: 1, policy_number: "A", insured_name: "Sample Orson", from_status: "paid", to_status: "chargeback", changed_at: "2026-08-01T11:00:00Z" },
      { policy_id: "p2", policy_client_id: 2, policy_number: "B", insured_name: "Fixture Nora", from_status: "pending", to_status: "paid", changed_at: "2026-08-01T12:00:00Z" },
    ],
  });
  assert.equal(impact.moved_policies.length, 2, "one entry per POLICY, not one per history row");
  assert.equal(impact.moved_policies[0].from_status, "approved", "where it started");
  assert.equal(impact.moved_policies[0].to_status, "chargeback", "where the statement left it");
  assert.equal(impact.moved_policies[1].to_status, "paid");
});

test("a history row with no policy id is still reported, never collapsed away", () => {
  const impact = summarizeStatementDeletion({
    statement: { id: "st-1", filename: "doc.pdf" },
    history: [
      { policy_id: null, policy_client_id: 1, policy_number: null, insured_name: null, from_status: "a", to_status: "b", changed_at: null },
      { policy_id: null, policy_client_id: 2, policy_number: null, insured_name: null, from_status: "c", to_status: "d", changed_at: null },
    ],
  });
  assert.equal(impact.moved_policies.length, 2, 'dropping a change would hide something the statement did');
});

test("a statement that moved nothing reports an empty list, not a missing one", () => {
  const impact = summarizeStatementDeletion({ statement: { id: "st-1", filename: "doc.pdf" } });
  assert.deepEqual(impact.moved_policies, []);
  assert.equal(impact.line_count, 0);
  assert.equal(impact.net_amount_cents, 0);
  assert.equal(impact.child_count, 0);
});
