# Back Office — producer codes and retroactive attribution

Built 2026-07-29 (Phase 2 of the Back Office mission). Records which carrier
writing number or NPN belongs to which agent, and stamps that onto commission
lines **that were already ingested**.

**Read this before touching anything named `pc*` or `producer_codes`.**
Progress ledger: `docs/back-office-progress.md`. Phase 1 (the ingestion this
feeds off): `docs/back-office-ingestion.md`.

---

## Why it exists, and why the retroactivity is the whole feature

A carrier statement identifies the writing agent by a **code**, not by a name.
Phase 1 already captures whatever code a line carries
(`commission_rows.producer_code`) and leaves `attributed_agent_id` null,
because at ingestion time nothing knows whose code it is.

The obvious version of this feature — record a code, and future statements
attribute correctly — is not worth building. An agent's first act is to upload
six months of statements; if typing in their writing number afterwards does not
reach back over those six months, they have to re-upload everything, and the
Book of Business, the commission dashboard and the debt number are all wrong
until they do.

So the reconcile runs over **all** of the caller's commission rows, every time.

---

## The reconcile

`public.apply_producer_codes()` — `SECURITY DEFINER`, **no parameters**.

```
attributed  rows whose producer_code now resolves to an agent
cleared     rows this function had attributed whose code no longer resolves
```

Four properties, each of which is a test:

1. **Retroactive.** It walks every row, not just new ones. Saving a code
   attributes the statements you uploaded last month.
2. **Idempotent.** Running it twice reports `attributed=0, cleared=0`.
3. **Reversible.** Deleting a mistyped code and re-running *clears* what it
   attributed. A one-way stamp would leave the wrong agent's name on months of
   commission with no way back.
4. **Non-destructive.** Only rows whose `attribution_method` is
   `'producer_code'` are ever cleared, so a manual correction (Phase 6) is
   never clobbered.

**It takes no parameter naming an agent**, on purpose — it is anchored solely
on `auth.uid()`, so there is nothing to point at somebody else's book. Same
shape and the same reasoning as `get_team_summary`.

It has to be `SECURITY DEFINER` because `commission_rows` is deliberately
SELECT-only for `authenticated` (Phase 1) — the browser cannot update it, and
must not be able to.

---

## Matching a code to an agent

`producer_codes` has two agent columns and they mean different things:

| Column | Meaning |
|---|---|
| `agent_id` | The **tenant** — whose book the record lives in. What RLS keys on. |
| `subject_agent_id` | The agent the code **identifies**. |

For a solo agent they are the same id. On an agency owner's consolidated
statement they differ, which is exactly why they are two columns and why the
bulk load exists.

`carrier` NULL means "applies to every carrier" — an NPN, or one agency-wide
code. **A carrier-specific row always wins** over a NULL one; ties break on the
most recently created.

### `subject_agent_id` is guarded by a trigger

`producer_codes_guard_subject` refuses any subject that is not the caller
themselves or an agent connected by an **accepted** `agency_invites` row.

Without it, a client could record a code claiming to belong to any user id in
the system. It would only ever re-label the caller's *own* commission rows —
nothing leaks to the named agent — but "it only corrupts your own numbers" is
not a guarantee worth shipping, and Phase 4's leader rollups read this column.

> **Protect the column, not only the function that sets it.** This schema has
> learned that three times already — `20260703c` (`is_admin`), `20260730`
> (`phone_numbers` billing columns), `20260736` (`agency_code`). The trigger is
> here for the same reason.

Trusted contexts (`service_role`, the SQL editor) keep the usual carve-out, so
an admin backfill is still possible.

### `code_key` is derived, never trusted

`producer_codes_derive_key` recomputes `code_key` from `code` on every write. A
client that could supply its own key could file `QA-777` under the key
`SOMETHINGELSE` and make the reconcile match the wrong rows. Verified live: an
insert carrying `code_key: 'A-CLIENT-SUPPLIED-LIE'` stores `QA777`.

### One definition of "the same code"

Carriers print the same writing number as `QA-777`, `QA 777` and `qa777`.
`pc_normalize_code()` (SQL) and `pcNormalizeCode()` (browser) both reduce to
uppercase alphanumerics, and **a test re-implements the SQL from the migration
text and asserts the two agree** on a spread of samples. If they ever drift,
the bulk-load preview shows the agency owner one thing and the database does
another — silently, on money.

---

## The screen — Settings → Producer Codes

Three cards:

