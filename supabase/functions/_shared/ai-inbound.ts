// ============================================================
// ai-inbound.ts
// Somebody called the agent's number. Ring the agent first; the AI is backup.
//
// The pure half of this file (the guard, the greetings, the whisper, the lead
// matcher) is dependency-free so it runs under `node --test`. The flow half
// takes its Supabase client and fetch as arguments for the same reason.
//
// ---- Routing ---------------------------------------------------------------
//
// Read docs/ai-inbound-routing.md before changing anything here. The short
// version: there is ONE Telnyx Call Control application, its webhook is
// `telnyx-call-status`, and inbound to any number other than the power-dialer
// host was already a no-op there. That no-op is the seam. Nothing in Telnyx
// moved, and the power dialer's event path is untouched.
//
// After the answer, every further event for the call is redirected to
// `ai-call-webhook` with a per-call `webhook_url` override, so finalize,
// insights, outcomes and the single wallet debit are the EXISTING code — not a
// second copy that can drift.
//
// ---- TCPA ------------------------------------------------------------------
//
// QUIET HOURS DO NOT GATE ANSWERING AN INBOUND CALL. The consumer dialed us;
// refusing to pick up at 9:05pm protects nobody and just loses the call.
// Quiet hours still gate every OUTBOUND side effect — the booking confirmation
// SMS keeps its existing consent + quiet-hours gates in runComplianceGate,
// unchanged and uncontested.
//
// A lead created from an inbound call gets `tcpa_consent = false` and keeps it.
// Calling us is what makes ANSWERING lawful; it is not consent to be dialed by
// an artificial voice tomorrow. ai-call-start's gate must keep refusing them.
// ============================================================

/** How long the agent's phone rings before the AI takes the call. */
export const AGENT_RING_SECS = 15;
/** Hard ceiling on how long the caller hears ringback before SOMEBODY answers. */
export const MAX_PRE_ANSWER_SECS = 20;

/** Digits stripped to the last 10, so +1 vs no-1 compare equal. */
export function last10(num: string | null | undefined): string {
  return (num || "").replace(/\D/g, "").slice(-10);
}

export interface InboundGuardInput {
  eventType: string;
  direction?: string | null;
  to?: string | null;
  /** TELNYX_DIALER_NUMBER — the power-dialer PIN-IVR host. */
  dialerNumber?: string | null;
  /** phone_numbers row for the called number, if any. */
  numberRow?: { ai_inbound_enabled?: boolean | null; status?: string | null } | null;
}

/**
 * Should the AI-inbound flow claim this event?
 *
 * All four conditions, in this order. Anything that fails any of them falls
 * through to the existing telnyx-call-status code byte-for-byte.
 *
 * Condition 3 is the one that matters most: the power-dialer host number must
 * NEVER reach this branch. It is not in `public.phone_numbers` at all, so
 * condition 4 would also catch it — but relying on a row's absence to protect
 * the PIN IVR is one schema edit away from being wrong, so it is checked
 * explicitly too.
 */
export function shouldHandleInbound(i: InboundGuardInput): boolean {
  if (i.eventType !== "call.initiated") return false;
  const dir = (i.direction || "").toLowerCase();
  if (dir !== "incoming" && dir !== "inbound") return false;

  const to = last10(i.to);
  if (!to) return false;

  const dialer = last10(i.dialerNumber);
  if (dialer && to === dialer) return false;   // the power dialer owns this number

  const row = i.numberRow;
  if (!row) return false;
  if (row.status !== "active") return false;
  return row.ai_inbound_enabled === true;
}

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

/** First name from a lead's data blob, ignoring placeholder junk. */
export function leadFirstName(data: Record<string, unknown> | null | undefined): string {
  const d = data || {};
  const raw = clean(d.first_name) || clean(d.name).split(/\s+/)[0] || "";
  return /^(there|null|undefined|unknown|n\/a)$/i.test(raw) ? "" : raw;
}

export interface InboundGreetingVars {
  lead_first?: string;
  lead_type?: string;
  ai_name?: string;
  agent_name?: string;
  agency_name?: string;
  known?: boolean;
}

