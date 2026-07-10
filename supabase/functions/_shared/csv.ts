// ============================================================
// supabase/functions/_shared/csv.ts
//
// Minimal dependency-free CSV parser for messaging-recipients-import.
// Handles quoted fields (commas/newlines inside quotes, "" as an escaped
// quote) — the common Excel/Google Sheets export dialect. Not a full
// RFC 4180 implementation (fixed comma delimiter, no dialect options),
// which is fine for a single-purpose recipient-list importer.
//
// Plain Node/Deno module — no runtime-specific globals — so it can run
// under both `node --test` (see csv.test.ts) and the Deno edge function
// runtime.
// ============================================================

export interface ParsedCsv {
  headers: string[];
  /** One object per data row, keyed by trimmed header name. */
  rows: Record<string, string>[];
}

/** Parses CSV text (with a header row) into headers + row objects. */
export function parseCsv(text: string): ParsedCsv {
  const src = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawRows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawAnyField = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; sawAnyField = true; continue; }
    if (ch === ',') { row.push(field); field = ""; sawAnyField = true; continue; }
    if (ch === '\n') {
      row.push(field);
      rawRows.push(row);
      field = "";
      row = [];
      sawAnyField = false;
      continue;
    }
    field += ch;
    sawAnyField = true;
  }
  if (sawAnyField || field.length > 0 || row.length > 0) {
    row.push(field);
    rawRows.push(row);
  }

  const nonEmptyRows = rawRows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (nonEmptyRows.length === 0) return { headers: [], rows: [] };

  const headers = nonEmptyRows[0].map((h) => h.trim());
  const rows = nonEmptyRows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? "").trim(); });
    return obj;
  });

  return { headers, rows };
}
