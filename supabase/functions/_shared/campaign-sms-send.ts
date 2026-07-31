// ============================================================
// campaign-sms-send.ts — the ONE way a campaign text goes out.
//
// ---- The rule this module IS -----------------------------------------------
//
// 🔴 EVERY CAMPAIGN TEXT GOES THROUGH sendCampaignSms(), AND THERE IS NO
// SECOND PATH. This is the text twin of "every campaign call goes through
// ai-call-start". Consent, DNC, suppression and lead-local quiet hours are
// enforced once, here, by runComplianceGate — the same function a hand-typed
// message and a broadcast go through — and neither voice-campaign-tick nor
// voice-campaign-manage contains a copy of any of them. A test greps both for
// `consent_records`, `dnc_list`, `suppression_list` and
// `api.telnyx.com/v2/messages` and asserts they appear in neither.
//
// ---- Why this is not messaging-send-sms ------------------------------------
//
// Because `messaging-send-sms` MEANS "a person typed this". SMS-1 keys the AI
// takeover on exactly that: a send through that function mutes the responder
// on the thread (`agent_takeover`), on the correct reasoning that the only
// thing reaching it is a human at a keyboard. A campaign step routed through
// it would silence the conversation AI on every lead it dripped at, which is
// the opposite of what a drip is for — the drip opens the conversation and the
// responder is what answers it.
//
// So: same gate, same sender resolution, same billing core, same thread
// writer. A different caller, and `sent_by = 'ai'`.
//
// ---- What it does not do ---------------------------------------------------
//
// It does not schedule, claim, advance or stop anything. It renders one
// message, gets it past the gate, sends it, and writes it down. The scheduler
// owns the rest and lives in voice-campaign-tick.
// ============================================================
import { runComplianceGate, resolveTextingNumber } from "./messaging-shared.ts";
import { sendMessageCore } from "./messaging-send-core.ts";
import { countSegments } from "./segments.ts";
import { appendMessage, getOrCreateConversation } from "./sms-thread.ts";
import { renderMergeVars, vcBodyStats, vcMergeValues } from "./voice-campaign-core.ts";
import type { VcLead } from "./voice-campaign-core.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export interface CampaignSmsParams {
  agentId: string;
  /** The destination, in any format — the gate normalises it to E.164. */
  toRaw: string;
  /** The step's body, with merge variables still in it. */
  body: string;
  /** A campaign-media URL. Its presence makes this an MMS. */
  mediaUrl?: string | null;

  /** The lead, for the merge values. Null on a Send Test. */
  lead?: VcLead | null;
  /** The lead's row id, for the conversation. Null on a Send Test. */
  leadId?: string | null;
  agentName?: string | null;
  agencyName?: string | null;
  /** Preferred sending number — the agent's caller ID, if it is sms_capable. */
  preferredFrom?: string | null;

  /** Attribution stamped onto the sms_messages row. */
  campaignId?: string | null;
  campaignStep?: number | null;
  enrollmentId?: string | null;
  /**
   * Which `sms_ai_settings` row the resulting conversation should use. The
   * campaign's `seed_key` where it has one, because the twelve default
   * campaigns' keys ARE the twelve SMS AI campaign types — so a lead dripped
   * by Final Expense gets answered with the Final Expense wording, with no new
   * mapping table and no third place for the two lists to drift apart.
   */
  campaignType?: string | null;

  /**
   * SEND TEST.
   *
   * 🔴 The caller MUST have already proved `toRaw` is one of this agent's own
   * numbers. This flag skips runComplianceGate — not as a shortcut, but
   * because the gate is a consumer-protection gate and the recipient is our
   * customer: there is no consent_records row for an agent's own cell, there
   * should not be one, and manufacturing one to satisfy a check would put a
   * false attestation in the evidence table that carrier review reads.
   *
   * The same treatment the opt-out confirmation and the hot-lead alert
   * already get, and for the same reason.
   */
  test?: boolean;

  /** Render, gate, report — send nothing. What proves the path in production. */
  dryRun?: boolean;
}

export type CampaignSmsResult =
  | {
      ok: true;
      dry_run?: true;
      /** The message exactly as the recipient will read it. */
      rendered: string;
      fromNumber: string;
      channel: "sms" | "mms";
      segments: number;
      /** Present on a real send. */
      messageId?: string;
      providerMessageId?: string | null;
      amountMills?: number;
      conversationId?: string | null;
      smsMessageId?: string | null;
      gatesPassed?: string[];
    }
  | { ok: false; code: string; detail?: string; rendered?: string; fromNumber?: string };

