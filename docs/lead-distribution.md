# Lead distribution — "Send Leads" between agency members

Built 2026-07-28. Lets agents who share an agency hand leads to each other.

**Read this before touching anything named `transfer*`, `slt*`, `alp*`, or
`lead_transfers`.**

---

## What it does

A lead **moves**. `leads.agent_id` becomes the recipient's, the sender stops
seeing it, and the recipient picks it up on their next load. Every handoff is
appended to `public.lead_transfers`, and the lead itself carries a
`receivedFrom` stamp that renders as a **Received from** chip on the lead card.

### Two entry points, one transport

| | Where | Flow |
|---|---|---|
| **A** | Leads tab | Select leads → **Send leads to** in the bulk bar → pick a colleague → confirm |
| **B** | Agency tab | Click a connected agent's card → their profile → **Send Leads** → pick leads with the Leads-tab filters → confirm |

Both call `transferLeadsTo()` in `app.html`, which posts to the `transfer-leads`
edge function. Neither writes another agent's row from the browser — it is not
possible, by design (see below).

Agents with no agency see none of this. `loadAgencyMembers()` returns empty,
`hasAgencyMembers()` is false, and the bulk-bar control is never displayed.

---

## Authorization

Two agents may exchange leads when an **accepted** `agency_invites` row connects
them:

| Direction | Allowed |
|---|---|
| leader → their downline | yes |
| downline → their leader | yes |
| downline → downline under the same leader | yes |
| anyone → an agent in a different agency | **no** |
| anyone → a stranger | **no** |
| anyone → themselves | **no** |
| any of the above where the invite is `pending`/`declined` | **no** |

The rule is implemented **twice, deliberately**:

- `agencyPeers()` in `supabase/functions/_shared/lead-transfer.ts` — guards the
  write, unit-tested, and is the only one that matters for security.
- `public.get_agency_members()` (migration `20260737`) — renders the pickers.

They must not drift. If you change one, change the other. The RPC exists because
a downline agent cannot enumerate their own siblings from the browser:
`agency_invites` RLS is `leader_id = auth.uid() OR invitee_email = auth.email()`,
which does not include "other invitees of my leader".

The sender is **always** taken from the JWT. The request body names only the
recipient and the lead ids.

---

## Why an edge function and not RLS

A transfer writes a row the caller does not own. The only PostgREST policy that
could permit it is one letting an agent write another agent's leads — which is
the exact thing this codebase refuses to add, because a policy broad enough to
allow this write is broad enough to allow every write we are defending against.

So: `transfer-leads` runs under the service role, re-derives the agency link
server-side, and re-asserts ownership in the `WHERE` clause of the update
itself (`.eq("id", …).eq("agent_id", senderId)`).

`lead_transfers` follows the same shape — `SELECT` for the two parties, and no
`INSERT`/`UPDATE`/`DELETE` policy at all, which is how "service-role only" is
expressed in Postgres.

`verify_jwt` is **true** (the platform default), so it is deliberately absent
from `supabase/config.toml` — that file is only for functions whose caller
cannot present a Supabase JWT. Verified after deploy: a malformed bearer token
is rejected by the platform with `UNAUTHORIZED_INVALID_JWT_FORMAT` before our
code runs, and a missing header returns our own `401 unauthorized`.

---

## Compliance rules — non-negotiable

| Thing | What happens on transfer | Why |
|---|---|---|
| `consent_records` | **Never** copied, moved, or re-attributed | SMS consent names a specific sending agency. A downline agent is a different entity from their leader. |
| `dnc_list` | **Never** copied, **never** cleared | Global rows already block everyone; per-agent rows stay where they are. |
| `leads.tcpa_consent` / `_source` / `_at` | **Reset** (`false` / `null` / `null`) | Same reasoning as `consent_records` — this is consent to *contact*, given to someone else. The recipient re-earns it. |
| `leads.dnc` / `dnc_at` | **Preserved**, untouched | A suppression signal must survive a handoff. Clearing it would make lead transfer a DNC-laundering mechanism. |
| Consent-shaped keys inside `leads.data` | Stripped (`tcpaConsent`, `consent`, `consentType`, `trustedFormUrl`, `optIn`, …) | Belt-and-braces for payloads written by importers we do not control. |
| The consumer | **Nothing is sent.** No SMS, no email. | A transfer is silent to the lead. |

