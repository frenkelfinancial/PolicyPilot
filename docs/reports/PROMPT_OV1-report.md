# PROMPT OV1 — report

**Round 1 of 2. Backend only.** Schema:
`supabase/migrations/20260810_contract_levels.sql`. Feature doc:
`docs/contract-levels.md`. Tests: `npm run test:contractlevels`
(`test/contract-levels.test.mjs`, 26 tests).

**Applied to the linked project (`cweiaibjigjwspmshcrj`) and every guard proved
live.** No UI was built. `app.html` is unchanged.

---

## 1. 🔴 What `policies.product` actually stores — Round 2 depends on this

**It is NOT COMP-keyed, and it is not even one key space.** Queried against the
linked project before anything was written (26 policies, 3 agents, 0 blanks in
`carrier`, `product` or `cls`).

`select distinct data->>'product'` returns **four** values:

```
aa_senior | core_siwl | trans_express | Whole Life
```

`select distinct data->>'cls'` returns:

```
gi | level | standard | std
```

Verbatim samples, by frequency:

| carrier | product | cls | n |
|---|---|---|---|
| `Americo` | `Whole Life` | `std` | 7 |
| `American-Amicable` | `Whole Life` | `std` | 4 |
| `Transamerica` | `trans_express` | `level` | 2 |
| `Transamerica` | `Whole Life` | `std` | 2 |
| `Corebridge` | `Whole Life` | `gi` | 2 |
| `Americo` | `Whole Life` | `standard` | 2 |
| `American-Amicable` | `Whole Life` | `level` | 2 |
| `Ethos` | `Whole Life` | `std` | 2 |
| `American-Amicable` | `aa_senior` | `level` | 1 |
| `Corebridge` | `core_siwl` | `gi` | 1 |

So the column holds the **display category** (`Whole Life`) for the bulk of the
book and a **legacy raw COMP key** (`trans_express`, `aa_senior`, `core_siwl`)
for the rest — both live, in the same column, today. `cls` likewise mixes the
current keys (`std`, `gi`) with the legacy ones (`level`, `standard`) that
`LEGACY_CLASS_MAP` folds.

**A COMP key cannot be resolved from `product` alone in either space.**
`getActiveCommKey(carrier, product, cls)` needs all three:

- `CARRIER_PRODUCTS[carrier].products[product]` is what turns `Whole Life` into
  `americo_eagle` — the carrier is not optional, and the COMP key space
  literally embeds it;
- the graded/GI overrides (`cfg.graded[product]`, `cfg.gi`) and the ~40 % `cut`
  flag come off the **carrier and the health class**, not the product;
- `baseKey = cfg.products[product] || product` — that `|| product` is the
  passthrough that carries the legacy rows.

### What I returned, and the one place I departed from the brief

The brief said: *if it stores a display label, say so and return the raw value;
Round 2 will map it.* **Returning a bare `data->>'product'` would have been the
raw value and also an unusable one** — `Whole Life` cannot reach the COMP table
from any direction, so Round 2 would have been blocked on a new migration and
this round would have shipped a dead RPC.

So `product` is the three stored values **verbatim, joined into one text key**,
in the shape `app.html` already uses for exactly this lookup:

```js
commPctOverrideKey(carrier, product, cls) === `${carrier}|${product}|${cls}`
```

Nothing is mapped, interpreted or looked up in SQL; no mapping table was
invented; the RETURNS TABLE is still the four declared columns. **Round 2
splits on `|` and calls `getActiveCommKey()` then `getCommPct()`** — both
already ship. Live output:

```
Americo|Whole Life|std                 3 policies   $7,229.16
American-Amicable|Whole Life|std       3 policies   $5,847.84
American-Amicable|aa_senior|level      1 policy     $2,170.92   <- legacy key space
Corebridge|Whole Life|gi               2 policies   $1,457.40   <- GI, a different %
Transamerica|trans_express|level       2 policies   $1,101.84   <- legacy key space
```

Two policies differing only in health class are **two rows on purpose** — they
earn different percentages, so an override priced across them would be wrong.

---

## 2. Trigger ordering on `public.agents`, and why it is correct

`public.agents` already carries **seven `BEFORE UPDATE` triggers** (confirmed
against `pg_trigger` on the live database). Postgres fires BEFORE row triggers
**in alphabetical order by trigger name**:

```
agents_lock_compliance_slug
agents_protect_commission_token
agents_protect_compliance_columns
agents_protect_privileged_columns      <- 20260703c
agents_protect_verification_columns
agents_sync_compliance_page
agents_touch_updated_at
```

`agents_log_contract_level` sorts **ahead of all seven**. That is precisely why
it is an **AFTER** trigger.