/**
 * The gate chain, named, for the dry-run trace.
 *
 * Written out so a production dry run prints what it actually cleared rather
 * than the word "ok" — the voice round's trace did the same thing and it is
 * what made that verification worth anything.
 */
const GATES = [
  "1 A2P registration approved",
  "2 recipient SMS consent (express written)",
  "3 do-not-contact list",
  "4 lead-local quiet hours",
  "5 sending number is campaign-attached",
];

export async function sendCampaignSms(
  sb: Db,
  params: CampaignSmsParams,
): Promise<CampaignSmsResult> {
  const isTest = params.test === true;

  // ---- 1. The compliance gate --------------------------------------------
  //
  // FIRST, and before the sender is resolved, because the two things it
  // protects — a person who never consented and a person who said stop — do
  // not become less protected because the agent's account is misconfigured.
  // The same ordering principle smsAiGate() states in its own comment.
  let to = String(params.toRaw || "").trim();
  let consentId: string | null = null;

  if (!isTest) {
    const gate = await runComplianceGate(sb, params.agentId, "sms", params.toRaw);
    if (!gate.ok) return { ok: false, code: gate.reason, detail: gate.detail };
    to = gate.normalizedAddress;
    consentId = gate.consentId;
  }

  // ---- 2. Which number may carry it --------------------------------------
  //
  // Owning a number does not make it able to text: `sms_capable` means the
  // number is attached to the agent's approved 10DLC campaign. Sending A2P
  // traffic from an unregistered number is what 10DLC exists to stop, and
  // carriers filter it silently — so it presents as "texts sometimes don't
  // arrive" rather than as a misconfiguration.
  const sender = await resolveTextingNumber(sb, params.agentId, params.preferredFrom || null);
  if (!sender.ok) return { ok: false, code: sender.reason, detail: sender.detail };
  const fromNumber = sender.fromNumber;

  // ---- 3. Render ----------------------------------------------------------
  //
  // AT SEND TIME, from the lead as they are right now. `agentPhone` resolves
  // to the number this message is going out on, which is what makes "call me
  // on this number" true rather than approximately true.
  const values = vcMergeValues({
    lead: params.lead || null,
    agentName: params.agentName,
    agencyName: params.agencyName,
    fromE164: fromNumber,
  });
  const rendered = renderMergeVars(params.body, values);
  const mediaUrl = String(params.mediaUrl || "").trim();
  const channel: "sms" | "mms" = mediaUrl ? "mms" : "sms";

  if (!rendered && !mediaUrl) {
    // A step whose body rendered to nothing is a bug in the body, not a send
    // to attempt. Refusing here costs nothing; sending an empty text costs a
    // segment and reaches a phone.
    return { ok: false, code: "empty_body", detail: "This step rendered to an empty message.", fromNumber };
  }

  const stats = vcBodyStats(params.body, { mediaUrl, countSegments });

  if (params.dryRun === true) {
    return {
      ok: true,
      dry_run: true,
      rendered,
      fromNumber,
      channel,
      segments: stats.segments,
      gatesPassed: isTest ? GATES.slice(4) : GATES,
    };
  }

  // ---- 4. Send, through the shared billing core ---------------------------
  //
  // Authorize-then-capture, exactly as every other send in this app: a
  // messages row, a wallet hold, the provider call, and the hold resolved by
  // messaging-delivery-webhook on the carrier's receipt. Nothing about
  // billing is reimplemented for campaigns.
  const sent = await sendMessageCore(
    {
      agentId: params.agentId,
      channel,
      to,
      fromNumber,
      text: rendered,
      mediaUrls: mediaUrl ? [mediaUrl] : [],
      consentId,
      // Marks the row in the message log without touching the message itself.
      previewPrefix: isTest ? "[Campaign test] " : "",
    },
    {
      sb,
      supabaseUrl: Deno.env.get("SUPABASE_URL")!,
      telnyxApiKey: Deno.env.get("TELNYX_API_KEY")!,
      telnyxMessagingProfileId: Deno.env.get("TELNYX_MESSAGING_PROFILE_ID"),
    },
  );

  if (!sent.ok) {
    return { ok: false, code: sent.error, detail: sent.detail, rendered, fromNumber };
  }

  // ---- 5. Write it into the conversation ----------------------------------
  //
  // A TEST SEND WRITES NO THREAD, deliberately. The agent's own cell is not a
  // lead conversation, and a thread against it would appear in the inbox, be
  // eligible for nudges, and be answerable by the responder — an AI texting
  // its own agent. The `messages` row is the record, and it says
  // "[Campaign test]".
  let conversationId: string | null = null;
  let smsMessageId: string | null = null;

  if (!isTest) {
    const conv = await getOrCreateConversation(sb, {
      agentId: params.agentId,
      contactPhone: to,
      leadId: params.leadId || null,
      agentNumber: fromNumber,
      campaignType: params.campaignType || null,
    });
    if (conv) {
      conversationId = conv.id;
      smsMessageId = await appendMessage(sb, {
        conversationId: conv.id,
        agentId: params.agentId,
        direction: "outbound",
        // `ai`, not `agent`. The distinction is load-bearing twice over: it is
        // what the AI chip renders on the thread, and `agent` is what SMS-1
        // treats as a takeover — so calling a campaign step an agent message
        // would mute the responder on every lead the campaign touched.
        sentBy: "ai",
        body: rendered,
        mediaUrls: mediaUrl ? [mediaUrl] : null,
        messageId: sent.messageId,
        providerMessageId: sent.providerMessageId,
        status: "sent",
      });

      // The campaign attribution, written after the append because
      // appendMessage is shared with three other callers that have no
      // campaign and must not grow a parameter for one.
      if (smsMessageId && params.campaignId) {
        await sb.from("sms_messages").update({
          campaign_id: params.campaignId,
          campaign_step: params.campaignStep ?? null,
          enrollment_id: params.enrollmentId ?? null,
        }).eq("id", smsMessageId);
      }
    }
  }

  return {
    ok: true,
    rendered,
    fromNumber,
    channel,
    segments: sent.segments ?? stats.segments,
    messageId: sent.messageId,
    providerMessageId: sent.providerMessageId,
    amountMills: sent.amountMills,
    conversationId,
    smsMessageId,
  };
}