**The recipient sees `needs_optin`, and this needed no new code.**
`smsLoadLeadConsent()` queries `consent_records` with
`.eq('agent_id', currentAgent.id)`, so the recipient's consent map simply has no
entry for that phone and `leadTextingState()` falls through to `needs_optin`.
Verified at the data layer, not assumed — see the verification below.

---

## Duplicates, caps, and identity collisions

- **Duplicate phone** — if the recipient already has a lead whose
  `data.phone` normalizes to the same E.164, the lead is **skipped**, not
  duplicated, and reported: *"8 sent, 2 skipped — already in their book"*.
  Two leads with the same phone inside one batch also collapse to one.
- **No phone** — moves. There is nothing to dedupe on, and matching on name
  would merge distinct people.
- **Cap: 250 per transfer** (`TRANSFER_MAX_PER_REQUEST`, mirrored in
  `app.html`). Not a performance limit — a blast-radius limit. The remainder is
  *refused and reported*, never silently truncated. The picker paginates at 50.
- **`client_id` collision** — `leads` carries `UNIQUE (agent_id, client_id)` and
  `client_id` is the browser's local `lead.id`. If the recipient already uses
  that id, the transfer assigns a fresh one and rewrites `data.id` to match,
  preserving the `client_id === String(data.id)` invariant that `sbUpsertLead()`
  depends on. Both ids are recorded in the audit row.

### Idempotency

A retry finds the leads no longer owned by the sender and reports them as
`already_transferred` rather than erroring. Nothing is written twice. Confirmed
against the live schema: re-running the same update touches 0 rows.

---

## The one sharp edge

`saveLeads()` upserts the **entire** local `leads` array under the current
agent. A transferred lead left in that array would be **re-created in the
sender's book** on the next save — resurrecting it while the recipient also has
it.

`transferLeadsTo()` therefore removes the moved leads from `leads` and calls
`saveLeads()` immediately on success, before anything else can run. If you
refactor that function, keep that ordering.

The recipient sees the leads on their next load (`sbPullLeads()`), not in real
time. There is no push.

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260737_lead_transfers.sql` | `lead_transfers` table + RLS + `get_agency_members()` |
| `supabase/functions/_shared/lead-transfer.ts` | Pure core: peers, planner, sanitizer, summary |
| `supabase/functions/_shared/lead-transfer.test.ts` | 27 tests — `npm run test:leadtransfer` |
| `supabase/functions/transfer-leads/index.ts` | The service-role endpoint |
| `app.html` | Both entry points, modals, the **Received from** chip |

---

## Testing it by hand

You need two accounts connected through an agency. Production currently has
**zero** `agency_invites` rows, so step 1 is real setup, not a formality.

1. **Connect two accounts.** As a Team Leader account, Agency tab → invite the
   second account by email. Accept it from the second account (Agency tab →
   Accept). Or: set an agency code on the leader and sign the second account up
   with it.
2. **Confirm membership resolves.** In the browser console of either account:
   `await sb.rpc('get_agency_members')` → one row, with `relationship`
   `upline` or `downline`.
3. **Entry point A.** Leads tab → tick two or three leads → **Send leads to**
   appears in the bulk bar → pick the colleague → confirm. Expect a toast like
   `2 sent to <name>`, and the leads to vanish from the sender's list
   immediately.
4. **Entry point B.** Agency tab → click the connected agent's card → **Send
   Leads** → filter, tick, **Send N Leads**.
5. **On the recipient's account,** reload. The leads are in their book, each
   with a **Received from** chip. The **Text** button reads *"No text consent
   on file yet"* — grey, not green — even if the sender had consent.
6. **Duplicate check.** Send the same person again from the sender (re-import
   or re-add them first). Expect `0 sent, 1 skipped — already in their book`.
7. **Audit trail.** As either party:
   `await sb.from('lead_transfers').select('*')` → the row is visible to both
   sender and recipient, and to nobody else.
8. **Negative check.** From an account in a *different* agency, call the
   function directly with a stranger's `recipient_id`. Expect
   `403 not_in_your_agency`.

---

## Verification performed at build time

Run inside a transaction terminated by `RAISE EXCEPTION`, against production
schema and a real lead, so nothing persisted (re-confirmed: 0 invites,
0 transfers, 0 fixture consent rows, lead ownership unchanged, 1,329 leads
before and after):

| Check | Result |
|---|---|
| lead moves to the recipient | pass |
| sender can no longer see it | pass |
| `consent_records` row still belongs to the **sender** | pass — not re-attributed |
| recipient has **no** consent row for that phone | pass — renders `needs_optin` |
| `tcpa_consent` columns reset on the moved lead | pass |
| `dnc_list` rows for that phone | unchanged — transfer wrote none |
| audit row written | pass |
| provenance stamped on the lead | pass |
| retry touches 0 rows | pass — idempotent |

Plus 27 unit tests over the authorization matrix, duplicate handling, the cap,
`client_id` reassignment, and the consent/DNC rules.

---

## End-to-end run against production — 2026-07-29

Two throwaway accounts (a Leader-plan "QA Leader" and a Basic "QA Downline")
were created, connected through the **real** invite → accept flow, and driven
headless against `https://producerstackcrm.com/app.html`. Test leads used the
reserved fictional `+1 555 555 01xx` range — no real consumer was involved.
**30 of 30 assertions passed** on the final run. Both accounts and every row
they touched were deleted afterwards; `leads` returned to exactly its pre-test
count of 1,329, with 0 invites, 0 transfers, and 0 rows carrying provenance.

