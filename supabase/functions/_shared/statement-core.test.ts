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
  MAX_FILE_BYTES,
  type Sheet,
  type ColumnMapping,
  type NormalizedRow,
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
  assert.equal(readCsvGrid("﻿policy,amount\nBU1,10\n")[0][0], "policy");
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