1. **Your Producer Codes** — add a code against a carrier, or against "All
   carriers (NPN)". An all-carriers code must be digits, because that is what
   an NPN is; anything else is refused with the reason. Every save and every
   removal runs the reconcile and **reports what it did**: *"Code saved — 2
   commission lines attributed."* A bare "Saved" would hide the entire point.

2. **Codes Seen On Your Statements** — every producer code appearing on a
   commission line you have ingested, whether or not you have recorded it, with
   the line count and total behind each. Unrecorded codes are highlighted and
   carry a one-click **Record as mine**. A screen that only listed the codes you
   already typed in could never tell you the one you are missing.

3. **Bulk Load** (visible only to an agent who has agency members) — a sheet
   with one row per agent: an email or name column, an NPN column, and one
   column per carrier. Columns are detected automatically.

### The bulk load never writes without a preview

`pcBulkPick()` **plans**; `pcBulkApply()` writes. The preview names every code
it would create against the agent it belongs to, and lists every row it is
skipping *and why* — a stranger's email, a non-numeric NPN, a code that appears
twice in the sheet, an unrecognised column. A test asserts `pcBulkPick` contains
no write at all.

Parsing is done in the browser with SheetJS, which app.html already loads for
the leads importer. Deliberately **not** an AI call: this sheet is one the
agency owner made, its columns are agent identifiers rather than carrier prose,
and a preview the owner confirms is a better guarantee than a model's
confidence score.

Re-applying a sheet with one new agent on it is the normal case, so Apply
upserts with `ignoreDuplicates` and reports *"N codes added · M were already
recorded"*.

> **`carrier_key` is load-bearing.** PostgREST's `on_conflict` can only name
> real columns, and the uniqueness rule folds a NULL carrier to `''`. The
> generated column `carrier_key` is what makes that rule expressible as
> columns; without it the whole bulk batch fails the moment one code in the
> sheet is already recorded. `producer_codes_key_uidx` is the index that must
> survive any future tidy-up.

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260740_producer_codes.sql` | `producer_codes`, two guard triggers, `pc_normalize_code()`, `apply_producer_codes()`, `get_producer_code_coverage()` |
| `app.html` — `// <producer-codes-core>` block | Pure: normalization, NPN shape, bulk column detection, the bulk planner, the summary sentences |
| `app.html` — `#stg-codes`, `pc*` functions | The screen |
| `test/producer-codes.test.mjs` | 33 tests — `npm run test:producercodes` |

---

## Verification performed at build time

| Layer | Result |
|---|---|
| Schema, behavioural (rolled back) | **16/16** — including the retroactivity, the carrier-specific override, the clear-on-delete, and the manual-attribution carve-out |
| Unit + structure tests | **33** |
| End-to-end against production | **22/22** — three throwaway accounts (leader, downline, unconnected stranger), a real statement ingested through the Phase 1 pipeline |
| Headless click-through | **23/23** — real browser, real sheet upload, rendered DOM |
| Residue after both live runs | **zero** |

### What the live runs found

- **The bulk upsert could not name its conflict target.** The uniqueness rule
  was an *expression* index (`coalesce(carrier,'')`), and PostgREST's
  `on_conflict` only accepts columns — so Apply failed silently the moment the
  sheet contained a code already recorded, which is the normal case. Fixed with
  the `carrier_key` generated column and a plain unique index over it.
- **Adding a Settings tab required editing two hand-written panel lists**
  (`settingsTab` and `initSettingsSection`), and missing the second one shipped
  a Producer Codes panel that rendered *on top of* Account rather than
  replacing it. Both now resolve panels structurally
  (`#sec-settings > [id^="stg-"]`), and a test asserts neither names panels one
  by one, plus that every tab has a panel and every panel has a tab.

Neither was caught by the unit tests; both were caught by driving the real
browser.

---

## Testing it by hand

1. Upload a statement with a writing-number column (Back Office) **before**
   recording any code. Its lines will show no attribution.
2. **Settings → Producer Codes.** The second card lists the codes that
   statement carried, all highlighted as not recorded, with the line counts.
3. **Record as mine** on one of them. Expect *"Code saved — N commission lines
   attributed."* — that N is the retroactivity.
4. The first card now lists the code as belonging to **You**; the second marks
   it **Recorded** and the coverage sentence drops by that many lines.
5. **Remove** the code. Expect *"Code removed — N commission lines
   un-attributed."*
6. Add an all-carriers code that is not digits. Expect a refusal naming the
   reason, with nothing saved.
7. With an agency member connected, drop an agent sheet into the third card.
   Expect a preview naming every code and every skipped row, an **Apply N
   codes** button, and nothing written until you press it.