It found two real bugs, both now fixed.

### Bug 1 — a downline could not reach the Agency tab at all

`nav()` carried its own leader gate on `'agency'`, separate from
`_applyPlanGating`:

```js
if (id === 'agency' && _navTier !== 'leader') { showUpgradeGate(...); return; }
```

So a non-leader clicking **Agency** got an upgrade modal and never reached
`_agRenderAgentView` — the only surface where an invitee can accept an invite
or revoke a leader's access. **Every emailed invite was unacceptable**, which
means the invite path could never connect anybody. The invite row was being
written correctly; the invitee simply could not see it.

`renderAgencySection()` already branches on tier, so leader-only content was
never exposed by the gate. It is gone. If you re-add a tier check to `nav()`
for `'agency'`, you break invite acceptance again.

### Bug 2 — the "Received from" chip rendered nowhere

The chip was added to the `metaChips` array, which is composed into `metaHTML`
and then **never interpolated into any template**. Dead code. The provenance
was stamped on every transferred lead and shown to no one.

There are two live card templates and it has to be in both:

- **compact view** — an entry in `_pf` (primary, not behind ▼ More)
- **standard view** (the default) — an explicit `allFields` entry, which cannot
  rely on the generic `Object.entries(lead)` sweep because `_skipInPanel` hides
  the raw `receivedFrom` / `receivedFromId` / `receivedAt` keys

The lesson generalises: **assert on the rendered DOM, not on the payload.**
The payload assertion passed the whole time.

### What the run confirmed

| | |
|---|---|
| invite → accept through the real UI | works; both sides then resolve each other via `get_agency_members()` (`upline` / `downline`) |
| leader → downline (entry point A) | `1 sent, 1 skipped — already in their book` |
| downline → leader (entry point A) | `1 sent` |
| entry point B | agent card opens the profile; picker renders with all four filters; "Select all (filtered)" produces `Send 5 Leads`; Clear disables the button |
| duplicate skip | the duplicate stayed with the sender, was not copied |
| the `saveLeads()` hazard | moved lead did **not** reappear after a status change forced a full upsert, nor after a reload |
| consent reset | recipient's Text button read *"No text consent on file yet"* (`lead-text-btn--needs_optin`) while the **sender kept** their `consent_records` row |
| audit trail | both parties see the same two rows; nobody else can |
| negative — stranger | `403 not_in_your_agency` |
| negative — someone else's lead ids | `0 sent, refused: 2` (`not_yours`) |
