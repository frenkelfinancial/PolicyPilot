# PROMPT OV2 — report

**Round 2 of 2. The screen and the arithmetic.** One definition:
`// <override-core>` in `app.html`. Doc: `docs/override-estimator.md`. Tests:
`npm run test:override` (`test/override.test.mjs`, 33 tests).

**No migration. `git status --porcelain supabase/` is empty** — pasted in §7.
Four files changed, two added; `scripts/check-app.baseline.json` untouched;
`test/leaderboards.test.mjs` and `test/team-roster.test.mjs` pass **unmodified**
(zero diff, 60 and 57 tests).

---

## 1. The product mapping — **the unmapped list is EMPTY**

**All ten distinct product keys in the production book resolve to a real COMP
row.** Nothing is dropped, nothing is silently priced at zero, and the "N
policies on products with no comp-table entry" line does not render for this
book today.

That is the headline the brief asked for at the top, and it is the good version
of it. **Executed live** against the linked project (`cweiaibjigjwspmshcrj`) —
every key below came out of `public.policies` under the same sale predicate
`get_downline_product_ap` uses, then through the **shipped** `ovResolveProductKey()`
→ `getActiveCommKey()` → `COMP` chain, headless.

```
OK   Americo|Whole Life|std               -> americo_eagle   cut=false   6 pol  $11969.40
OK   American-Amicable|Whole Life|std     -> aa_senior       cut=false   4 pol  $6382.56
OK   Transamerica|Whole Life|std          -> trans_express   cut=false   2 pol  $3084.72
OK   American-Amicable|aa_senior|level    -> aa_senior       cut=false   1 pol  $2170.92
OK   Ethos|Whole Life|std                 -> ethos_tawl      cut=false   2 pol  $1920.00
OK   Corebridge|Whole Life|gi             -> core_giwl       cut=false   2 pol  $1457.40
OK   Transamerica|trans_express|level     -> trans_express   cut=false   2 pol  $1101.84
OK   American-Amicable|Whole Life|level   -> aa_senior       cut=false   1 pol  $786.48
OK   Corebridge|Whole Life|std            -> core_siwl       cut=false   1 pol  $548.40
OK   Corebridge|core_siwl|gi              -> core_giwl       cut=false   1 pol  $468.12

10 distinct products, 10 mapped to a COMP row, 0 unmapped.
UNMAPPED LIST: (empty)
```

**Round 1's §1 sampled five keys; the whole book holds ten.** Five that Round 1
did not show are `Transamerica|Whole Life|std`, `Ethos|Whole Life|std`,
`American-Amicable|Whole Life|level`, `Corebridge|Whole Life|std` and
`Corebridge|core_siwl|gi`. All five map. Two of them are exactly the awkward
shapes Round 1 predicted:

- `American-Amicable|Whole Life|level` — a display category with a **legacy**
  health class. `LEGACY_CLASS_MAP` folds `level` → `std`, then
  `CARRIER_PRODUCTS['American-Amicable'].products['Whole Life']` gives
  `aa_senior`. Neither half alone resolves it.
- `Corebridge|core_siwl|gi` — a **legacy raw COMP key** whose health class
  overrides it. `cfg.gi` wins, so this resolves to `core_giwl`, **not** to the
  `core_siwl` the column literally stores. That is correct and it matters: the
  two rows pay 55 and 72 at level 80. A resolver that trusted the stored string
  would overpay this policy by 17 points.

**The reporting path is still built and still tested**, even though it fires on
no row today — a carrier added tomorrow with no COMP entry is counted, named and
printed rather than folded into a zero.

---

## 2. The hand-checkable arithmetic trail

One agent, one product, one window, every intermediate value printed. Run
against the **shipped** functions, not a re-typed copy.

