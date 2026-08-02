# The estimated override — how it is priced, and the two ways it is not

**PROMPT OV2, Round 2 of 2.** Round 1 (`docs/contract-levels.md`,
`supabase/migrations/20260810_contract_levels.sql`) built the schema: a settable
downline contract level, an audit trail on every change, and
`get_downline_product_ap()`. This round is the arithmetic and the two screens
that carry it. **It ships no migration.**

- One definition: the `// <override-core>` block in `app.html`.
- Tests: `npm run test:override` (`test/override.test.mjs`).
- Screens: the **Contract levels** card on the Agency tab, and the **Estimated
  override** box on the Back Office Summary.

---

## 🔴 The two errors this feature exists to not make

The original description was: *"if their est advance commission is $500, my est
adv override would be 5% of $500."* Both halves of that are wrong, and the
wrongness is not a rounding difference — it is a different question answered
with a different input.

### 1. An override is a percentage of AP, not of the agent's commission

Commission and override are both slices of the **same annual premium**. They are
not stacked: an upline is not paid a cut of the downline's cheque, they are paid
their own percentage of the premium, less what the downline was paid of it.

Taking 5% of a $500 advance gives **$25**. The real answer on that business is
**$33.33**, and the gap is not small — it is 33% of the figure.

### 2. The spread between two contract levels is not the difference between them

"85 minus 80 is 5, so a 5% override" is true on some products and false on
others, in the same comp guide, for the same two agents. From **80 → 85**:

| COMP key | at 80 | at 85 | spread |
|---|---|---|---|
| `americo_eagle` | 75 | 80 | **+5** |
| `trans_express` | 80 | 85 | **+5** |
| `core_siwl` | 72 | 77 | **+5** |
| `aa_senior` | 65 | 70 | **+5** |
| `mutual_fe` | 70 | 74 | **+4** |
| `americo_wl` | 70 | 70 | **0** |
| `aetna_senior` | 70 | 70 | **0** |
| `core_graded` | 45 | 45 | **0** |
| `core_giwl` | 55 | 55 | **0** |

Four products pay nothing at all for those five points. Only the table knows,
so **the table is asked — twice, once per level** — and that is the whole of
`ovSpreadPct()`.

---

## The math

```js
spreadPct   = getCommPct(compKey, leaderLevel, cut) - getCommPct(compKey, agentLevel, cut)   // clamped at 0
estOverride = ap * (spreadPct / 100) * ADVANCE_RATE
```

`ADVANCE_RATE` is `0.75` — the 9-month advance — and it is declared **once**, in
`// <override-core>`. It was a bare literal in ten separate expressions
(`_lgAdvComm()` among them) before this round; all ten now name the constant. An
override is advanced on exactly the same terms as the commission it is a spread
of, so a second literal here would be an eleventh copy of a number that has to
move together or not at all.

### The worked example, end to end

The description's own numbers, followed through:

| | |
|---|---|
| Carrier / product / class | Americo, Whole Life, standard → COMP key `americo_eagle` |
| Agent contract level | **80** → `getCommPct('americo_eagle', 80) = 75` |
| Leader contract level | **85** → `getCommPct('americo_eagle', 85) = 80` |
| The agent's $500 advance implies AP of | `500 ÷ 0.75 ÷ 0.75` = **$888.89** |
| Spread | `80 − 75` = **5 points** |
| **Est. advance override** | `888.89 × 5% × 0.75` = **$33.33** |
| The answer "5% of $500" gives | ~~$25~~ — **wrong**, and 33% low |

A test pins this, and its failure message states the $25 and why it is wrong.

### `cut` is not optional

`getCommPct()`'s third argument applies the ~40% reduction carriers take on
graded and Guaranteed Issue business (`pct × 0.6`). It scales **both** sides, so
the spread scales with it:

| | at 80 | at 85 | spread |
|---|---|---|---|
| `americo_eagle`, standard | 75 | 80 | 5 |
| `americo_eagle`, graded (cut) | 45 | 48 | **3** |