/**
 * The opening line when the ASSISTANT answers an inbound call.
 *
 * Same contract as buildGreeting() on the outbound side: this string IS the
 * disclosure, every clause is load-bearing, and every fact degrades on its own
 * because in production any of them can be blank.
 *
 * Two shapes, because they are genuinely different conversations:
 *   • a KNOWN lead is calling back  -> name them and name the thing they asked
 *     about. "Thanks for calling back about your final expense coverage" is the
 *     whole reason to look them up.
 *   • an UNKNOWN caller             -> no name to use, so ask for one.
 *
 * What does NOT change between them: "I'm an assistant", on whose behalf, and
 * an open question at the end and nothing after it.
 */
export function buildInboundGreeting(vars: InboundGreetingVars): string {
  const first  = clean(vars.lead_first);
  const aiName = clean(vars.ai_name);            // never defaulted — see CLAUDE.md
  const agent  = clean(vars.agent_name) || "your agent";
  const agency = clean(vars.agency_name);
  const type   = clean(vars.lead_type);

  const who = aiName ? `this is ${aiName}, ` : "";
  const behalf = agency
    ? `${who}an assistant with ${agency}, working with ${agent}`
    : `${who}an assistant working with ${agent}`;

  if (vars.known && first) {
    const about = type ? ` about your ${type} coverage` : "";
    return `Hi ${first} — thanks for calling back${about}. ` +
      `${behalf.charAt(0).toUpperCase()}${behalf.slice(1)}. What can I help you with?`;
  }

  const opener = agency ? `Thanks for calling ${agency}. ` : "Thanks for calling. ";
  return `${opener}${behalf.charAt(0).toUpperCase()}${behalf.slice(1)}. ` +
    `Can I start with your name?`;
}

/**
 * The whisper played to the AGENT on an inbound ring-first.
 *
 * Different from the outbound transfer whisper on purpose: outbound says "hot
 * lead" because the AI already qualified them. Here nobody has spoken to the
 * caller yet, so it says only what is actually known — who is calling — and
 * never implies the call has been screened.
 */
export function buildInboundWhisper(vars: { leadName?: string; leadType?: string }): string {
  const name = clean(vars.leadName);
  const type = clean(vars.leadType);
  const who = name ? name : "an unknown caller";
  const about = name && type ? `, about ${type}` : "";
  return `Incoming call from ${who}${about}. Press 1 to answer.`;
}

/**
 * Match an inbound caller to one of this agent's leads.
 *
 * Matching is on the LAST 10 DIGITS, because `leads.data.phone` is whatever the
 * import or the vendor wrote — "(920) 416-9244", "9204169244" and
 * "+19204169244" are all the same person and all three are in production data.
 * Exact-string matching would greet a returning lead as a stranger.
 *
 * Pure so the rule is testable without a database; the caller does the query.
 */
export function matchLeadByPhone<T extends { data?: Record<string, unknown> | null }>(
  leads: T[],
  callerE164: string,
): T | null {
  const want = last10(callerE164);
  if (!want) return null;
  for (const l of leads) {
    const d = l.data || {};
    for (const k of ["phone", "phone_e164", "mobile", "cell"]) {
      if (last10(d[k] as string) === want) return l;
    }
  }
  return null;
}

/**
 * The `client_id` given to a lead created from an inbound call.
 *
 * Derived from the number so the SAME caller ringing twice cannot create two
 * leads: `leads` is unique on (agent_id, client_id), so the second insert is a
 * conflict rather than a duplicate person in the book.
 */
export function inboundLeadClientId(callerE164: string): string {
  return `inbound-${last10(callerE164)}`;
}

// ============================================================
// The flow. Dependency-injected (client + fetch come in) so the pure rules
// above stay testable and this stays honest about what it touches.
// ============================================================

// deno-lint-ignore no-explicit-any
type Sb = any;

export interface InboundDeps {
  sb: Sb;
  telnyxHeaders: Record<string, string>;
  supabaseUrl: string;
  connectionId: string;
  dialerNumber?: string | null;
  eventType: string;
  direction?: string | null;
  to?: string | null;
  from?: string | null;
  callControlId: string;
  fetchImpl?: typeof fetch;
}

/**
 * Claim an inbound call for the AI flow, if the called number is opted in.
 *
 * Returns true when it took the call (the caller must NOT fall through to any
 * other handler), false when it did nothing at all.
 *
 * THE INBOUND LEG IS NOT ANSWERED ON THE RING-FIRST PATH. The caller keeps
 * hearing normal carrier ringback while the agent's phone rings, which is what
 * makes "the agent picked up" indistinguishable from a normal call. Answering
 * first and holding them on silence would bill from that moment and sound
 * broken.
 */
