// ============================================================
// supabase/functions/statement-upload/index.ts
//
// Step 1 of Back Office ingestion: take the bytes, keep them, queue the work.
// It deliberately does NOT parse — parsing costs an API call and can fail, and
// neither of those should be able to lose an agent's document. By the time
// this function returns, the file is durable and re-runnable.
//
// Transport: the raw bytes are the request body (application/octet-stream),
// with the filename in an `x-filename-b64` header. Base64-in-JSON would inflate
// every upload by a third for nothing.
//
// Idempotency: `commission_statements` carries UNIQUE (agent_id, sha256), so
// re-uploading the identical file returns the statement that already exists
// instead of ingesting it twice. The response says which happened, because
// silently doing nothing looks like a bug to the person clicking the button.
//
// A ZIP is expanded here, not later: each member becomes its own queued
// statement pointing back at the archive, so a failure in one member cannot
// take the others down and each is separately re-runnable.
//
// verify_jwt: TRUE (the platform default). The browser is the only caller and
// it always has a session, so this function is deliberately ABSENT from
// supabase/config.toml — see that file's header for why that matters.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  detectFileKind,
  readZip,
  sniffCarrier,
  ALLOWED_KINDS,
  MAX_FILE_BYTES,
  MAX_ZIP_MEMBERS,
  tooLargeMessage,
} from "../_shared/statement-core.ts";
import type { FileKind } from "../_shared/statement-core.ts";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Postgres bytea literal for a PostgREST insert. */
function toByteaHex(bytes: Uint8Array): string {
  let s = "\\x";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += [...bytes.subarray(i, i + CHUNK)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return s;
}

function decodeFilename(header: string | null): string {
  if (!header) return "statement";
  try {
    const bin = atob(header);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const name = new TextDecoder().decode(bytes).trim();
    // Never trust a client-supplied path — this is only ever a display label.
    return (name.split(/[\\/]/).pop() || "statement").slice(0, 200);
  } catch {
    return "statement";
  }
}

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // The uploader is ALWAYS taken from the JWT. There is no agent id in the
  // request — a body-supplied one would be a way to write into someone else's
  // book, and commission data is the most sensitive data in this app.
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!token) return json({ error: "unauthorized" }, 401);

  // THE ONE EXCEPTION, added in Phase 1b, and the reason it is safe:
  //
  // A statement forwarded to <token>@commissions.producerstackcrm.com arrives
  // at messaging-email-inbound-webhook, which has NO user session — it has
  // resolved the agent from the address token instead. So it calls this
  // function with the SERVICE ROLE KEY and names the agent in `x-agent-id`.
  //
  // `x-agent-id` is honoured ONLY when the bearer token is byte-for-byte the
  // service-role key. From any other caller it is ignored completely — not
  // rejected, ignored — so a browser sending it simply uploads to its own
  // book as before. The service role is not something a client can hold; if
  // it ever were, naming an agent here would be the least of the problems.
  const isService = token === SERVICE_KEY;
  const headerAgent = (req.headers.get("x-agent-id") || "").trim();

  let agentId: string;
  if (isService && headerAgent) {
    if (!/^[0-9a-f-]{36}$/i.test(headerAgent)) return json({ error: "bad_agent_id" }, 400);
    // Verify the agent actually exists rather than trusting the header shape.
    const { data: who } = await sb.from("agents").select("id").eq("id", headerAgent).maybeSingle();
    if (!who) return json({ error: "unknown_agent" }, 404);
    agentId = headerAgent;
  } else {
    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return json({ error: "unauthorized" }, 401);
    agentId = user.id;
  }

  // `email` marks a statement that arrived by forwarding rather than upload;
  // commission_statements.source already allowed the value (Phase 1 reserved
  // it), and the Back Office screen renders it so an agent can tell at a
  // glance where a statement came from.
  const sourceLabel = (isService && req.headers.get("x-source") === "email") ? "email" : "upload";

  const filename = decodeFilename(req.headers.get("x-filename-b64"));
  const mime = (req.headers.get("x-content-type") || "").slice(0, 120) || null;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return json({ error: "unreadable_body" }, 400);
  }
  if (bytes.length === 0) return json({ error: "empty_file", detail: `${filename} is empty.` }, 400);
  if (bytes.length > MAX_FILE_BYTES) {
    return json({ error: "file_too_large", detail: tooLargeMessage(filename, bytes.length) }, 413);
  }

  let kind: FileKind;
  try {
    kind = detectFileKind(filename, bytes);
  } catch {
    kind = "unknown";
  }
  if (!ALLOWED_KINDS.includes(kind)) {
    return json({
      error: "unsupported_format",
      detail:
        `${filename} does not look like a PDF, spreadsheet, CSV or ZIP. ` +
        `If it was renamed, restore the original extension and try again.`,
    }, 415);
  }

  // ------------------------------------------------------------
  // Insert one statement + its bytes. Returns the existing row on a repeat.
  // ------------------------------------------------------------
  async function storeStatement(opts: {
    name: string;
    data: Uint8Array;
    fileKind: FileKind;
    source: string;
    parentId: string | null;
    status: string;
    statusDetail?: string | null;
    mimeType?: string | null;
  }): Promise<{ id: string; duplicate: boolean; filename: string; kind: FileKind }> {
    const sha = await sha256Hex(opts.data);

    const existing = await sb
      .from("commission_statements")
      .select("id")
      .eq("agent_id", agentId)
      .eq("sha256", sha)
      .maybeSingle();
    if (existing.data?.id) {
      return { id: existing.data.id, duplicate: true, filename: opts.name, kind: opts.fileKind };
    }

    const ins = await sb
      .from("commission_statements")
      .insert({
        agent_id: agentId,
        parent_statement_id: opts.parentId,
        filename: opts.name,
        mime_type: opts.mimeType ?? null,
        size_bytes: opts.data.length,
        sha256: sha,
        file_kind: opts.fileKind,
        source: opts.source,
        status: opts.status,
        status_detail: opts.statusDetail ?? null,
        carrier: sniffCarrier(opts.name),
      })
      .select("id")
      .single();

    if (ins.error || !ins.data) {
      // A concurrent upload of the same bytes lost the race — that is the
      // idempotency guarantee working, not a failure.
      const again = await sb
        .from("commission_statements")
        .select("id").eq("agent_id", agentId).eq("sha256", sha).maybeSingle();
      if (again.data?.id) return { id: again.data.id, duplicate: true, filename: opts.name, kind: opts.fileKind };
      throw new Error(ins.error?.message || "insert_failed");
    }

    const fileIns = await sb.from("statement_files").insert({
      statement_id: ins.data.id,
      agent_id: agentId,
      content: toByteaHex(opts.data),
      byte_size: opts.data.length,
    });
    if (fileIns.error) {
      // The bytes are the evidence. A statement row without them is worse
      // than no statement row, so undo rather than leave a hollow record.
      await sb.from("commission_statements").delete().eq("id", ins.data.id);
      throw new Error(`bytes_not_stored: ${fileIns.error.message}`);
    }

    return { id: ins.data.id, duplicate: false, filename: opts.name, kind: opts.fileKind };
  }

  try {
    if (kind !== "zip") {
      const r = await storeStatement({
        name: filename, data: bytes, fileKind: kind, source: sourceLabel,
        parentId: null, status: "queued", mimeType: mime,
      });
      return json({ ok: true, statements: [r], queued: r.duplicate ? 0 : 1, duplicates: r.duplicate ? 1 : 0 });
    }

    // ---- ZIP: keep the archive, then queue each member separately ----
    let members: { name: string; bytes: Uint8Array }[];
    try {
      members = readZip(bytes);
    } catch (e) {
      return json({ error: "unreadable_zip", detail: String((e as Error).message || e) }, 400);
    }

    const usable = members.filter((m) => {
      if (m.bytes.length === 0 || m.bytes.length > MAX_FILE_BYTES) return false;
      if (m.name.split("/").pop()?.startsWith(".")) return false; // __MACOSX and friends
      return ALLOWED_KINDS.includes(detectFileKind(m.name, m.bytes)) &&
        detectFileKind(m.name, m.bytes) !== "zip"; // one level of nesting only
    });

    if (usable.length === 0) {
      return json({
        error: "empty_zip",
        detail: `${filename} holds no PDF, spreadsheet or CSV we can read.`,
      }, 400);
    }
    if (usable.length > MAX_ZIP_MEMBERS) {
      return json({
        error: "zip_too_many",
        detail: `${filename} holds ${usable.length} statements; the limit is ${MAX_ZIP_MEMBERS} per archive.`,
      }, 413);
    }

    const parent = await storeStatement({
      name: filename, data: bytes, fileKind: "zip", source: sourceLabel,
      parentId: null, status: "ingested",
      statusDetail: `Archive — expanded into ${usable.length} statements`,
      mimeType: mime,
    });

    const results = [];
    for (const m of usable) {
      const memberName = m.name.split("/").pop() || m.name;
      results.push(await storeStatement({
        name: memberName, data: m.bytes, fileKind: detectFileKind(m.name, m.bytes),
        source: "zip_member", parentId: parent.id, status: "queued",
      }));
    }

    if (!parent.duplicate) {
      await sb.from("commission_statements")
        .update({ ingested_at: new Date().toISOString() })
        .eq("id", parent.id);
    }

    return json({
      ok: true,
      archive: parent,
      statements: results,
      queued: results.filter((r) => !r.duplicate).length,
      duplicates: results.filter((r) => r.duplicate).length,
    });
  } catch (e) {
    return json({ error: "upload_failed", detail: String((e as Error).message || e) }, 500);
  }
});