/**
 * Is this number one the agent has already proved is theirs?
 *
 * 🔴 THE WHOLE SAFETY PROPERTY OF SEND TEST. Without it "test this step" is an
 * uncapped, unlogged way to text any number on earth with no consent record,
 * from an approved 10DLC number — which is precisely the thing the rest of
 * this file exists to make impossible.
 *
 * Four sources, all of them things the agent supplied about themselves:
 *
 *   * `agents.phone_e164` — but ONLY when `phone_verified_at` is set, because
 *     that column is the one an OTP actually proved. An unverified value is a
 *     string somebody typed.
 *   * `agents.transfer_number` — where warm transfers ring. Their cell.
 *   * `agents.signalwire_caller_id` — their outbound caller ID.
 *   * any row in `phone_numbers` they own.
 *
 * The first three are needed because `phone_e164` is NULL for every agent that
 * existed at 20260804: the verification migration grandfathered all nine live
 * agents past the gate rather than locking them out, so `phone_verified_at` is
 * set and `phone_e164` is not. Requiring only the verified column would mean
 * Send Test worked for nobody who currently has an account.
 */
export async function resolveTestDestination(
  sb: Db,
  agentId: string,
  toE164Value: string,
): Promise<{ ok: true; to: string } | { ok: false; code: string; detail: string }> {
  const want = String(toE164Value || "").trim();
  if (!want) {
    return { ok: false, code: "invalid_phone", detail: "Enter a phone number to test with." };
  }

  const [{ data: agent }, { data: owned }] = await Promise.all([
    sb.from("agents")
      .select("phone_e164, phone_verified_at, transfer_number, signalwire_caller_id")
      .eq("id", agentId).maybeSingle(),
    sb.from("phone_numbers").select("e164").eq("agent_id", agentId),
  ]);

  const mine = new Set<string>();
  if (agent?.phone_verified_at && agent?.phone_e164) mine.add(String(agent.phone_e164).trim());
  if (agent?.transfer_number) mine.add(String(agent.transfer_number).trim());
  if (agent?.signalwire_caller_id) mine.add(String(agent.signalwire_caller_id).trim());
  for (const n of owned || []) if (n?.e164) mine.add(String(n.e164).trim());
  mine.delete("");

  if (!mine.has(want)) {
    return {
      ok: false,
      code: "not_your_number",
      detail: "A test can only be sent to one of your own numbers — the mobile you verified, " +
        "your transfer number, or a number on your account. Texting anybody else needs their " +
        "recorded consent, which is what the campaign itself checks on every send.",
    };
  }
  return { ok: true, to: want };
}