```
product key (as stored)   Americo|Whole Life|std
-> split                  carrier="Americo"  product="Whole Life"  cls="std"
-> getActiveCommKey       COMP key "americo_eagle", cut=false
AP in the window          $7229.16
leader @ 85               getCommPct('americo_eagle', 85, false) = 80%
agent  @ 80               getCommPct('americo_eagle', 80, false) = 75%
spread                    80 - 75 = 5 points
est. advance override     7229.16 x 5% x 0.75 = $271.09
```

Check by hand: `7229.16 × 0.05 = 361.458`; `× 0.75 = 271.09`.

**And the answer the original description would have given**: the agent's own
advance on that AP is `7229.16 × 75% × 0.75 = $4,066.40`, and 5% of that is
**$203.32** — 25% low, on one product, on one agent.

The brief's own worked example, independently:

```
americo_eagle, leader 85 / agent 80, AP $888.89
  spread 5 points -> $33.33   (NOT $25.00)
```

### The real downline, priced live

`get_downline_product_ap(null, null)` called **as the leader** (`set local role
authenticated` + a real JWT claim), then priced through the shipped core:

```
Preston Guyette @ 80, against Jace Frenkel @ 85

  American-Amicable|Whole Life|std -> aa_senior
      AP $5847.84   leader@85 70%   agent@80 65%   spread 5 pts  ->  $219.29
  Corebridge|Whole Life|gi         -> core_giwl
      AP $1457.40   leader@85 55%   agent@80 55%   spread 0 pts  ->    $0.00
  Americo|Whole Life|std           -> americo_eagle
      AP $1188.24   leader@85 80%   agent@80 75%   spread 5 pts  ->   $44.56
  Transamerica|Whole Life|std      -> trans_express
      AP  $484.32   leader@85 85%   agent@80 80%   spread 5 pts  ->   $18.16

  TOTAL est. advance override:  $282.01
  downline AP in window:      $8,977.80
  zero-spread policies:        2  ($1,457.40)
  unmapped policies:           0
```

**`$8,977.80` is the same figure `get_team_summary` reports for Preston** (OV1
report §5), to the cent — the two screens cannot disagree about how much he
wrote, and now they cannot disagree about what it is worth either.

---

## 3. 🔴 A correction to the brief's premise, and it changes what the owner sees

The brief said Round 1 measured *"seven downline agents sitting at 100 against
the owner's 85"* and concluded **every override computes negative, clamps to
zero, and the whole feature reads $0 on day one.**

**Those seven agents are not in this owner's downline.** Queried live:

| Agent | Level | Downline | Recorded level changes |
|---|---|---|---|
| **Jace Frenkel** (the leader) | **85** | 2 | 0 |
| Preston Guyette | **80** | 0 | 0 |
| Owenclark 2831 | **80** | 0 | 0 |
| Riker Blahnik, Brenofinacial, 15charlie06, Jacef8778099 Test1, Iyzedoutz, … | 90 / 100 | 0 | 0 |

The only two agents in the agency are **both at 80, below the owner's 85**.
The agents at 100 are elsewhere in the database and are nobody's downline. So
the clamp is not what suppresses the figure here — the real downline is worth
**$282.01**.

**What does suppress it is the other half of the brief's warning, and that half
is exactly right**: `contract_level_changes` holds **0 rows** for every agent in
production, so `level_changed_by_self` and `level_changed_at` come back NULL on
both downline rows, and the launch-state rule refuses to price a level nothing
has ever recorded:

```
TODAY: priceable = false, total = $0.00
  -> the screen renders the SET-YOUR-LEVELS PROMPT and no grid.
```

So the owner still meets the prompt first, still for a good reason, and the
first thing he does on the Agency tab turns it into $282.01. **The prompt was
worth building; the reason it fires is not the one predicted.** Both cases are
tested — an all-unset roster and an agent-above-leader roster are separate
tests with separate failure messages.

---

## 4. How much of his own downline currently carries a zero spread

**2 of Preston's 7 policies — $1,457.40 of $8,977.80, 16% of the AP.**