- As a BEFORE trigger it would read `NEW` as the client offered it, not as it
  was stored — and every guard in this schema works by silently **reverting**
  `NEW.col := OLD.col`, not by raising. A logger running first would record
  changes a later guard then undid.
- As an AFTER trigger it cannot: every BEFORE trigger has finished, `NEW` is
  the row that landed, and `is distinct from` sees a reverted column as no
  change and writes nothing. Ordering by luck of the alphabet is exactly what
  this avoids.

**Composition with `20260703c` specifically.** I read the file rather than
trusting the prompt, and **the prompt's description of it is wrong**: it is not
a trigger "allowing an agent to self-update only `monthly_goal`,
`contract_level`, `agent_phone`, `signalwire_caller_id`". It is a **DENYLIST**
that reverts seven privileged columns —

```
is_admin, plan_id, monthly_minute_limit, monthly_quote_limit,
stripe_customer_id, stripe_subscription_id, stripe_numbers_item_id
```

— for a non-admin `authenticated`/`anon` caller, and names `contract_level`
**nowhere**. Those four column names appear only in its *header comment*, as an
observation about what the client happens to write. So:

- a self-update the protection trigger allows **is** logged (verified live);
- an update a guard **rejects** — `agents_lock_compliance_slug` raises on a
  locked slug — aborts the statement, so the AFTER trigger never runs and
  nothing is logged.

Correct in both directions. `after update **of contract_level**` narrows it
further: the trigger is not considered unless that column is in the UPDATE's
target list, so an ordinary agent save pays nothing for it.

---

## 3. Which roster RPC I extended, and why

**`get_agency_members()`**, as the brief preferred.

`get_team_summary` is under the one-call-site invariant and its `pol` CTE is
compared character-for-character against `lb_agent_metrics` by
`test/leaderboards.test.mjs`. Widening it means touching the function two
screens' AP already agrees through, for a field with nothing to do with AP.
`get_agency_members` is already the roster read, is under no such invariant,
and both `app.html` call sites (`pcLoad`, `loadAgencyMembers`) read **by name**,
so the three new columns are inert until Round 2 asks for them.

`DROP` + `CREATE` in one transaction — widening `RETURNS TABLE` cannot be done
with `CREATE OR REPLACE` — and the grant is restated because `DROP` takes the
ACL with it. Reproduced verbatim from `20260751` otherwise.

**Two things the brief did not ask for but the function needed:**

- 🔴 **A level is returned for a `downline` row only.** `get_agency_members`
  also returns **uplines and siblings** — it feeds the lead-transfer picker —
  so an ungated column would have shown an agent their *sibling's* contract and
  their *leader's*, which is the opposite of decision 2. Proved live: reading
  as the downline agent, both the upline and sibling rows come back with
  `contract_level: null`.
- **`level_changed_by_self` is NULL when there is no recorded change**, not
  false. A level that predates this migration or has never moved would
  otherwise read as "the leader set it", which is a claim the table cannot
  support.

The changer is a **boolean and never a name or an email**, as specified.

---

## 4. Which opt-out stance I matched, and where I copied it from

**No opt-out filter** — `agents.hide_from_leaderboards` is not applied.

Copied from **`get_downline_commission_rollup`** in
`supabase/migrations/20260742_commissions_dashboard.sql`, which does not apply
it either; `get_team_summary` (`20260751`) does not apply it either. Both were
read before deciding.

`lb_visible_members()` is the enforcement point for **peer-visible rankings** —
who appears on a board against their colleagues. A hidden agent is already in
their leader's team table and commission rollup today. Inventing a stricter
stance for this one function would mean a leader's override estimate silently
omitting an agent whose AP the row directly above it is showing, and money
vanishing from a total with nothing on screen to say so is the worst failure
this schema can produce.

---

## 5. Live guard results

Applied with `supabase db query --linked`. Every write below ran inside
`begin; … rollback;`, impersonating real agents with `set local role
authenticated` + `request.jwt.claims`. **Not one production contract level was
changed** (confirmed after: `contract_level_changes` holds 0 rows, levels still
`80,85,90,100`).

Agents used: leader `f1c78a79…` (Jace Frenkel), accepted downline `89e10ce2…`
(Preston Guyette) and `2be4a4a8…` (Owenclark 2831), and `242ebda1…` — a real
agent with a real book who is **not** this leader's downline.

**Dry run first.** The whole file with `commit` → `rollback` applied cleanly,
and afterwards `to_regclass('public.contract_level_changes')` was `null` with
0 of the 2 new functions present. Then applied for real:

```
cols 6 | rls_on true | policies 1 | policy_cmds SELECT | trg 1 | new_fns 2
```

### ✅ A leader setting a NON-downline agent's level is refused