Ignoring it overstates the override on every graded and GI policy in the book.
The flag is never chosen by the caller — `getActiveCommKey()` returns it beside
the key, so there is nothing to forget.

### Clamped at zero, never negative

An agent contracted **above** their leader is a data state, not a debt. Both
parties may set the level and the most recent change wins (Round 1's decision),
so this is reachable by ordinary use. The spread clamps to `0`, the agent's row
says so in words, and no negative figure is ever rendered.

**This is live in the data today.** Round 1 measured seven agents sitting at
`100` against the owner's `85`.

---

## Product mapping — the joined key

🔴 **`policies.data.product` is not a COMP key, and it is not even one key
space.** Round 1 checked this against production (26 policies, 3 agents) before
anything was written. The column holds:

- `Whole Life` — the display *category*, for the bulk of the book;
- `aa_senior`, `core_siwl`, `trans_express` — legacy rows storing a raw COMP key.

Both are live, in the same column, today. `cls` likewise mixes the current keys
(`std`, `gi`) with the legacy ones (`level`, `standard`).

So `get_downline_product_ap()` **maps nothing**. It returns the three stored
values verbatim, joined into one text key in the shape `app.html` already uses
for exactly this lookup:

```
commPctOverrideKey(carrier, product, cls) === `${carrier}|${product}|${cls}`
```

and the browser resolves it:

```
"Americo|Whole Life|std"
   → ovSplitProductKey()   → { carrier:'Americo', product:'Whole Life', cls:'std' }
   → getActiveCommKey()    → { key:'americo_eagle', cut:false }
   → getCommPct()          → 75 at level 80, 80 at level 85
```

`CARRIER_PRODUCTS[carrier].products[product]` is what turns `Whole Life` into
`americo_eagle` — `product` alone cannot do it in either direction — and
`getActiveCommKey`'s `baseKey = cfg.products[product] || product` passthrough is
what carries the legacy rows. `LEGACY_CLASS_MAP` folds `level`/`standard` to
`std`. **There is no second resolver and no mapping table**; a test asserts the
core never touches `CARRIER_PRODUCTS` or `LEGACY_CLASS_MAP` itself.

Two policies differing only in health class are two rows on purpose. They earn
different percentages, so an override priced across them would be wrong.

### 🔴 An unmapped product is counted and named, never swallowed

`getCommPct()` returns **the contract level itself** when it has no table for the
product:

```js
getCommPct('not_a_real_product', 85) === 85
```

Subtracting two of those hands back `leaderLevel − agentLevel` — the exact wrong
answer this feature exists to refuse, wearing the right answer's clothes. So
`ovSpreadPct()` asks `COMP` whether the key **exists** before it asks what it
pays. (Asking whether a key exists is not computing a percentage from a level;
`getCommPct()` remains the only thing that does that, and a test pins it.)

An unresolved key is then **reported**, because a silent miss reads as *"this
business pays no override"* — which is indistinguishable from a genuine
zero-spread product and is the worst failure this feature can have. The screen
carries two separate sentences, and they are **two different facts that must
never be merged into one number**:

> N policies are on products with no comp-table entry and are not included.

> N policies are on products where your level and theirs pay the same, so they
> earn no override.

A third state — the agent's level was never recorded, or they sit above the
leader — is reported per agent and counted as neither. "This product pays the
same" is a claim about the comp table, and nobody checked it for an agent whose
level nothing has ever set.

---

## 🔴 The launch state: "not set" is not a number

`get_agency_members()` returns `level_changed_by_self` and `level_changed_at` as
**NULL** when `contract_level_changes` holds no row for that agent — the level
predates the audit trail, or has never moved. Reading NULL as `false` would
print *"changed by you"* about a change nobody made.

**This is not an edge case, it is day one.** Nothing has ever gone through the
audited write path, so every downline row reads NULL today — and the seven
agents at `100` against the owner's `85` are almost certainly an unset default
rather than seven real contracts above him. Every override on that roster
computes negative, clamps to zero, and the whole feature reads **$0**. A screen
that silently shows nothing is indistinguishable from a broken one.

So while **any** downline level is unrecorded, both surfaces lead with:

> **Set your agents' contract levels to see estimated override**
> *N agents have no recorded contract level yet, so no override is estimated on
> their business.*

When they are **all** unrecorded the Back Office Summary box renders the prompt
and **no grid at all** — not a column of `$0`. It disappears on its own the
moment the levels are set. A test pins this and says in its failure message that
this is what the owner meets first, so the assertion is never softened.

---

## Expected vs actual

The box renders two figures side by side:

| Figure | Where it comes from |
|---|---|
| **Est. advance override** | This document. `get_downline_product_ap` × the comp table × contract levels. |
| **Actual override** | The existing **Override Income** from `get_commission_buckets` — off carrier statements, definition unchanged (`docs/back-office-commissions.md`). A **dash, never a zero**, when no statement has been uploaded. |

**They will not agree, and the card says so rather than reconciling them.**
Statements lag production by weeks; a carrier pays what it pays; the estimate
assumes every policy issues and stays on the books and prices at *today's*
contract levels. This is the same arrangement `BOS_ISSUED_STATUSES` has with the
sale predicate one strip above — two questions, two answers, both correct, and
the screen states the difference out loud instead of editing one to match the
other.

---

## Where it lives

### The Agency tab — Contract levels

A card below the team table, **leader view only**. Per downline agent: an
editable level, the audit sentence (*"not set"* / *"changed by the agent on
…"* / *"changed by you on …"*), and an inline warning when they are contracted
above the leader.

- The write is `set_downline_contract_level(p_agent_id, p_level)` — SECURITY
  DEFINER, **no parameter naming a leader**, authorization is
  `agency_invites.leader_id = auth.uid()`. A leader cannot `update
  public.agents` at all; RLS lets an agent write their own row only.
- Validation is `setContractValue()`'s own bounds (70–145, nearest 5) on both
  sides, so the input box and the database agree. The RPC **raises** outside the
  range rather than clamping, and returns what it stored, so the box is
  corrected to it.
- It is a **separate card, not a column on `teamTableHTML()`** — that is the one
  table renderer and it is shared with the Summary mini-card. An editable field
  belongs on the tab an owner manages the agency from.
- **An agent sees nothing new.** They set their own level in Settings exactly as
  before; `get_agency_members` returns no level on an upline or sibling row.

### The Back Office Summary — Estimated override

A strip below the money strip, inside the screen's existing period control.

- It rides `bosPeriod` — the same window as every other card there — and writes
  **neither `pp_team_period` nor `pp_summary_period`**. It stores nothing at all.
- **Leader-only, and absent when there is no downline** — not an empty card, not
  an upsell. The Top Producers card's rule.
- The leader's own rows come back from the RPC (it returns their own aggregates
  too) and are **excluded**: nobody earns an override on their own business.
- Per-agent breakdown: agent, their AP in the window, their estimated override.
  **No client detail** — the RPC returns none, enforced by what its `RETURNS
  TABLE` declares.

### One roster read for both

`ovLoadMembers()` is the single `get_agency_members` loader this feature has, and
both surfaces go through it, so the level editor and the override box cannot
disagree about who is in the downline or at what level.

---

## The 8,610× family, untouched

One `get_team_summary` call site (`loadTeamRoster`), one
`get_agency_leaderboards` call site (`lbLoadBoards`), `lb_agent_metrics()`
byte-identical, `lb_visible_members()` the single opt-out point, `lbSplitRows()`
never re-deriving the top-10 cutoff — none of it is touched, and
`test/leaderboards.test.mjs` and `test/team-roster.test.mjs` pass unmodified.
`get_downline_product_ap`'s own sale predicate is byte-identical to
`get_team_summary`'s `pol` CTE and Round 1's test compares them character for
character.
