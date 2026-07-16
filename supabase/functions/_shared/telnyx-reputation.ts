// Shared helpers for Telnyx Number Reputation registration.
//
// Associating a number with our approved Telnyx Enterprise makes Telnyx
// register it across the carrier call-analytics reputation feed — the
// automated equivalent of filing it on FreeCallerRegistry.com.
//
// Registration is BEST-EFFORT at purchase time: a reputation failure must
// never block or roll back a number purchase. Anything missed here (setup
// not finished, Telnyx hiccup, gates not yet approved) is picked up by the
// telnyx-reputation-monitor cron backfill.

// deno-lint-ignore-file no-explicit-any

export interface ReputationConfig {
  enterprise_id: string;
  status: string | null;
  loa_status: string | null;
}

/** Returns the config row only when BOTH Telnyx approval gates are cleared
 *  (reputation status + LOA status), i.e. when number association will be
 *  accepted. Returns null otherwise. */
export async function getApprovedReputationConfig(sb: any): Promise<ReputationConfig | null> {
  const { data } = await sb.from("reputation_config")
    .select("enterprise_id, status, loa_status")
    .eq("id", 1)
    .maybeSingle();
  if (!data?.enterprise_id) return null;
  if (data.status !== "approved" || data.loa_status !== "approved") return null;
  return data as ReputationConfig;
}

/** POST /v2/enterprises/{id}/reputation/numbers — up to 100 numbers, atomic. */
export async function associateNumbers(
  apiKey: string,
  enterpriseId: string,
  e164s: string[],
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `https://api.telnyx.com/v2/enterprises/${enterpriseId}/reputation/numbers`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone_numbers: e164s }),
    },
  );
  if (!res.ok) return { ok: false, error: await res.text() };
  return { ok: true };
}

/** Best-effort registration of a just-purchased number. Telnyx only accepts
 *  US *local* numbers for reputation monitoring, so toll-free is skipped. */
export async function registerNumberBestEffort(
  sb: any,
  apiKey: string,
  e164: string,
  numberType: string = "local",
): Promise<void> {
  try {
    if (numberType !== "local") return;
    const cfg = await getApprovedReputationConfig(sb);
    if (!cfg) {
      console.log(`[reputation] setup not approved yet — ${e164} will be backfilled by cron`);
      return;
    }
    const r = await associateNumbers(apiKey, cfg.enterprise_id, [e164]);
    if (r.ok) {
      await sb.from("phone_numbers")
        .update({ reputation_registered_at: new Date().toISOString() })
        .eq("e164", e164);
      console.log(`[reputation] registered ${e164} for reputation monitoring`);
    } else {
      console.warn(`[reputation] associate failed for ${e164}: ${r.error}`);
    }
  } catch (e) {
    console.warn(`[reputation] error registering ${e164}:`, e);
  }
}