export async function startInboundIfEnabled(deps: InboundDeps): Promise<boolean> {
  const doFetch = deps.fetchImpl ?? fetch;
  const { sb } = deps;
  const calledE164 = clean(deps.to);
  const callerE164 = clean(deps.from);

  if (deps.eventType !== "call.initiated") return false;
  const dir = clean(deps.direction).toLowerCase();
  if (dir !== "incoming" && dir !== "inbound") return false;
  const to10 = last10(calledE164);
  if (!to10) return false;
  const dialer10 = last10(deps.dialerNumber);
  if (dialer10 && to10 === dialer10) return false;

  // Match on the last 10 digits: the column is E.164 but a lookup that assumes
  // exact formatting is one provisioning change away from silently never
  // matching, and "the AI stopped answering" is hard to notice.
  const { data: numbers } = await sb.from("phone_numbers")
    .select("id, agent_id, e164, status, ai_inbound_enabled")
    .like("e164", `%${to10}`);
  const numberRow = (numbers || []).find(
    (n: { e164: string }) => last10(n.e164) === to10,
  ) || null;

  if (!shouldHandleInbound({
    eventType: deps.eventType, direction: deps.direction, to: calledE164,
    dialerNumber: deps.dialerNumber, numberRow,
  })) return false;

  const agentId: string = numberRow.agent_id;

  const log = async (type: string, detail: unknown) => {
    try {
      await sb.from("ai_call_events").insert({
        call_control_id: deps.callControlId,
        event_type:      type,
        payload:         detail as Record<string, unknown>,
      });
    } catch { /* a logging failure must never change how a call is handled */ }
  };

  const [{ data: agent }, { data: leadRows }] = await Promise.all([
    sb.from("agents")
      .select("id, display_name, agency_name, ai_agent_name, ai_voice, ai_dialer_enabled, ai_availability, transfer_number")
      .eq("id", agentId).maybeSingle(),
    sb.from("leads").select("id, data, lead_timezone, dnc")
      .eq("agent_id", agentId)
      .like("data->>phone", `%${last10(callerE164)}`)
      .limit(25),
  ]);

  // The per-agent AI kill switch still applies to inbound. A number flagged
  // ai_inbound_enabled on an account whose AI dialer is off should ring out,
  // not be answered by an assistant they turned off.
  if (!agent || !agent.ai_dialer_enabled) {
    await log("inbound.skipped", { reason: "ai_dialer_enabled=false", agent_id: agentId });
    return false;
  }

  let lead = matchLeadByPhone(
    (leadRows || []) as Array<{ id: string; data: Record<string, unknown> }>,
    callerE164,
  ) as { id: string; data: Record<string, unknown> } | null;

  // Captured BEFORE the row below is created, and this ordering is the whole
  // point: `known` decides whether the assistant says "thanks for calling
  // back". Reading it after creating a placeholder lead would greet every
  // first-time caller as a returning one — warmly, by a name we do not have.
  const wasKnown = !!lead;

  // ---- A caller we have never seen becomes a lead, right now --------------
  //
  // Eagerly, before anyone answers, and regardless of who ends up taking the
  // call. Someone who rang the agency and hung up after thirty seconds is
  // still a person who rang the agency; leaving them out of the book because
  // they did not book an appointment loses the most interesting inbound lead
  // there is.
  //
  // Deduped by a client_id derived from the number (`inbound-<last10>`), so the
  // same caller ringing five times is one row — `leads` is unique on
  // (agent_id, client_id), which turns a second insert into a conflict instead
  // of a duplicate person.
  if (!lead && callerE164) {
    const row = buildInboundLeadRow({
      agentId: agentId, callerE164, calledE164, now: new Date().toISOString(),
    });
    const { data: created, error: leadErr } = await sb.from("leads")
      .upsert(row, { onConflict: "agent_id,client_id" })
      .select("id, data").maybeSingle();
    if (created) {
      lead = created as { id: string; data: Record<string, unknown> };
      await log("inbound.lead_created", { lead_id: created.id, client_id: row.client_id });
    } else {
      await log("inbound.lead_create_failed", { message: leadErr?.message });
    }
  }

  const leadData = (lead?.data || {}) as Record<string, unknown>;
  const leadName = clean(leadData.name) ||
    [clean(leadData.first_name), clean(leadData.last_name)].filter(Boolean).join(" ").trim();
  const leadType = clean(leadData.coverage_wanted) || clean(leadData.lead_type) || clean(leadData.type);

  const vars: Record<string, string> = {
    lead_name:   leadName,
    lead_first:  leadFirstName(leadData),
    lead_state:  clean(leadData.state),
    lead_type:   leadType,
    agent_name:  clean(agent.display_name) || "your agent",
    agency_name: clean(agent.agency_name) || clean(agent.display_name),
    ai_name:     clean(agent.ai_agent_name),
    voice:       clean(agent.ai_voice),
    inbound:     "1",
    known:       wasKnown ? "1" : "",
  };

  const { data: aiCall, error: insErr } = await sb.from("ai_calls").insert({
    agent_id:        agentId,
    lead_id:         lead?.id ?? null,
    phone_e164:      callerE164,
    from_e164:       calledE164,
    call_control_id: deps.callControlId,
    direction:       "inbound",
    status:          "in_progress",
    outcome:         "in_progress",
    voice:           vars.voice || null,
    started_at:      new Date().toISOString(),
  }).select("id").single();

  if (insErr || !aiCall) {
    await log("inbound.row_insert_failed", { message: insErr?.message });
    return false; // never swallow a call we cannot track
  }

  await log("inbound.claimed", {
    called: calledE164, caller: callerE164, agent_id: agentId,
    ai_call_id: aiCall.id, known_lead: wasKnown, lead_id: lead?.id ?? null,
    availability: agent.ai_availability, has_transfer_number: !!clean(agent.transfer_number),
  });

  const aiState = btoa(JSON.stringify({ role: "ai_call", ai_call_id: aiCall.id, vars }));
  const aiWebhook = `${deps.supabaseUrl}/functions/v1/ai-call-webhook`;

  /** Answer the caller ourselves and hand the whole call to the assistant. */
  const answerWithAi = async (why: string): Promise<boolean> => {
    await sb.from("ai_calls").update({ answered_by: "ai" }).eq("id", aiCall.id);
    const res = await doFetch(
      `https://api.telnyx.com/v2/calls/${deps.callControlId}/actions/answer`,
      {
        method: "POST",
        headers: deps.telnyxHeaders,
        body: JSON.stringify({
          client_state: aiState,
          // THE ROUTING HINGE. Every subsequent webhook for this call goes to
          // ai-call-webhook, which already owns the assistant start, the
          // insight parsing, finalize and the single wallet debit. Without
          // this override they would keep arriving at telnyx-call-status,
          // which knows none of it.
          webhook_url:        aiWebhook,
          webhook_url_method: "POST",
          command_id:         crypto.randomUUID(),
        }),
      },
    ).catch(() => null);

    if (!res || !res.ok) {
      const detail = res ? await res.text().catch(() => "") : "network_error";
      await log("inbound.answer_failed", { why, status: res ? res.status : "network_error", body: detail.slice(0, 600) });
      await sb.from("ai_calls").update({
        status: "error", outcome: "error", answered_by: "none",
        error_detail: `inbound answer failed: ${detail.slice(0, 400)}`,
        ended_at: new Date().toISOString(),
      }).eq("id", aiCall.id);
      return false;
    }
    await log("inbound.answered_by_ai", { why });
    return true;
  };

  // ---- Busy, or nowhere to ring: the AI answers straight away -------------
  const available = clean(agent.ai_availability) === "available";
  const transferTo = clean(agent.transfer_number);
  if (!available || !transferTo) {
    await sb.from("ai_calls").update({ transfer_status: "none" }).eq("id", aiCall.id);
    await answerWithAi(available ? "no transfer_number" : "agent busy");
    return true;
  }

  // ---- Available: ring the agent FIRST -----------------------------------
  const agentState = btoa(JSON.stringify({
    role:       "inbound_agent_leg",
    ai_call_id: aiCall.id,
    lead_ccid:  deps.callControlId,
    vars,
    whisper:    buildInboundWhisper({ leadName, leadType }),
  }));

  // from_display_name is sanitised to Telnyx's documented charset. It is
  // decoration — a 422 on it once took the entire outbound warm transfer down
  // (see ai-call-tools) — so it is also dropped entirely on a retry.
  const displayName = (leadName || "Incoming call")
    .replace(/[^A-Za-z0-9 \-_~!.+]/g, " ").replace(/\s+/g, " ").trim().slice(0, 128);

  const dialBody: Record<string, unknown> = {
    connection_id: deps.connectionId,
    to:   transferTo,
    from: calledE164,               // the number they dialed, so caller ID reads right
    answering_machine_detection: "premium",
    // Shorter than a typical carrier voicemail pickup. Together with the
    // press-1 gate this is why the agent's voicemail can never "answer" an
    // inbound call: a machine cannot press a key.
    timeout_secs:    AGENT_RING_SECS,
    time_limit_secs: 1800,
    webhook_url:        aiWebhook,
    webhook_url_method: "POST",
    client_state:       agentState,
  };

  let dialRes: Response | null = null;
  for (const body of [{ ...dialBody, from_display_name: displayName }, dialBody]) {
    dialRes = await doFetch("https://api.telnyx.com/v2/calls", {
      method: "POST", headers: deps.telnyxHeaders, body: JSON.stringify(body),
    }).catch(() => null);
    if (dialRes && dialRes.ok) break;
    const d = dialRes ? await dialRes.text().catch(() => "") : "network_error";
    await log("inbound.agent_dial_rejected", { status: dialRes ? dialRes.status : "network_error", body: d.slice(0, 600) });
  }

  if (!dialRes || !dialRes.ok) {
    // Could not ring the agent at all — do not punish the caller for it.
    await sb.from("ai_calls").update({ transfer_status: "failed" }).eq("id", aiCall.id);
    await answerWithAi("agent dial failed");
    return true;
  }

  const agentCcid = (await dialRes.json().catch(() => ({})))?.data?.call_control_id || "";
  await sb.from("ai_calls").update({
    transfer_status: "ringing_agent",
    transfer_to:     transferTo,
    transfer_call_control_id: agentCcid || null,
  }).eq("id", aiCall.id);
  await log("inbound.ringing_agent", { to: transferTo, agent_call_control_id: agentCcid, ring_secs: AGENT_RING_SECS });
  return true;
}

