import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { toE164 } from "./phone.ts";

// Re-exported so existing importers of toE164 from this module keep working
// unchanged — the canonical implementation now lives in _shared/phone.ts
// (shared with the messaging compliance gate and inbound webhooks).
export { toE164 };

export type DialerSession = {
  id: string;
  agent_id: string;
  lead_ids: string[];
  current_index: number;
  status: string;
  conference_id: string | null;
  agent_call_control_id: string | null;
  current_call_control_id: string | null;
  current_call_row_id: string | null;
  // Caller ID configuration (added in 20260618 migration)
  caller_id_mode: "fixed" | "smart_local" | null;
  caller_id_fixed: string | null;
  caller_id_numbers: string[] | null;
  current_caller_id: string | null;
  // Human-readable reason the most recent lead was skipped without ever
  // being dialed (missing phone, missing lead row, no caller ID). Cleared
  // back to null on the next successful dial. Added in 20260709e migration.
  last_skip_reason?: string | null;
};

// US area code → state abbreviation (all active NANP codes as of 2025)
const AC_STATE: Record<string, string> = {
  "205":"AL","251":"AL","256":"AL","334":"AL","938":"AL",
  "907":"AK",
  "480":"AZ","520":"AZ","602":"AZ","623":"AZ","928":"AZ",
  "479":"AR","501":"AR","870":"AR",
  "209":"CA","213":"CA","279":"CA","310":"CA","323":"CA","408":"CA",
  "415":"CA","424":"CA","442":"CA","510":"CA","530":"CA","559":"CA",
  "562":"CA","619":"CA","626":"CA","628":"CA","650":"CA","657":"CA",
  "661":"CA","669":"CA","707":"CA","714":"CA","747":"CA","760":"CA",
  "805":"CA","818":"CA","820":"CA","831":"CA","858":"CA","909":"CA",
  "916":"CA","925":"CA","949":"CA","951":"CA",
  "303":"CO","719":"CO","720":"CO","970":"CO",
  "203":"CT","475":"CT","860":"CT","959":"CT",
  "302":"DE",
  "202":"DC",
  "239":"FL","305":"FL","321":"FL","352":"FL","386":"FL","407":"FL",
  "561":"FL","689":"FL","727":"FL","754":"FL","772":"FL","786":"FL",
  "813":"FL","850":"FL","863":"FL","904":"FL","941":"FL","954":"FL",
  "229":"GA","404":"GA","470":"GA","478":"GA","678":"GA","706":"GA",
  "762":"GA","770":"GA","912":"GA",
  "808":"HI",
  "208":"ID","986":"ID",
  "217":"IL","224":"IL","309":"IL","312":"IL","331":"IL","447":"IL",
  "464":"IL","618":"IL","630":"IL","708":"IL","773":"IL","779":"IL",
  "815":"IL","847":"IL","872":"IL",
  "219":"IN","260":"IN","317":"IN","463":"IN","574":"IN","765":"IN",
  "812":"IN","930":"IN",
  "319":"IA","515":"IA","563":"IA","641":"IA","712":"IA",
  "316":"KS","620":"KS","785":"KS","913":"KS",
  "270":"KY","364":"KY","502":"KY","606":"KY","859":"KY",
  "225":"LA","318":"LA","337":"LA","504":"LA","985":"LA",
  "207":"ME",
  "240":"MD","301":"MD","410":"MD","443":"MD","667":"MD",
  "339":"MA","351":"MA","413":"MA","508":"MA","617":"MA","774":"MA",
  "781":"MA","857":"MA","978":"MA",
  "231":"MI","248":"MI","269":"MI","313":"MI","517":"MI","586":"MI",
  "616":"MI","679":"MI","734":"MI","810":"MI","906":"MI","947":"MI","989":"MI",
  "218":"MN","320":"MN","507":"MN","612":"MN","651":"MN","763":"MN","952":"MN",
  "228":"MS","601":"MS","662":"MS","769":"MS",
  "314":"MO","417":"MO","573":"MO","636":"MO","660":"MO","816":"MO",
  "406":"MT",
  "308":"NE","402":"NE","531":"NE",
  "702":"NV","725":"NV","775":"NV",
  "603":"NH",
  "201":"NJ","551":"NJ","609":"NJ","640":"NJ","732":"NJ","848":"NJ",
  "856":"NJ","862":"NJ","908":"NJ","973":"NJ",
  "505":"NM","575":"NM",
  "212":"NY","315":"NY","332":"NY","347":"NY","516":"NY","518":"NY",
  "585":"NY","607":"NY","631":"NY","646":"NY","680":"NY","716":"NY",
  "718":"NY","838":"NY","845":"NY","914":"NY","917":"NY","929":"NY","934":"NY",
  "252":"NC","336":"NC","704":"NC","743":"NC","828":"NC","910":"NC",
  "919":"NC","980":"NC","984":"NC",
  "701":"ND",
  "216":"OH","220":"OH","234":"OH","330":"OH","380":"OH","419":"OH",
  "440":"OH","513":"OH","567":"OH","614":"OH","740":"OH","937":"OH",
  "405":"OK","539":"OK","580":"OK","918":"OK",
  "458":"OR","503":"OR","541":"OR","971":"OR",
  "215":"PA","223":"PA","267":"PA","272":"PA","412":"PA","445":"PA",
  "484":"PA","570":"PA","582":"PA","610":"PA","717":"PA","724":"PA",
  "814":"PA","878":"PA",
  "401":"RI",
  "803":"SC","839":"SC","843":"SC","854":"SC","864":"SC",
  "605":"SD",
  "423":"TN","615":"TN","629":"TN","731":"TN","865":"TN","901":"TN","931":"TN",
  "210":"TX","214":"TX","254":"TX","281":"TX","325":"TX","346":"TX",
  "361":"TX","409":"TX","430":"TX","432":"TX","469":"TX","512":"TX",
  "682":"TX","713":"TX","737":"TX","806":"TX","817":"TX","830":"TX",
  "832":"TX","903":"TX","915":"TX","936":"TX","940":"TX","945":"TX",
  "956":"TX","972":"TX","979":"TX",
  "385":"UT","435":"UT","801":"UT",
  "802":"VT",
  "276":"VA","434":"VA","540":"VA","571":"VA","703":"VA","757":"VA","804":"VA",
  "206":"WA","253":"WA","360":"WA","425":"WA","509":"WA","564":"WA",
  "304":"WV","681":"WV",
  "262":"WI","414":"WI","534":"WI","608":"WI","715":"WI","920":"WI",
  "307":"WY",
};

