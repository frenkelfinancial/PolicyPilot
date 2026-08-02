# Contract levels an owner can set — and the data to price an override

Round 1 of 2 (`prompts/PROMPT_OV1_*`). **Backend only.** Schema:
`supabase/migrations/20260810_contract_levels.sql`. Tests:
`npm run test:contractlevels` (`test/contract-levels.test.mjs`).
The screen and the override arithmetic are Round 2.

---

## The owner's decisions (locked)

1. **Both** the agency owner **and** the agent may set that agent's contract
   level. **The most recent change wins, whoever made it.** No approval step,
   no lock, no leader-wins rule — and nothing in this migration adds one.
2. An agent sees **only their own** level. The leader sees **all** levels in
   their agency.
3. An override is the difference between the leader's commission % and the
   agent's, **per product, from the COMP table**. Round 2 does that maths; this
   round supplies the data.
4. The downline rollup returns **AP per agent per product**. No client names,
   no policy numbers, no carrier statement data.

Decision 1 means an agent can move the number that sets their upline's
override. This round does not change that rule — it makes it **visible**:
every change is logged, and the leader can see whether the agent moved it
themselves.

---

## 🔴 `policies.data.product` IS NOT A COMP KEY. Round 2 depends on this.

Checked against production (26 policies, 3 agents) before anything was built.
`data->>'product'` holds **four distinct values, in two different key spaces at
once**:

| stored value | what it is |
|---|---|
| `Whole Life` | the display **category** — the bulk of the book |
| `aa_senior`, `core_siwl`, `trans_express` | legacy rows storing a **raw COMP key** |

`data->>'cls'` is the same story: `std` and `gi` alongside the legacy `level`
and `standard` (which is what `LEGACY_CLASS_MAP` exists to fold).

**A COMP key cannot be resolved from `product` alone in either space.** The
browser's `getActiveCommKey(carrier, product, cls)` needs all three, because:

- `CARRIER_PRODUCTS[carrier].products[product]` is what turns `Whole Life` into
  `americo_eagle` — the carrier is not optional, and the COMP key space
  literally embeds it;
- the graded/GI overrides (`cfg.graded[product]`, `cfg.gi`) and the ~40 % `cut`
  flag come off the **carrier and the health class**, not the product;
- the `|| product` fallback in `baseKey` is what carries the legacy rows
  through unchanged.

So `get_downline_product_ap` **maps nothing and invents no mapping table**. Its
`product` column is the three stored values **verbatim**, joined into one text
key in the shape `app.html` already uses for exactly this lookup:

```
commPctOverrideKey(carrier, product, cls) === `${carrier}|${product}|${cls}`
```

Real output from the linked project:

```
Americo|Whole Life|std                 3 policies   $7,229.16
American-Amicable|Whole Life|std       3 policies   $5,847.84
American-Amicable|aa_senior|level      1 policy     $2,170.92     <- legacy key space
Corebridge|Whole Life|gi               2 policies   $1,457.40     <- GI, a different %
Transamerica|trans_express|level       2 policies   $1,101.84     <- legacy key space
```

**Round 2 splits on `|` and calls `getActiveCommKey()` then `getCommPct()`.**
Two policies differing only in health class are two rows on purpose — they earn
different percentages, so an override priced across them would be wrong.

A bare `data->>'product'` would have been "the raw value" and also an
**unusable** one: `Whole Life` cannot reach the COMP table. This is the raw
values *and* a usable grain, which is the only reason the column exists.

---

## What was built

### `contract_level_changes` — the audit trail

RLS on, **one policy, SELECT**. Written only by the trigger below, under
`SECURITY DEFINER`. An agent reads their own history; a leader reads their
accepted downline's; nobody else sees a row.

Two deliberate type decisions:

- **`changed_by` is NULLABLE.** `auth.uid()` is NULL for every trusted context
  (service role, SQL editor, migration). The brief said `not null` *and* said
  not to let the insert fail; both cannot hold. The alternatives were to
  coalesce to the agent — a lie, in the one table that exists to answer "who
  moved it" — or to drop the row. NULL means **"not an end-user session"**, and
  `level_changed_by_self` correctly reads it as false. `on delete set null`
  folds a deleted author into the same value: the row outlives its author,
  which is the point of an audit table.
- **`new_level` is NOT NULL**, so the trigger declines to fire when a level is
  *cleared*. A constraint violation raised inside an AFTER trigger aborts the
  caller's whole transaction — the same hazard `pp_jsonb_ts()` exists to avoid
  in `leads_preserve_ai_status()`. Neither write path can produce it anyway:
  the browser sends `parseInt(value) || 100`, and the RPC rejects a null.

### 🔴 The logger is an **AFTER** trigger, and that is the ordering answer

`public.agents` already carries seven BEFORE UPDATE triggers, and Postgres
fires BEFORE row triggers **in alphabetical order by name**:

```
agents_lock_compliance_slug
agents_protect_commission_token
agents_protect_compliance_columns
agents_protect_privileged_columns      <- 20260703c
agents_protect_verification_columns
agents_sync_compliance_page
agents_touch_updated_at
```

