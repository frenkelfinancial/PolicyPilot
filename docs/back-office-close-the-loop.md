# Back Office — closing the loop

Built 2026-07-29 (Phase 7, the last of the Back Office mission). Three things
that turn back-office data back into front-office work: auto-referral
generation, a chargeback signal on the at-risk flag, and a read-only Carriers
list.

**Read this before touching anything named `referral*`, `cr*`,
`teamChargeback*`, or `get_carrier_summary`.** Progress ledger:
`docs/back-office-progress.md`.

---

## 1. Auto-referral generation

A beneficiary or emergency contact captured at sale becomes a new lead.

### The one rule this feature turns on

> **A referral lead is created WITHOUT consent, and must be.**

It carries no `tcpa_consent`, no consent record and no opt-in of any kind, so
`leadTextingState()` renders it `needs_optin` and `runComplianceGate()` refuses
a send. **A beneficiary named on an application has not asked to hear from
anyone.** Creating the lead is free pipeline; contacting them without an opt-in
is what gets a 10DLC campaign shut down — and this repo already has three
carrier review items on record from exactly that class of mistake.

`referralsFromPolicy()` therefore returns lead objects that **do not carry a
consent field at all**, and two tests assert it: a unit test enumerating every
consent-shaped key, and a click-through that reads the keys off the real lead
in the real browser *and* off the row that synced to the server.

The lead's own note says so in words the agent will read:

> *Beneficiary on Jane Insured (Daughter). Has not opted in — ask before you
> text.*

### What is captured, and where

Six optional fields on the **Add Policy** and **Submit as Sold** forms —
beneficiary and emergency contact, each with a name, a phone and a
relationship. They are stored **on the policy** (jsonb, so no schema change),
because the policy is where an agent looks a year later for *who did they name
as beneficiary*.

Nothing was capturing this before. The brief says "captured at sale", and the
honest reading of that is that the capture had to be built too.

### The three dedupes, each a real case

1. **Against the existing book, by phone.** The beneficiary is often already a
   lead.
2. **Against the insured themselves.** A policy naming the client as their own
   emergency contact would otherwise create a lead for someone you just sold.
3. **Within the batch.** Beneficiary and emergency contact are frequently the
   same person; creating them twice is the first thing an agent notices and the
   last thing they forgive.

A contact needs **both** a name and a phone. A lead an agent cannot call is not
a lead, it is a row.

---

## 2. The chargeback at-risk signal

`teamAtRisk()` gained a second way to satisfy its second half:

```js
atRisk = eligible && productionDown && (quiet || cbSpike)
```

- **Production down is still required.** Production alone is a slow month —
  that guard has not moved. What changed is that an agent whose production
  halved *and* whose book is coming back is now flagged **even while they are
  still dialling**. Arguably that agent is in more trouble than a quiet one:
  they are writing business that does not stick, which silence would never have
  told you.
- **A spike, not a chargeback.** One clawback is ordinary. `AT_RISK_CB_MIN_CENTS
  = $500` **and** `AT_RISK_CB_RATIO = 30%` must both be met, so a tiny book with
  one $40 chargeback against $100 of commission does not read as a crisis.
- **No commission data is not a spike.** An agent whose statements have never
  been ingested must not be flagged for not having uploaded any. That is what
  makes this safe to add to a rule that was already shipping — a test asserts
  the pre-Phase-7 behaviour is unchanged when the figures are absent.
- **Both original guards survive**: prior AP ≥ 1, tenure ≥ 30 days, and the
  leader's own row is never badged.
- **The window is always this calendar month**, the same fixed window the AP
  half uses, so the badge cannot blink as a leader clicks between period chips.
- **The reason names the half that actually fired.** Sending a leader into a
  *"you haven't been dialling"* conversation with an agent who dialled this
  morning is worse than no badge at all:

  > *AP down 90% vs last month, chargebacks are 60% of commission this month*

The figures come from `get_downline_commission_rollup` (Phase 4) rather than by
widening `get_team_summary` again, and the call is **best effort**: if it fails,
the map is empty and the rule falls back to exactly what it did before.

**Still in-app only. Nothing is emailed.** That was true of the at-risk flag
before and it is still true.

---

## 3. The Carriers screen

Read-only. One row per carrier that has actually **paid** the agent: lines,
matched policies, premium, net paid, and debt.

- **Derived, not a table.** A carrier is here because a statement says it paid.
  A `carriers` table would be a second list to maintain and the first thing an
  agent forgets to update after taking an appointment.
- **`data/carrier_bonuses.json` (45 carriers) and `TRACKER_CARRIER_LIST` (24)
  are deliberately not joined in.** They answer different questions — what
  programmes exist, and what the Add Policy dropdown offers — and folding them
  together would show an agent carriers they have never written a line with.
- **Rejected lines are excluded; unmatched ones are counted and named.** An
  unmatched line is still money that moved.
- **Debt uses the same definition as the Debt tab** — chargeback + adjustment
  only, positive balance only. Two screens disagreeing about what an agent owes
  a carrier would be worse than either being absent.

`get_carrier_summary()` is SECURITY INVOKER: there is no cross-agent carrier
view, and the aggregate paths that do exist return money and rates rather than
anything naming a carrier.

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260745_carriers.sql` | `get_carrier_summary()`; no table, no column, no data |
| `app.html` — `// <referral-core>` block | Pure: candidates, normalisation, dedupe, the lead objects |
| `app.html` — `// <team-core>` additions | `teamChargebackSpike` / `teamChargebackPhrase`, wired into `teamAtRisk` |
| `app.html` — `#bopanel-carriers`, `cr*` | The Carriers screen |
| `app.html` — `referralReadFields` / `referralGenerate` | The capture and the write |
| `test/referrals.test.mjs` | 33 tests — `npm run test:referrals` |

The chargeback helpers live in **team-core, not referral-core**, because the
at-risk rule is theirs and because `test/team-roster.test.mjs` extracts
team-core and runs it standalone — a `teamAtRisk` calling into another block
would stop parsing there.

---

## Verification performed at build time

| Layer | Result |
|---|---|
| Unit tests | **33** (`npm run test:referrals`) |
| Full suite | **661 tests + `npm run check` clean** |
| Headless click-through | **26/26**, including the consent assertion read off both the browser and the synced server row |
| Residue | **zero** |

---

## Testing it by hand

1. **Add Policy** (or **Submit as Sold**). Scroll to *Referrals (optional)*.
   Enter a beneficiary name and phone, and an emergency contact.
2. **Save.** A toast says *"2 referrals added"*. Open **Leads** — both are
   there, source **referral — auto**, with a note saying they have not opted in.
3. **Try to text one.** The Text button is not green: they need an opt-in like
   every other lead. That is the feature working.
4. **Add another policy with the same beneficiary.** No duplicate is created.
5. **Back Office → Carriers.** Every carrier that has paid you, with premium,
   net paid and debt, and a total row.
6. **Agency → at-risk.** An agent whose production halved and whose chargebacks
   are over 30% of their commission this month is now flagged even if they are
   dialling daily, and the badge says *chargebacks*, not *no dials*.