/**
 * The caller gave up while the agent's phone was still ringing.
 *
 * Called from telnyx-call-status for a pre-answer `call.hangup` (the only
 * other event an AI-inbound call delivers there). Kills the agent leg so a
 * phone does not keep ringing for a caller who is already gone.
 */
export async function cancelInboundIfAbandoned(deps: {
  sb: Sb;
  telnyxHeaders: Record<string, string>;
  callControlId: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const doFetch = deps.fetchImpl ?? fetch;
  const { data: row } = await deps.sb.from("ai_calls")
    .select("id, transfer_call_control_id, transfer_status, status")
    .eq("call_control_id", deps.callControlId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (!row || row.status === "completed") return false;

  const st = row.transfer_status || "";
  if (row.transfer_call_control_id && (st === "ringing_agent" || st === "whisper")) {
    await doFetch(
      `https://api.telnyx.com/v2/calls/${row.transfer_call_control_id}/actions/hangup`,
      { method: "POST", headers: deps.telnyxHeaders, body: JSON.stringify({ command_id: crypto.randomUUID() }) },
    ).catch(() => {});
  }

  await deps.sb.from("ai_calls").update({
    status: "completed", outcome: "no_answer", answered_by: "none",
    transfer_status: st === "ringing_agent" || st === "whisper" ? "agent_no_answer" : row.transfer_status,
    duration_secs: 0, billed_minutes: 0, ended_at: new Date().toISOString(),
  }).eq("id", row.id);

  try {
    await deps.sb.from("ai_call_events").insert({
      call_control_id: deps.callControlId,
      event_type:      "inbound.caller_abandoned",
      payload:         { transfer_status: st },
    });
  } catch { /* non-fatal */ }
  return true;
}

/** The row an unknown inbound caller becomes. */
export function buildInboundLeadRow(opts: {
  agentId: string;
  callerE164: string;
  calledE164: string;
  timezone?: string | null;
  now: string;
}): Record<string, unknown> {
  const clientId = inboundLeadClientId(opts.callerE164);
  return {
    agent_id:  opts.agentId,
    client_id: clientId,
    data: {
      id:         clientId,
      name:       "",                      // the assistant asks; nothing invents one
      phone:      opts.callerE164,
      source:     "inbound_call",
      lead_type:  "",
      status:     "new",
      created_via: "ai_inbound",
      called_number: opts.calledE164,
      importedAt: opts.now,
    },
    // FALSE, and it stays false. They called us — that makes answering lawful,
    // not being dialed by an artificial voice later. See the header note.
    tcpa_consent: false,
    dnc:          false,
    lead_timezone: opts.timezone || null,
  };
}