Both are `Corebridge|Whole Life|gi` → `core_giwl`, which pays **55% at level 80
and 55% at level 85**. Five points of contract gap buys nothing on Corebridge
Guaranteed Issue. The screen says so in its own sentence rather than showing a
$0 and leaving him to wonder:

> 2 policies are on products where your level and theirs pay the same, so they
> earn no override.

Across the comp table at 85/80 the zero-spread products are `americo_wl`,
`aetna_senior`, `core_graded` and `core_giwl`; `mutual_fe` pays 4 rather than 5.
If he moves an agent to 90 the picture changes sharply — at 85/90 the spread is
zero or negative on **everything**, because he is then contracted at or below
them.

---

## 5. Which findings are executed and which are reasoned

**Executed.**

- The product-mapping table in §1 — live SQL against production, then the
  shipped resolver, headless.
- The arithmetic trail and the real downline pricing in §2 — the RPC called as
  the leader with a real JWT claim, priced through the shipped core.
- The contract levels, downline shape and `contract_level_changes` count in §3 —
  live SQL.
- **Every rendered output in §6** — a headless harness executes the *shipped*
  `bosOverrideHTML()` with the real `// <override-core>` and `// <comm-core>`
  blocks lifted out of `app.html`; only chrome is stubbed (`bosSkel`,
  `boFmtMoney`, `ppAgentName`, `getContract`).
- `npm test` (whole chain, exit 0), `npm run check`, `npm run test:override`
  (33/33), `npm run test:bosummary` (71/71), `test:team` (57/57),
  `test:leaderboards` (60/60), `test:contractlevels` (26/26).

**Reasoned, not executed.**

- **No browser has run this code.** Every render above is the shipped function
  driven from Node; the DOM wiring (`ovPaintLevels()` mounting into
  `#ov-levels`, the `onclick` handlers, the CSS) is reasoned from the markup and
  the existing patterns it copies.
- **`set_downline_contract_level` has never been called over PostgREST.** Round
  1 exercised it through SQL with an impersonated JWT; the argument naming
  (`p_agent_id` / `p_level`) and the numeric↔JSON round-trip of the returned
  level are matched against the migration text by a test, not by a live call.
- **The actual-override comparison is unexercised.** `commission_rows` and
  `statement_files` are both **empty in production** — no statement has ever
  been uploaded — so "Actual override" renders its dash on every real account
  today. The non-dash branch is executed only in the harness (§6, scenario 1).

---

## 6. The headless harness — printed outputs

Markup stripped to text. `(no markup at all)` means the function returned `''`.

**1. Leader with a downline, levels set (leader 85, both agents 80)**
```
Estimated override
This month · priced from the comp table, against what your agents wrote.
Est. advance override        est. $394
  Your comp-table percentage minus theirs on each product, applied to the annual
  premium they wrote. Not a share of their commission. Advanced at 75% advance.
Actual override              $281.50
  Override lines — commission from agents in your hierarchy, not from your own sales.
Agent              Their AP     Est. override
Preston Guyette      $9,400              $353
Owenclark 2831       $1,102               $41
An estimate, not a statement. It assumes every policy issues and stays on the
books, and it is priced at today's contract levels — the carriers pay what they pay.
```

**2. An agent contracted ABOVE the leader (agent 100 vs leader 85)**
```
Est. advance override        —
Actual override              $281.50
Agent              Their AP     Est. override
Preston Guyette      $7,229                $0
  This agent is contracted above you, so no override is estimated on their business.
```
Zero, never negative; a sentence, not an error; their AP still reported.

**3. Only zero-spread business (`aetna_senior` + `core_giwl`)**
```
Est. advance override        est. $0
Agent              Their AP     Est. override
Preston Guyette      $5,457                $0
  Contracted at 80 against your 85 — the comp table pays the same on everything
  they wrote here.
4 policies are on products where your level and theirs pay the same, so they earn
no override.
```