// Adjacent US states for proximity fallback when no same-state number exists.
const STATE_NEIGHBORS: Record<string, string[]> = {
  "AL":["FL","GA","MS","TN"],       "AK":[],
  "AZ":["CA","CO","NM","NV","UT"],  "AR":["LA","MO","MS","OK","TN","TX"],
  "CA":["AZ","NV","OR"],            "CO":["AZ","KS","NE","NM","OK","UT","WY"],
  "CT":["MA","NY","RI"],            "DE":["MD","NJ","PA"],
  "DC":["MD","VA"],                 "FL":["AL","GA"],
  "GA":["AL","FL","NC","SC","TN"],  "HI":[],
  "ID":["MT","NV","OR","UT","WA","WY"],
  "IL":["IN","IA","KY","MI","MO","WI"],
  "IN":["IL","KY","MI","OH"],       "IA":["IL","MN","MO","NE","SD","WI"],
  "KS":["CO","MO","NE","OK"],
  "KY":["IL","IN","MO","OH","TN","VA","WV"],
  "LA":["AR","MS","TX"],            "ME":["NH"],
  "MD":["DC","DE","PA","VA","WV"],
  "MA":["CT","NH","NY","RI","VT"],
  "MI":["IL","IN","MN","OH","WI"],  "MN":["IA","ND","SD","WI"],
  "MS":["AL","AR","LA","TN"],
  "MO":["AR","IL","IA","KS","KY","NE","OK","TN"],
  "MT":["ID","ND","SD","WY"],       "NE":["CO","IA","KS","MO","SD","WY"],
  "NV":["AZ","CA","ID","OR","UT"],  "NH":["MA","ME","VT"],
  "NJ":["DE","NY","PA"],            "NM":["AZ","CO","OK","TX","UT"],
  "NY":["CT","MA","NJ","PA","VT"],
  "NC":["GA","SC","TN","VA"],       "ND":["MN","MT","SD"],
  "OH":["IN","KY","MI","PA","WV"],  "OK":["AR","CO","KS","MO","NM","TX"],
  "OR":["CA","ID","NV","WA"],
  "PA":["DE","MD","NJ","NY","OH","WV"],
  "RI":["CT","MA"],                 "SC":["GA","NC"],
  "SD":["IA","MN","MT","ND","NE","WY"],
  "TN":["AL","AR","GA","KY","MS","MO","NC","VA"],
  "TX":["AR","LA","NM","OK"],       "UT":["AZ","CO","ID","NM","NV","WY"],
  "VT":["MA","NH","NY"],            "VA":["DC","KY","MD","NC","TN","WV"],
  "WA":["ID","OR"],                 "WV":["KY","MD","OH","PA","VA"],
  "WI":["IL","IA","MI","MN"],       "WY":["CO","ID","MT","NE","SD","UT"],
};

