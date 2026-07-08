// ============================================================
// supabase/functions/_shared/gmail-api.ts
//
// Thin Gmail REST helpers for the sync engine. Read-only (gmail.readonly):
// list message ids (incrementally via history.list, or by query via
// messages.list) and fetch just the metadata headers needed to classify.
// We never download bodies here — classification only needs From + Subject,
// which keeps the sync cheap and touches Claude for nothing.
// ============================================================

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

export interface HistoryResult {
  messageIds: string[];
  latestHistoryId?: string;
  notFound: boolean; // startHistoryId too old (404) -> caller should full-scan
}

/**
 * Incremental sync: message ids added since `startHistoryId`. Pages through
 * history. Returns notFound=true on 404 so the caller can fall back to a
 * date-bounded messages.list.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
  maxPages = 10,
): Promise<HistoryResult> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${BASE}/history`);
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("historyTypes", "messageAdded");
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: authHeaders(accessToken) });
    if (res.status === 404) return { messageIds: [], notFound: true };
    if (!res.ok) throw new Error(`history.list ${res.status}: ${await res.text()}`);

    const data = await res.json();
    if (data.historyId) latestHistoryId = data.historyId;
    for (const h of data.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        if (m.message?.id) ids.add(m.message.id);
      }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return { messageIds: [...ids], latestHistoryId, notFound: false };
}

/**
 * Date-bounded scan: message ids matching a Gmail search query (e.g.
 * "newer_than:30d"). Used for first sync, stale-cursor fallback, and manual
 * "Sync now". Capped so a manual scan can't run away.
 */
export async function listMessageIds(
  accessToken: string,
  query: string,
  cap = 250,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < cap) {
    const url = new URL(`${BASE}/messages`);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: authHeaders(accessToken) });
    if (!res.ok) throw new Error(`messages.list ${res.status}: ${await res.text()}`);

    const data = await res.json();
    for (const m of data.messages ?? []) {
      if (m.id) ids.push(m.id);
      if (ids.length >= cap) break;
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return ids;
}

export interface MessageMeta {
  id: string;
  from: string;
  subject: string;
  receivedAt: string | null; // ISO
  hasAttachments: boolean;
}

const headerVal = (headers: Array<{ name: string; value: string }>, name: string) =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function anyAttachment(payload: unknown): boolean {
  const p = payload as { filename?: string; body?: { attachmentId?: string }; parts?: unknown[] } | undefined;
  if (!p) return false;
  if (p.filename && p.body?.attachmentId) return true;
  for (const part of p.parts ?? []) {
    if (anyAttachment(part)) return true;
  }
  return false;
}

/** Fetch just the headers needed to classify (From, Subject, Date) + attachment flag. */
export async function getMessageMeta(accessToken: string, id: string): Promise<MessageMeta> {
  const url = new URL(`${BASE}/messages/${id}`);
  url.searchParams.set("format", "metadata");
  for (const h of ["From", "Subject", "Date"]) url.searchParams.append("metadataHeaders", h);

  const res = await fetch(url, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`messages.get ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const headers = data.payload?.headers ?? [];
  const internalMs = data.internalDate ? Number(data.internalDate) : NaN;

  return {
    id,
    from: headerVal(headers, "From"),
    subject: headerVal(headers, "Subject"),
    receivedAt: Number.isFinite(internalMs) ? new Date(internalMs).toISOString() : null,
    hasAttachments: anyAttachment(data.payload),
  };
}
