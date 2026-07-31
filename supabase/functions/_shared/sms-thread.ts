// ============================================================
// sms-thread.ts — the conversation record's write path.
//
// Four callers, one implementation: messaging-inbound-webhook (a lead texted),
// sms-ai-respond (the AI answered), messaging-send-sms (a person typed), and
// sms-ai-nudge-sweep (a follow-up went out). Every one of them has to append a
// row, keep the conversation's stamps straight and get the nudge bookkeeping
// right, and four copies of that would drift within a month.
//
// PURE-ISH BY CONSTRUCTION: every function takes the Supabase client as an
// argument and returns data, so the decisions live in sms-ai-core.ts and this
// module only writes them down.
// ============================================================
import {
  type NudgeCancelReason,
  type SmsAiSettings,
  nextNudge,
  shouldAutoMute,
} from "./sms-ai-core.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export interface Conversation {
  id: string;
  agent_id: string;
  lead_id: string | null;
  contact_phone: string;
  agent_number: string | null;
  status: string;
  ai_muted: boolean;
  ai_muted_reason: string | null;
  hot: boolean;
  hot_alerted_at: string | null;
  campaign_type: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  nudge_step: number;
}

const CONV_COLS =
  "id, agent_id, lead_id, contact_phone, agent_number, status, ai_muted, ai_muted_reason, " +
  "hot, hot_alerted_at, campaign_type, last_inbound_at, last_outbound_at, nudge_step";

/**
 * Find the thread for this (agent, contact), or start one.
 *
 * An UPSERT on the unique index rather than select-then-insert: two inbound
 * webhooks for the same contact can land in the same second (a lead sending
 * two texts), and the read-then-write version of this loses one of them to a
 * 23505 that nothing catches.
 */
export async function getOrCreateConversation(
  sb: Db,
  opts: {
    agentId: string;
    contactPhone: string;
    leadId?: string | null;
    agentNumber?: string | null;
    campaignType?: string | null;
  },
): Promise<Conversation | null> {
  const { data: existing } = await sb.from("sms_conversations")
    .select(CONV_COLS)
    .eq("agent_id", opts.agentId)
    .eq("contact_phone", opts.contactPhone)
    .maybeSingle();

  if (existing) {
    // Fill in anything we have learned since. Never blanks a value we already
    // hold: a lead_id, once known, is not un-known by a later text.
    const patch: Record<string, unknown> = {};
    if (opts.leadId && !existing.lead_id) patch.lead_id = opts.leadId;
    if (opts.agentNumber && opts.agentNumber !== existing.agent_number) patch.agent_number = opts.agentNumber;
    if (opts.campaignType && !existing.campaign_type) patch.campaign_type = opts.campaignType;
    if (Object.keys(patch).length) {
      await sb.from("sms_conversations").update(patch).eq("id", existing.id);
      Object.assign(existing, patch);
    }
    return existing as Conversation;
  }

  const { data: created, error } = await sb.from("sms_conversations")
    .insert({
      agent_id: opts.agentId,
      lead_id: opts.leadId ?? null,
      contact_phone: opts.contactPhone,
      agent_number: opts.agentNumber ?? null,
      campaign_type: opts.campaignType ?? null,
    })
    .select(CONV_COLS)
    .maybeSingle();

  if (created) return created as Conversation;

  // Lost the race — the other writer created it, which is the desired end
  // state. Read theirs.
  if (error && /duplicate key|23505/i.test(error.message || "")) {
    const { data: raced } = await sb.from("sms_conversations")
      .select(CONV_COLS)
      .eq("agent_id", opts.agentId)
      .eq("contact_phone", opts.contactPhone)
      .maybeSingle();
    return (raced as Conversation) ?? null;
  }

  console.error("[sms-thread] conversation insert failed:", error?.message);
  return null;
}

export interface AppendOpts {
  conversationId: string;
  agentId: string;
  direction: "inbound" | "outbound";
  sentBy: "ai" | "agent" | "system" | "lead";
  body: string;
  mediaUrls?: string[] | null;
  messageId?: string | null;
  inboundMessageId?: string | null;
  providerMessageId?: string | null;
  status?: string | null;
  failedReason?: string | null;
}

/**
 * Append one message to the thread and move the conversation's clock.
 *
 * The stamps are updated in the same call because a thread whose
 * last_inbound_at disagrees with its newest inbound row schedules the wrong
 * nudge, and that is only ever noticed when a consumer gets a follow-up they
 * should not have.
 */
export async function appendMessage(sb: Db, opts: AppendOpts): Promise<string | null> {
  const { data, error } = await sb.from("sms_messages").insert({
    conversation_id: opts.conversationId,
    agent_id: opts.agentId,
    direction: opts.direction,
    sent_by: opts.sentBy,
    body: (opts.body || "").slice(0, 4000),
    media_urls: opts.mediaUrls && opts.mediaUrls.length ? opts.mediaUrls : null,
    message_id: opts.messageId ?? null,
    inbound_message_id: opts.inboundMessageId ?? null,
    provider_message_id: opts.providerMessageId ?? null,
    status: opts.status ?? null,
    failed_reason: opts.failedReason ?? null,
  }).select("id").maybeSingle();

  if (error) {
    // The inbound unique index is the dedupe path, not an error worth shouting
    // about — Telnyx retries webhooks by design.
    if (!/duplicate key|23505/i.test(error.message || "")) {
      console.error("[sms-thread] message insert failed:", error.message);
    }
    return null;
  }

  const nowIso = new Date().toISOString();
  await sb.from("sms_conversations").update(
    opts.direction === "inbound" ? { last_inbound_at: nowIso } : { last_outbound_at: nowIso },
  ).eq("id", opts.conversationId);

  return data?.id ?? null;
}