function areaCodeToState(e164: string): string {
  const digits = e164.replace(/[^\d]/g, "").slice(-10);
  return AC_STATE[digits.slice(0, 3)] ?? "";
}

// Pick the caller ID to use for a given lead call.
//
// Fixed mode: always uses caller_id_fixed (or falls back to fallback).
// Smart Local: matches by US state (same state = best, neighboring state =
// second best, any other = 0), then rotates among equally-ranked numbers
// so calls are spread evenly across all purchased numbers.
export function selectCallerId(
  mode: string | null,
  numbers: string[] | null,
  fixed: string | null,
  fallback: string,
  leadPhone: string,
  callIndex: number,
): string {
  const pool = numbers?.filter(Boolean) ?? [];

  if (!mode || mode === "fixed") {
    return fixed || (pool.length > 0 ? pool[0] : fallback);
  }

  // Smart Local
  if (pool.length === 0) return fixed || fallback;
  if (pool.length === 1) return pool[0];

  const leadState = areaCodeToState(leadPhone);

  // Score: 3 = same state, 2 = neighboring state, 0 = neither.
  const scored = pool.map((num) => {
    if (!leadState) return { num, score: 0 };
    const numState = areaCodeToState(num);
    if (!numState) return { num, score: 0 };
    if (numState === leadState) return { num, score: 3 };
    if (STATE_NEIGHBORS[leadState]?.includes(numState)) return { num, score: 2 };
    return { num, score: 0 };
  });

  const maxScore = Math.max(...scored.map((s) => s.score));
  const best = scored.filter((s) => s.score === maxScore);

  // Rotate among equally-ranked matches for even distribution.
  return best[callIndex % best.length].num;
}

// DEPRECATED (wallet migration): calls used to report elapsed minutes to
// Stripe metered billing here (creating/reusing a per-agent subscription
// item, then posting a `call_minutes` meter event). That path is replaced
// by reportMinutesToWallet below, which debits the prepaid wallet
// directly instead of accumulating Stripe usage records. agents.stripe_
// minutes_item_id is left in place (unread) so Cowork can unwind any live
// metered subscription items before they next bill.