**4. An unmapped product (a carrier with no COMP row)**
```
Est. advance override        est. $271
Agent              Their AP     Est. override
Preston Guyette     $13,129              $271
3 policies are on products with no comp-table entry and are not included.
```
The mapped half still prices; the unmapped half is excluded **and named**.

**5. A non-leader** → `(no markup at all — the box is ABSENT)`
**5b. A leader with no downline** → `(no markup at all — the box is ABSENT)`

**6. An empty window (levels set, no production in range)**
```
Est. advance override        —
Actual override              $281.50
Agent              Their AP     Est. override
No downline production in this window.
```

**7. 🔴 The launch state — the production state today**
```
Estimated override
This month · priced from the comp table, against what your agents wrote.
Set your agents' contract levels to see estimated override
2 agents have no recorded contract level yet, so no override is estimated on
their business. Set them on the Agency tab.
```
No grid, no `$0`, no per-agent rows. Exactly the failure the brief named.

**8. No statements uploaded — actual override is a dash, never a zero**
```
Est. advance override        est. $271
Actual override              —
  Upload a carrier statement and this fills itself in.
```

---

## 7. Verification output

```
$ git status --porcelain supabase/
                                     <- empty. No migration, no edge function.

$ npm test
  ... exit 0, 0 failing tests across the whole chain
  > policypilot@1.0.0 check
  ✓ app.html: 0 new error(s), 0 new warning(s), 12 known (baselined)
  All checks passed — no new problems.

$ npm run test:override        33 tests, 33 pass, 0 fail
$ npm run test:bosummary       71 tests, 71 pass, 0 fail
$ npm run test:team            57 tests, 57 pass, 0 fail   (file unmodified)
$ npm run test:leaderboards    60 tests, 60 pass, 0 fail   (file unmodified)
$ npm run test:contractlevels  26 tests, 26 pass, 0 fail

$ git diff --stat scripts/check-app.baseline.json
                                     <- empty. Baseline not regenerated.

$ git diff --stat test/team-roster.test.mjs test/leaderboards.test.mjs
                                     <- empty. Both pass unmodified.
```

`git diff package.json` — **script lines only**:

```diff
-    "test:contractlevels": "node --test \"test/contract-levels.test.mjs\""
+    "test:contractlevels": "node --test \"test/contract-levels.test.mjs\"",
+    "test:override": "node --test \"test/override.test.mjs\""
...
-    ... && npm run test:contractlevels && npm run check
+    ... && npm run test:contractlevels && npm run test:override && npm run check
```

### The two existing tests that had to move, and why

Neither is one of the two the brief protects. Both are **censuses that grow when
a legitimate new surface joins**, and I extended the enumeration rather than
loosening the count:

1. **`test/bo-summary.test.mjs` — "the window is captioned by what it IS"** asserted
   exactly four `bosPeriodLabel()` uses. The override strip is a fifth surface
   naming the window **through the one helper**, which is the rule the test
   enforces, not an exception to it. I added an explicit `assert.match` for the
   new surface alongside the bumped count, so the census still catches a sixth
   surface inventing its own caption.
2. **`test/bo-summary.test.mjs` — "design tokens only, no hard-coded colour"** caught
   my `var(--ds-color-danger,#ef4444)` fallbacks in the new CSS. **The test was
   right and the code was wrong**; I deleted the hex fallbacks (all three tokens
   are defined on both themes) rather than touching the assertion.

`test/bo-summary.test.mjs`'s loader also gained `block('override-core')`, because
`_lgAdvComm()` now reads `ADVANCE_RATE` from it — a declared dependency lifted,
which is what that harness is for.

### Two things I did NOT do, deliberately