```
ERROR:  42501: not authorized: that agent is not an accepted member of your downline
CONTEXT:  PL/pgSQL function set_downline_contract_level(uuid,numeric) line 29 at RAISE
```

### ✅ An invented extra argument is refused

```
ERROR:  42883: function public.set_downline_contract_level(uuid, integer, uuid) does not exist
HINT:  No function matches the given name and argument types.
```

### ✅ A successful call writes exactly ONE row with the right `changed_by`

Leader sets `89e10ce2…` to **103**:

```json
{ "audit_rows_written": 1,
  "agent_id": "89e10ce2-27bb-4fb1-aa44-c84bb4f46138",
  "changed_by": "f1c78a79-95f9-47c0-b279-29d6fb96c419",
  "changed_by_is_the_leader": true,
  "logged_against_the_agent": true,
  "old_level": "80", "new_level": "105", "level_now": 105 }
```

103 → **105**: rounded to the nearest 5, exactly as `setContractValue()` does.

### ✅ An agent self-updating their own `contract_level` also writes a row

Agent `89e10ce2…` runs the same `update public.agents` the browser runs, and in
the same transaction tries to write the **leader's** row:

```json
{ "audit_rows_written": 1, "agent_id": "89e10ce2-…",
  "old_level": "80", "new_level": "125",
  "changed_by_self": true,
  "leader_level_untouched": 85 }
```

One row, `changed_by = agent_id`. The write against the leader's row was a
silent no-op — RLS, unchanged.

### ✅ Out-of-range levels are refused, not clamped

```
level 200 → ERROR:  22023: contract level must be between 70 and 145 (got 200)
level  65 → ERROR:  22023: contract level must be between 70 and 145 (got 65)
```

### ✅ `get_downline_product_ap` returns own aggregates only for a caller with no downline

`242ebda1…` (4 policies, no downline):

```json
[ { "agent_id": "242ebda1-…", "product": "Americo|Whole Life|std", "policy_count": 2, "total_ap": "3552", "is_only_me": true },
  { "agent_id": "242ebda1-…", "product": "Ethos|Whole Life|std",   "policy_count": 2, "total_ap": "1920", "is_only_me": true } ]
```

The leader's own call returns 12 rows across **themselves and their two
accepted downline agents only** — `242ebda1…`'s four policies are absent.

### ✅ The AP definition agrees with `get_team_summary` to the cent

The behavioural half of the byte-identical predicate:

```json
[ { "agent_id": "f1c78a79-…", "team_summary_ap": "15440.04", "product_rollup_ap": "15440.04", "ap_agrees": true, "lifetime_sales": 11, "pols": "11", "count_agrees": true },
  { "agent_id": "89e10ce2-…", "team_summary_ap":  "8977.80", "product_rollup_ap":  "8977.80", "ap_agrees": true, "lifetime_sales":  7, "pols":  "7", "count_agrees": true },
  { "agent_id": "2be4a4a8-…", "team_summary_ap":        "0", "product_rollup_ap":      null, "ap_agrees": true, "lifetime_sales":  0, "pols": null, "count_agrees": true } ]
```

### ✅ The roster gate, both directions

Leader's view, after the **leader** moved Preston to 115:

```json
[ { "relationship":"downline","agent_name":"Owenclark 2831","contract_level":"80",  "level_changed_by_self":null,  "has_stamp":false },
  { "relationship":"downline","agent_name":"Preston Guyette","contract_level":"115","level_changed_by_self":false, "has_stamp":true  } ]
```

Leader's view, after the **agent** moved themselves to 130:

```json
[ { "relationship":"downline","agent_name":"Owenclark 2831","contract_level":"80",  "level_changed_by_self":null,  "has_stamp":false },
  { "relationship":"downline","agent_name":"Preston Guyette","contract_level":"130","level_changed_by_self":true,  "has_stamp":true  } ]
```

The **agent's** view of the same roster — upline and sibling carry no level:

```json
[ { "relationship":"upline", "agent_name":"Jace Frenkel",  "contract_level":null,"level_changed_by_self":null },
  { "relationship":"sibling","agent_name":"Owenclark 2831","contract_level":null,"level_changed_by_self":null } ]
```

Names resolve through `pp_display_name` — no email on any surface.

### ✅ The audit table cannot be read by a stranger or written by a browser

```
stranger (242ebda1…) selecting contract_level_changes  →  0 rows
browser-role INSERT  →  ERROR:  42501: permission denied for table contract_level_changes
```

---

## 6. Test and check results

```
npm run test:contractlevels   26 tests, 26 pass, 0 fail
npm test                      exit 0 — whole chain green
npm run check                 ✓ app.html: 0 new error(s), 0 new warning(s), 12 known (baselined)
```