// Resolves the wallet cost of a completed call at billing_config.
// call_minute_mills per minute (Math.ceil-rounded, 1 min minimum for
// answered calls — unchanged from the old Stripe rounding; 0 for calls
// that never connected). Best-effort: a failure is logged, not thrown, so
// it never blocks call teardown. Idempotency is guaranteed by
// closeCallRowById's caller — this is only ever invoked once per call row
// because closeCallRowById no-ops on an already-completed row.
//
// If holdLedgerId is set (the universal spend gate placed a wallet_hold
// before this call was dialed — see wallet-hold-call and dialNextLead),
// reconciles that hold via wallet_settle_call: refunds the unused portion
// for a short/unanswered call, or charges the extra (clamped, logging any
// uncollectible shortfall) for a call that ran past the held estimate.
// Falls back to a plain wallet_debit for call rows that predate the spend
// gate and never got a hold.
export async function reportMinutesToWallet(
  sb: ReturnType<typeof createClient>,
  agentId: string,
  durationSec: number,
  callRowId: string,
  holdLedgerId?: string | null,
) {
  if (!agentId || !callRowId) return;
  try {
    const { data: config } = await sb.from("billing_config")
      .select("call_minute_mills")
      .eq("id", 1)
      .maybeSingle();
    const rateMills = config?.call_minute_mills ?? 10;

    const minutes = durationSec > 0 ? Math.max(1, Math.ceil(durationSec / 60)) : 0;
    const amountMills = minutes * rateMills;
    const desc = minutes > 0
      ? `Outbound call — ${minutes} min @ $${(rateMills / 1000).toFixed(3)}/min`
      : "Outbound call — not answered, no charge";

    if (holdLedgerId) {
      const { error } = await sb.rpc("wallet_settle_call", {
        p_hold_ledger_id:      holdLedgerId,
        p_actual_amount_mills: amountMills,
        p_units:               minutes || null,
        p_ref_type:            "call",
        p_ref_id:              callRowId,
        p_desc:                desc,
      });
      if (error) {
        console.warn("[dialer] wallet settle_call failed:", error.message, error.details || "");
      }
      return;
    }

    if (amountMills <= 0) return; // no hold and nothing to charge (unanswered, pre-gate row)

    const { error } = await sb.rpc("wallet_debit", {
      p_agent:       agentId,
      p_category:    "call",
      p_units:       minutes,
      p_amount_mills: amountMills,
      p_ref_type:    "call",
      p_ref_id:      callRowId,
      p_desc:        desc,
    });
    if (error) {
      console.warn("[dialer] wallet debit failed:", error.message, error.details || "");
    }
  } catch (e) {
    console.error("[dialer] wallet debit error:", e);
  }
}

export async function closeCallRowById(
  sb: ReturnType<typeof createClient>,
  callRowId: string | null | undefined,
): Promise<{ id: string; agentId: string; durationSec: number; walletHoldId: string | null } | null> {
  if (!callRowId) return null;
  const { data: row } = await sb.from("calls")
    .select("id, status, answered_at, agent_id, wallet_hold_id")
    .eq("id", callRowId)
    .maybeSingle();
  if (!row || row.status === "completed") return null;

  const now = new Date();
  const durationSec = row.answered_at
    ? Math.max(0, Math.floor((now.getTime() - new Date(row.answered_at).getTime()) / 1000))
    : 0;
  await sb.from("calls").update({
    status:       "completed",
    ended_at:     now.toISOString(),
    duration_sec: durationSec,
  }).eq("id", row.id);

  return {
    id:           row.id as string,
    agentId:      row.agent_id as string,
    durationSec,
    walletHoldId: (row.wallet_hold_id as string | null) ?? null,
  };
}

export async function speakAndHangup(
  telnyxHeaders: Record<string, string>,
  callControlId: string,
  message: string,
) {
  try {
    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`, {
      method: "POST",
      headers: telnyxHeaders,
      body: JSON.stringify({
        payload:    message,
        voice:      "female",
        language:   "en-US",
        command_id: crypto.randomUUID(),
      }),
    });
  } catch { /* best effort */ }

  await new Promise((resolve) => setTimeout(resolve, 4000));

  try {
    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`, {
      method: "POST",
      headers: telnyxHeaders,
      body: JSON.stringify({ command_id: crypto.randomUUID() }),
    });
  } catch { /* best effort */ }
}