- **I did not add a `get_downline_product_ap` call inside
  `renderBackOfficeSummary()`.** `test/bo-summary.test.mjs` pins the RPC names
  reachable from that function. Both new RPCs shipped with Round 1's migration,
  so the *rule* is satisfied — but rather than edit the pinned list I routed
  them through loaders (`ovLoadProductAP()`, `ovLoadMembers()`), which is the
  idiom that function already uses for `lbAgencyState`, `lbLoadBoards` and
  `loadTeamRoster`. `test/override.test.mjs` then asserts every RPC this feature
  reaches is defined in `20260810_contract_levels.sql`, so the original test's
  *intent* covers the new path too.
- **I did not add a third `get_agency_members` call site.** My first cut did, and
  `test/contract-levels.test.mjs` caught it (it pins the count at two). The fix
  was better than the census: `ovLoadMembers()` now **delegates to the existing
  `loadAgencyMembers()`** — already the app's cached roster reader, five call
  sites, never throws — so this feature mints no query of its own and the count
  stays at two. A test asserts `ovLoadMembers` contains no `sb.rpc(` at all.

---

## 8. Plain-English summary

**The owner can now see what his agency is worth to him, before a single
statement arrives.**

Two things were built. On the **Agency tab** there is a *Contract levels* card
listing each connected agent with an editable number and, beside it, a plain
sentence saying whether that number has ever been changed and by whom — *"not
set"*, *"changed by you on 4 Aug"*, or *"changed by the agent on 4 Aug"*. Both
he and the agent are allowed to set it and the most recent change wins; what is
new is that a change can no longer happen quietly.

On the **Back Office Summary** there is an *Estimated override* box: what his
downline's production should be worth to him this period, sitting directly
beside the real override figure his carrier statements report. The two will not
match, and the card says so out loud instead of quietly editing one to fit the
other. Statements arrive weeks late, carriers pay what they pay, and the
estimate assumes every policy issues and stays on the books.

**The number is priced properly, and this is the part worth understanding.** An
override is not a cut of what the agent earns — it is the owner's own percentage
of the *premium*, minus what the agent was paid of that same premium. And that
gap is **not** the gap between their contract levels. Moving an agent from 80 to
85 is worth five points on Americo Eagle and on Transamerica Express, four
points on Mutual of Omaha, and **nothing at all** on Americo Whole Life, Aetna,
and both Corebridge graded and Guaranteed Issue products. Only the comp guide
knows which, so the comp guide is asked, per product, every time.

**Some business genuinely pays no override, and the screen says so.** Right now
two of Preston's seven policies — $1,457.40 of his $8,977.80 — are Corebridge
Guaranteed Issue, which pays 55% at level 80 and 55% at level 85. That is not a
bug and it is not a rounding error; five points of contract simply buys nothing
on that product. Rather than show a $0 and leave him guessing, the box prints a
sentence naming how many policies it applies to. A **separate** sentence,
deliberately never merged with it, would say if any policy were on a product the
comp table does not carry at all — because "this earns nothing" and "we could
not look this up" are different problems, and the second one is a bug report.
Today no policy in the book is in that second state.

**What he will see the first time he opens it is a prompt, not a number.** No
contract level in the system has ever been changed through the new path, so the
app knows what each agent's level says but not that anyone ever set it — and it
will not print a confident figure over a number nobody has confirmed. Setting
the two levels on the Agency tab turns the prompt into **$282.01**.

---

## 9. Numbered eyeball checklist for Jace

1. **Open the Agency tab.** Below the team table there is a new **Contract
   levels** card listing Preston Guyette and Owenclark 2831. Both show `80` in
   the box and *"not set"* underneath — that is correct, because nobody has ever
   changed either one through the audited path.
2. **Above them you should see the blue prompt**: *"Set your agents' contract
   levels to see estimated override — 2 agents have no recorded contract level
   yet."* Below that, *"Your own level is 85."*
3. **Type `80` into Preston's box and press Save** (yes, the same number — the
   point is to record that you set it). Expect a green *"Contract level saved"*
   toast, and the line under his name to change from *"not set"* to **"changed
   by you on <today>"**. The prompt's count should drop to 1.