`agents_log_contract_level` sorts **before all seven**. As a BEFORE trigger it
would read `NEW` as the client offered it, not as it was stored — and this
schema's column guards work by silently **reverting** `NEW.col := OLD.col`,
not by raising. A logger running first would record changes a later guard then
undid. As an AFTER trigger it cannot: every BEFORE trigger has finished, `NEW`
is the row that landed, and `is distinct from` sees a reverted column as no
change and writes nothing. **Ordering by luck of the alphabet is exactly what
this avoids.**

Composition with `20260703c` specifically: that trigger is a **denylist**. It
reverts `is_admin`, `plan_id`, `monthly_minute_limit`, `monthly_quote_limit`
and the three `stripe_*` columns for a non-admin `authenticated`/`anon` caller,
and it names `contract_level` **nowhere**. So a self-update of a contract level
passes through untouched and is logged. (Its header comment lists
`monthly_goal, contract_level, agent_phone, signalwire_caller_id` as an
*observation about what the client writes* — not as an allowlist it enforces.
Do not read it as one.)

An update the guards reject outright — `agents_lock_compliance_slug` raises on
a locked slug — aborts the statement, so the AFTER trigger never runs and
nothing is logged. Correct in both directions.

`after update **of contract_level**` narrows it further: the trigger is not
considered unless that column is in the UPDATE's target list, so an ordinary
agent save pays nothing for it.

### `set_downline_contract_level(p_agent_id uuid, p_level numeric)`

`SECURITY DEFINER`. It exists because a leader **cannot** simply
`update public.agents`: RLS lets an agent write their own row only, and four
column guards sit on top. A policy wide enough to let a leader write a
downline's row would be wide enough to let any agent write any row they name.

- **No parameter names a leader.** `p_agent_id` names the *subject*; the leader
  is `auth.uid()` and nothing else. Authorization is solely an `agency_invites`
  row with `leader_id = auth.uid()`, `invitee_id = p_agent_id`,
  `status = 'accepted'`. Anything else raises `42501`.
- **Bounds are `setContractValue()`'s own** — 70…145, nearest 5 — declared as
  named constants so `test/contract-levels.test.mjs` can extract both sides and
  compare. It **rounds** inside the range exactly as the browser does (103 →
  105) but **raises** outside it: a leader who types 200 should be told, not
  silently handed the ceiling. Postgres `round()` and JS `Math.round()` agree
  for every positive value.
- It logs nothing itself. **One rule, one place** — the trigger covers both
  write paths or neither.

### `get_agency_members()` — three columns added

`contract_level`, `level_changed_by_self boolean`, `level_changed_at`.

Chosen over `get_team_summary` because that function is under the one-call-site
invariant and its `pol` CTE is compared character-for-character against
`lb_agent_metrics`; widening it means touching the function two screens' AP
already agrees through, for a field with nothing to do with AP.
`get_agency_members` is already the roster read, is under no such invariant,
and both `app.html` callers read **by name**, so the new columns are inert
until Round 2 asks for them. (`DROP` + `CREATE` in one transaction: widening
`RETURNS TABLE` cannot be done with `CREATE OR REPLACE`. The grant is
restated because `DROP` takes the ACL.)

- 🔴 **A level is returned for a `downline` row only.** This function also
  returns **uplines and siblings** — it feeds the lead-transfer picker — so an
  ungated column would show an agent their sibling's contract and their
  leader's. The caller's own row is not in the result at all; their own level
  still comes from `sbLoadContract()`.
- 🔴 **The changer is a BOOLEAN, never an identity.** `level_changed_by_self`
  answers the owner's actual question without publishing who else did it.
  **NULL means there is no recorded change** — the level predates this
  migration, or it has never moved. `false` means somebody other than that
  agent set it (the leader, or a service write); that distinction is not worth
  a name on a peer-visible surface.

### `get_downline_product_ap(p_start date, p_end date)`

- 🔴 **The sale predicate, the sale-date chain and the AP guard are
  byte-identical to `get_team_summary`'s `pol` CTE**, and a test compares them
  character for character exactly as `test/leaderboards.test.mjs` does for
  `lb_agent_metrics`. Proven behaviourally too: summed per agent it equals
  `get_team_summary`'s `lifetime_ap` **to the cent** ($15,440.04 and $8,977.80
  on the live book).
- **No parameter naming a leader**; both are date bounds, half-open, NULL =
  unbounded, compared as DATEs exactly as `get_team_summary` compares them.
- **Aggregates only** — the four columns are enforced by what `RETURNS TABLE`
  declares, not by what a UI renders.
- **The opt-out (`hide_from_leaderboards`) is NOT applied**, matching
  `get_downline_commission_rollup` and `get_team_summary`, neither of which
  applies it. `lb_visible_members()` is the enforcement point for
  **peer-visible rankings** — who appears on a board against colleagues — and a
  hidden agent is already in their leader's team table and commission rollup
  today. A stricter stance here would mean a leader's override estimate
  silently omitting an agent whose AP the row above it is showing.

---

## What Round 2 must not undo

- Do not add an INSERT/UPDATE/DELETE policy to `contract_level_changes`. A
  policy wide enough to let a browser record "the agent raised their own level"
  is wide enough to let it record one that never happened.
- Do not render the changer's name or email. The boolean is the answer.
- Do not clamp, lock or gate the agent's own write. Most recent wins.
- **A level above the leader's own clamps the override to ZERO, never
  negative.** Round 2's job; this round does nothing that prevents it.
- Do not add a second definition of a sale. If `get_team_summary`'s predicate
  ever moves, this function moves in the same commit.