// Dial the next lead in session.lead_ids, joining it to the existing
// conference once answered. Applies caller ID selection (fixed or smart local)
// based on session.caller_id_mode. Skips leads with no phone on file.
// Marks the session 'completed' (and says goodbye to the agent) once exhausted.
export async function dialNextLead(
  sb: ReturnType<typeof createClient>,
  telnyxHeaders: Record<string, string>,
  TELNYX_CONN_ID: string,
  webhookUrl: string,
  session: DialerSession,
) {
  // Resolve the agent's fallback caller ID (primary number on agent row).
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id")
    .eq("id", session.agent_id)
    .maybeSingle();
  const fallbackCallerId: string = agent?.signalwire_caller_id || "";

  let nextIndex = session.current_index;

  while (true) {
    nextIndex += 1;

    if (nextIndex >= session.lead_ids.length) {
      await sb.from("dialer_sessions").update({
        status:        "completed",
        current_index: nextIndex,
        ended_at:      new Date().toISOString(),
      }).eq("id", session.id);

      if (session.agent_call_control_id) {
        await speakAndHangup(
          telnyxHeaders,
          session.agent_call_control_id,
          "You've reached the end of your dialing list. Goodbye.",
        );
      }
      return;
    }

    const clientId = session.lead_ids[nextIndex];
    const { data: leadRow } = await sb.from("leads")
      .select("id, data")
      .eq("agent_id", session.agent_id)
      .eq("client_id", clientId)
      .maybeSingle();

    const rawPhone: string = (leadRow?.data as { phone?: string } | undefined)?.phone || "";
    const leadPhone: string = toE164(rawPhone) || rawPhone;
    if (!leadPhone) {
      // No lead ever disappears without a visible trace — surfaced by the
      // frontend as a toast/banner via dialer_sessions.last_skip_reason.
      const reason = leadRow
        ? `Lead ${nextIndex + 1}: no phone on file`
        : `Lead ${nextIndex + 1}: lead not found`;
      console.warn(`[dialer] session ${session.id} skipped index ${nextIndex}: ${reason}`);
      await sb.from("dialer_sessions").update({
        current_index:    nextIndex,
        last_skip_reason: reason,
      }).eq("id", session.id);
      continue;
    }

    // Select the caller ID for this lead based on mode.
    const callerIdE164 = selectCallerId(
      session.caller_id_mode,
      session.caller_id_numbers,
      session.caller_id_fixed,
      fallbackCallerId,
      leadPhone,
      nextIndex,
    );

    if (!callerIdE164) {
      const reason = `Lead ${nextIndex + 1}: no caller ID available`;
      console.warn(`[dialer] session ${session.id} skipped index ${nextIndex}: ${reason}`);
      await sb.from("dialer_sessions").update({
        current_index:    nextIndex,
        last_skip_reason: reason,
      }).eq("id", session.id);
      continue;
    }

    const leadClientState = btoa(JSON.stringify({
      role:          "dialer_lead",
      session_id:    session.id,
      conference_id: session.conference_id,
      lead_index:    nextIndex,
    }));

    // Universal spend gate — checked before EVERY dial, not just session
    // start (telnyx-dialer-create-session gates start; this is the actual
    // per-dial choke point every subsequent lead passes through). Reserves
    // billing_config.min_call_start_mills as a hold that reportMinutesToWallet
    // reconciles via wallet_settle_call once this call ends.
    const { data: billingConfig } = await sb.from("billing_config")
      .select("min_call_start_mills")
      .eq("id", 1)
      .maybeSingle();
    const minStartMills = billingConfig?.min_call_start_mills ?? 30;

    const { data: holdId, error: holdErr } = await sb.rpc("wallet_hold", {
      p_agent:        session.agent_id,
      p_category:     "call",
      p_units:        null,
      p_amount_mills: minStartMills,
      p_ref_type:     "call",
      p_ref_id:       null,
      p_desc:         `Call start hold — $${(minStartMills / 1000).toFixed(2)} reserved`,
    });

    if (holdErr) {
      // Insufficient wallet balance — do not place the call. End the
      // session and tell the agent why, rather than silently stalling.
      await sb.from("dialer_sessions").update({
        status:                  "cancelled",
        ended_at:                new Date().toISOString(),
        current_call_control_id: null,
        current_call_row_id:     null,
      }).eq("id", session.id);
      if (session.agent_call_control_id) {
        await speakAndHangup(
          telnyxHeaders,
          session.agent_call_control_id,
          "Your wallet balance is too low to continue dialing. Please add funds and start a new session. Goodbye.",
        );
      }
      return;
    }

    const callRes = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: telnyxHeaders,
      body: JSON.stringify({
        connection_id:      TELNYX_CONN_ID,
        to:                 leadPhone,
        from:               callerIdE164,
        client_state:       leadClientState,
        webhook_url:        webhookUrl,
        webhook_url_method: "POST",
      }),
    });

    if (!callRes.ok) {
      // Telnyx rejected the number (e.g., invalid/fake number). Release the
      // hold — nothing was actually dialed, so nothing should be reserved.
      await sb.rpc("wallet_void", { p_ledger_id: holdId }).then(
        (r) => { if (r.error) console.warn("[dialer] wallet_void failed:", r.error.message); },
      );
      // Stall at this lead so the agent sees it in the UI and can manually mark + skip.
      // Previously this silently looped to the next lead, causing leads to disappear.
      await sb.from("dialer_sessions").update({
        current_index:           nextIndex,
        status:                  "dialing",
        current_call_control_id: null,
        current_call_row_id:     null,
      }).eq("id", session.id);
      return;
    }

    const callData = await callRes.json();
    const leadCallControlId: string = callData?.data?.call_control_id || "";
    if (!leadCallControlId) {
      // Telnyx accepted the call but returned no control ID — treat same as
      // rejection above, including releasing the hold.
      await sb.rpc("wallet_void", { p_ledger_id: holdId }).then(
        (r) => { if (r.error) console.warn("[dialer] wallet_void failed:", r.error.message); },
      );
      await sb.from("dialer_sessions").update({
        current_index:           nextIndex,
        status:                  "dialing",
        current_call_control_id: null,
        current_call_row_id:     null,
      }).eq("id", session.id);
      return;
    }

    // Play US ringback tone on the agent's bridge so they hear ringing on their phone
    if (session.agent_call_control_id) {
      const ringbackUrl = Deno.env.get("RINGBACK_AUDIO_URL") || "";
      if (ringbackUrl) {
        fetch(
          `https://api.telnyx.com/v2/calls/${session.agent_call_control_id}/actions/playback_start`,
          {
            method: "POST",
            headers: telnyxHeaders,
            body: JSON.stringify({
              audio_url:  ringbackUrl,
              loop:       0,
              command_id: crypto.randomUUID(),
            }),
          },
        ).catch(() => {});
      }
    }

    // Close the previous call row (no-op when current_call_row_id is null,
    // which is the case when called from telnyx-dialer-skip since it already
    // closed the row before calling us).
    const closed = await closeCallRowById(sb, session.current_call_row_id);
    if (closed) {
      await reportMinutesToWallet(sb, closed.agentId, closed.durationSec, closed.id, closed.walletHoldId);
    }

    const { data: callRow } = await sb.from("calls").insert({
      agent_id:       session.agent_id,
      lead_id:        leadRow?.id || null,
      direction:      "outbound",
      phone_from:     callerIdE164,
      phone_to:       leadPhone,
      started_at:     new Date().toISOString(),
      status:         "initiated",
      sw_call_sid:    leadCallControlId,
      wallet_hold_id: holdId,
    }).select("id").single();

    await sb.from("dialer_sessions").update({
      current_index:           nextIndex,
      status:                  "dialing",
      current_call_control_id: leadCallControlId,
      current_call_row_id:     callRow?.id || null,
      current_caller_id:       callerIdE164,
      last_skip_reason:        null,
    }).eq("id", session.id);

    return;
  }
}