/**
 * Mute the AI on this thread.
 *
 * Idempotent and never un-mutes: every caller here is a reason to stop, and a
 * second reason arriving must not look like a resume.
 */
export async function muteAi(
  sb: Db,
  conversationId: string,
  reason: "agent_takeover" | "agent_toggle" | "opted_out" | "booked",
): Promise<void> {
  await sb.from("sms_conversations").update({
    ai_muted: true,
    ai_muted_reason: reason,
    ai_muted_at: new Date().toISOString(),
  }).eq("id", conversationId).eq("ai_muted", false);
}

/** Auto-mute after a human types. Does nothing for ai/system sends — see shouldAutoMute(). */
export async function autoMuteIfAgentWrote(
  sb: Db,
  conversationId: string,
  sentBy: string,
): Promise<boolean> {
  if (!shouldAutoMute(sentBy)) return false;
  await muteAi(sb, conversationId, "agent_takeover");
  return true;
}

// ------------------------------------------------------------
// Nudges
// ------------------------------------------------------------

/**
 * Cancel whatever follow-up is pending on this thread.
 *
 * Called from every one of NUDGE_CANCEL_REASONS. It is deliberately safe to
 * call when nothing is scheduled: the alternative is every caller checking
 * first, and the one that forgets is the one that texts somebody after they
 * said stop.
 */
export async function cancelNudges(
  sb: Db,
  conversationId: string,
  reason: NudgeCancelReason,
): Promise<number> {
  const { data } = await sb.from("sms_nudges")
    .update({ status: "cancelled", cancel_reason: reason })
    .eq("conversation_id", conversationId)
    .eq("status", "scheduled")
    .select("id");
  return (data || []).length;
}

/**
 * Schedule the next follow-up, replacing any pending one.
 *
 * `afterStep` is the conversation's current nudge_step, so the schedule walks
 * forward and never repeats a step. Returns the row it wrote, or null when the
 * schedule is exhausted or switched off — which is a normal, quiet ending, not
 * a failure.
 */
export async function scheduleNextNudge(
  sb: Db,
  opts: {
    conversationId: string;
    agentId: string;
    settings: SmsAiSettings;
    lastInboundAt: string | Date | null;
    afterStep: number;
  },
): Promise<{ step: number; dueAt: string } | null> {
  const next = nextNudge(opts.settings, opts.lastInboundAt, opts.afterStep);
  if (!next) {
    await cancelNudges(sb, opts.conversationId, "settings_disabled");
    return null;
  }

  // One live nudge per conversation is enforced by a partial unique index, so
  // the pending one has to go before the new one lands.
  await sb.from("sms_nudges")
    .update({ status: "cancelled", cancel_reason: "lead_replied" })
    .eq("conversation_id", opts.conversationId)
    .eq("status", "scheduled");

  const { error } = await sb.from("sms_nudges").insert({
    conversation_id: opts.conversationId,
    agent_id: opts.agentId,
    step: next.step,
    due_at: next.dueAt.toISOString(),
  });
  if (error) {
    console.error("[sms-thread] nudge insert failed:", error.message);
    return null;
  }

  return { step: next.step, dueAt: next.dueAt.toISOString() };
}

/**
 * Everything a STOP has to do to a thread, in one place.
 *
 * The prompt asked us to verify the existing STOP path did four things. It did
 * two — it suppressed (dnc_list) and it confirmed from the originating number.
 * It closed no conversation and cancelled no scheduled sends because neither
 * existed. These are the other two, now that they do.
 */
export async function closeConversationForOptOut(
  sb: Db,
  conversationId: string,
): Promise<{ cancelled: number }> {
  const cancelled = await cancelNudges(sb, conversationId, "opted_out");
  await sb.from("sms_conversations").update({
    status: "closed",
    closed_reason: "opted_out",
    closed_at: new Date().toISOString(),
    ai_muted: true,
    ai_muted_reason: "opted_out",
    ai_muted_at: new Date().toISOString(),
    hot: false,
  }).eq("id", conversationId);
  return { cancelled };
}

/**
 * The settings row for a thread, falling back to `default`, falling back to
 * the built-in defaults. Never returns null — an agent who has configured
 * nothing still gets a working responder.
 */
export async function loadSettings(
  sb: Db,
  agentId: string,
  campaignType: string | null | undefined,
  // deno-lint-ignore no-explicit-any
  normalize: (row: any) => SmsAiSettings,
): Promise<SmsAiSettings> {
  const wanted = String(campaignType || "default");
  const { data: rows } = await sb.from("sms_ai_settings")
    .select("*")
    .eq("agent_id", agentId)
    .in("campaign_type", wanted === "default" ? ["default"] : [wanted, "default"]);

  const list = rows || [];
  const exact = list.find((r: { campaign_type?: string }) => r.campaign_type === wanted);
  const fallback = list.find((r: { campaign_type?: string }) => r.campaign_type === "default");
  return normalize(exact || fallback || { campaign_type: wanted });
}