`test/leaderboards.test.mjs` and `test/team-roster.test.mjs` pass **unmodified**
— neither file was touched. `scripts/check-app.baseline.json` was not
regenerated.

`git diff --stat` — **no `app.html` change**, as expected. The only edit to an
existing file is `package.json`: the new `test:contractlevels` script and its
place in the `test` chain, before `npm run check`.

---

## 7. Plain-English summary

**An agency owner can now set a downline agent's contract level**, which they
could not do before — the database only ever let an agent write their own row.
They set it through one function that works out who their downline is from
their own login; there is no way to point it at somebody else's agency.

**Both of them can still set it, and the most recent change wins.** That was
the owner's decision and nothing here changes it. What changed is that **every
change is now written down** — who did it, when, what it was, what it became —
and the owner can read that history for their own agents. On the roster the
owner now sees each downline agent's level plus a plain yes/no: *did they set
that themselves?* They never see a name or an email attached to the change,
because the only question worth answering is whether the agent moved their own
number.

**An agent sees no change at all.** They still set their own level in Settings
exactly as before, they still cannot see anyone else's, and their upline's and
teammates' levels come back blank.

**And there is a new figure the owner cannot see yet**: their downline's
annual premium broken down by carrier, product and health class. That is the
raw material for pricing an override, and Round 2 turns it into a number on a
screen. It reports the same annual premium the Agency tab already reports —
verified equal to the cent — so the two screens cannot disagree.

---

## 8. Numbered eyeball checklist for Jace

This round has **no UI**. Nothing in the app looks different, and that is the
expected result.

1. **Open the app and look at Settings → your contract level.** It should read
   what it always read, and changing it should still stick. (Your own level is
   85; the two agents in your downline are 80 and 80.)
2. **Open the Leads tab and the Settings → Producer Codes panel.** Both load
   the roster this round widened. They should look identical — they read their
   columns by name and ignore the new ones.
3. **Confirm nothing else moved:** the Agency tab, the leaderboards and the
   team table are untouched.
4. **If you want to watch it work**, run this once — it sets your downline
   agent's level to 105 and shows the audit row, then puts everything back
   exactly as it was:

   ```sql
   begin;
   select public.set_downline_contract_level('89e10ce2-27bb-4fb1-aa44-c84bb4f46138', 103);
   select agent_id, changed_by, old_level, new_level, changed_at
     from public.contract_level_changes;
   rollback;   -- <- leave this in and nothing is kept
   ```

   Expect `new_level = 105` (103 rounds to the nearest 5) and exactly one row
   with you as `changed_by`. Change `rollback` to `commit` only if you actually
   want that agent on 105.
5. **The one thing to sanity-check for Round 2**: your book stores product as
   `Whole Life`, not as a comp-guide key like `americo_eagle`, and three older
   policies store the comp key instead. Section 1 above is how Round 2 handles
   both. If that does not match how you think about your book, say so before
   Round 2 prices anything.

---

## 9. PENDING LIVE VERIFICATION

Everything the brief listed as a live guard was run and is reported in §5.
What remains is genuinely out of this round's scope:

1. **Round 2's override arithmetic is unverified because it does not exist.**
   No override figure has been computed or checked against a real commission
   statement. `getCommPct` / `getActiveCommKey` have not been exercised against
   the `carrier|product|cls` keys this round emits — that is Round 2's first
   job, and the legacy keys (`aa_senior|level`, `trans_express|level`,
   `core_siwl|gi`) are the rows to test first.
2. **The zero-clamp is not implemented.** A downline agent on a level *above*
   the leader's must clamp the override to zero, never negative. Nothing here
   prevents it; nothing here does it. `242ebda1…` and six other agents sit at
   100 against the leader's 85 today, so this case is **live in the data now**
   and Round 2 will hit it immediately.
3. **No browser has ever called any of these three functions.** They were
   exercised through the SQL layer with an impersonated JWT, which proves the
   authorization but not the PostgREST surface (`sb.rpc(...)` argument naming,
   the numeric ↔ JSON round-trip of `contract_level`). Round 2's first wiring
   will confirm it.
4. **`level_changed_by_self` has no production history behind it.**
   `contract_level_changes` is empty and stays empty until somebody moves a
   level for real, so every downline row will read `contract_level` with a NULL
   changed-by-self until then. Round 2's UI must render that "no recorded
   change" state, not treat it as false.
5. **No second-level hierarchy was tested.** This agency is one leader and two
   accepted invitees. A leader who is themselves somebody's downline is a shape
   the data cannot exercise today.
6. **`20260809_email_verification.sql` has no entry in `docs/schema-state.md`**
   and I did not verify whether it is applied. Noted, not touched — out of
   scope for this round.