4. **Now open Back Office → Summary** (the office toggle under the logo, then
   the landing screen). Below "The money, from your statements" there is a new
   **Estimated override** strip. With one level set it should show a figure —
   roughly **$282** on Lifetime for Preston's whole book, or less on a shorter
   window — and Owenclark still reading *"not set"*.
5. **Set Owenclark's level too**, and the prompt disappears entirely.
6. **Now the warning case.** Go back and set Preston to **90** — above your 85.
   Save. Expect an inline amber line: *"This agent is contracted above you, so
   no override is estimated on their business."* On the Back Office Summary his
   row should read **$0**, never a negative, with the same sentence beneath it.
   **Put him back to 80 when you are done.**
7. **Check one policy by hand.** With Preston at 80 and the period on
   **Lifetime**, his American-Amicable Whole Life business is **$5,847.84** of
   AP. Open the comp guide: `aa_senior` pays **65** at 80 and **70** at 85. So
   `5847.84 × 5% × 0.75 = $219.29`. That should be the largest single
   contributor to his total of **$282.01**.
8. **Check the zero.** His two Corebridge GI policies ($1,457.40) contribute
   **nothing**, because `core_giwl` pays 55 at both 80 and 85. The box should
   carry the line *"2 policies are on products where your level and theirs pay
   the same, so they earn no override."* If you see a "no comp-table entry" line
   instead, that is a different and more serious thing — tell me.
9. **"Actual override" will read `—`, not `$0.00`.** You have never uploaded a
   commission statement, and a dash is the honest answer. Upload one and the
   dash becomes a figure that will *not* equal the estimate; that is expected.
10. **Confirm nothing else moved**: the team table, the leaderboards, the
    Commissions panel, the money strip and the production graph are untouched,
    and Settings → your own contract level still works exactly as before.

---

## 10. PENDING LIVE VERIFICATION

1. **No browser has run any of this.** Every figure and every rendered block in
   this report came out of Node driving the shipped functions. The DOM wiring,
   the click handlers and the CSS are unexercised. Item 3 of the checklist is
   the first real test.
2. **`set_downline_contract_level` has never been called over PostgREST.** Round
   1 proved the authorization through SQL with an impersonated JWT; nothing has
   yet proved the `sb.rpc()` argument naming or the numeric round-trip of the
   returned level. Checklist item 3 is that proof.
3. **The actual override is unverified against a real parsed statement.**
   `commission_rows` is empty and `statement_files` is `0` — **no statement has
   ever been uploaded to this project**. So the expected-vs-actual comparison,
   which is half the point of the box, has never been seen with two real numbers
   in it. This is the single biggest gap in the round.
4. **The estimate has never been checked against a carrier's own override
   statement.** Even once a statement lands, whether the comp-guide spread
   matches what the carrier actually pays an upline is an open question this
   round does not answer — it prices from the guide, which is the only source
   the app has.
5. **No second-level hierarchy exists to test.** One leader, two accepted
   invitees, neither of whom has a downline. A leader who is themselves someone's
   downline — and whether an override should cascade — is a shape the data
   cannot exercise and this round does not attempt.
6. **Owenclark 2831 has no production at all**, so the per-agent breakdown has
   only ever been rendered with one real agent in it. Two-agent output exists
   only in the harness (§6, scenario 1).
7. **The `cut` path is untested against production**, because **every one of the
   ten live product keys resolves with `cut=false`** — Corebridge and
   Transamerica both carry explicit graded/GI override keys, so the ~40%
   fallback never fires on this book. It is unit-tested against real COMP rows
   (`americo_eagle` graded: 5 points → 3), but no production policy exercises it.
8. **A period other than Lifetime is unverified live.** The §2 pricing used
   `get_downline_product_ap(null, null)`. The window is the same
   `summaryPeriodRange()` every other card on that screen uses, but the bounded
   call has only been exercised in the harness.
