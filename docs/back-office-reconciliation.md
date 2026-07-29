# Back Office — reconciliation

Built 2026-07-29 (Phase 6 of the Back Office mission). The human-in-the-loop
layer: three queues, priority-ranked, with approve / correct / reject actions
that write through a service-role path and never delete anything.

**Read this before touching anything named `rc*`, `recon*`, or
`statement-review`.** Progress ledger: `docs/back-office-progress.md`.

---

## The decision the brief asked for: `review_queue`

> **Neither built on nor replaced. Left exactly as it is, and not used.**

`public.review_queue` (20260708) belongs to the carrier-mail pipeline. Three
things make it the wrong home for commission lines:

1. It is `parsed_event_id uuid NOT NULL references public.parsed_events(id)`
   with `unique (parsed_event_id)` on top. A commission row has no parsed
   event, so putting one there means inventing a fake parent or dropping the
   constraint that makes the table correct for its real owner.
2. Its `reason` vocabulary is that pipeline's — `pdf_unreadable`,
   `ambiguous_match`, `low_confidence`.
3. **It has 30 rows in production and `match-events` writes it twice a day on
   a cron.** Rewriting a live pipeline's queue to serve a screen it does not
   feed is a change with no upside and a real downside.

And it is not needed, because **`commission_rows` already IS the queue**. Phase
1 gave it `review_status` (`auto | needs_review | approved | rejected`,
check-constrained), a plain-English `review_reason`, `match_method` and
`match_confidence`. A second table pointing at those rows would be a second
place to keep in sync and the first thing to drift.

So `20260744` adds only what was genuinely missing: **who** resolved a row,
**when**, and **why** (`reviewed_by`, `reviewed_at`, `review_note`). Without
those, an approved row is indistinguishable from one the parser matched by
itself, and *"who decided this $4,000 chargeback was mine?"* has no answer.

---

## The three queues

| Queue | What is in it |
|---|---|
| **Policy Match Review** | `commission_rows` the parser could not place — `review_status = 'needs_review'` |
| **Unlinked Policies** | in-force policies whose draft date passed **45 days** ago with no commission line pointing at them |
| **Stuck Uploads** | statements that **failed**, or have been in flight for over an hour |

Unlinked Policies is the one that is not obvious. A policy nothing has ever
paid on is either a match that failed or a carrier that has not paid — **both
are worth an agent's attention**, and neither shows up anywhere else in the
app. A **lapsed** policy that was never paid is not in this queue: that is not
a reconciliation problem, it is a lapse.

---

## Priority

**It follows the money, not the age.**

A $4,000 chargeback nobody has looked at is the most urgent thing on this
screen; a $12 renewal line that matched nothing is the least, however long it
has sat there.

- **A chargeback is never low priority**, however small — it is money already
  taken back and it is the one an agent will be asked about.
- **A failed upload is always high.** Nothing was ingested at all, so every
  figure on every other screen is missing that statement and no total says so.
- An unpaid policy is ranked by premium **and** by how long it has waited: big
  but early is not urgent; small but very late still matters.

### The match-% sort

A row with **no** confidence is not a zero-confidence row — it never matched at
all — so it sorts to the end whichever direction is chosen, rather than
pretending to be the worst match. `0` and `null` mean different things here and
both are preserved.

---

## The write path

**`commission_rows` is SELECT-only for `authenticated`, and stays that way.**

An UPDATE policy wide enough to let the browser set `review_status` is wide
enough to let it set `matched_policy_id`, and pointing a commission row at
another agent's policy is precisely what this schema is built to prevent.

Every resolution goes through **`statement-review`** (service role,
`verify_jwt = true`, therefore deliberately absent from `config.toml`):

| Action | Effect |
|---|---|
| `approve` | accept the match the parser proposed |
| `match` | point the row at a policy the agent chose, by `client_id` |
| `unmatch` | detach a wrong match, back to `needs_review` with a reason |
| `reject` | this line is not mine — **never a delete** |

- **The agent comes from the JWT.** There is no agent id in the request body,
  because a body-supplied one would be a way into somebody else's book.
  Verified live: passing `agent_id` changes nothing.
- **`match` re-checks that the target policy belongs to the caller.** The
  picker only lists their own policies, but a picker is a convenience and not a
  security boundary. Verified live: linking to another agent's policy returns
  `404 policy_not_found` and the row is unchanged.
- **A row belonging to someone else is *skipped*, not reported.** Telling a
  caller "that row exists but is not yours" is itself a disclosure; they get a
  count of what actually changed.
- **Approving a line that was never matched is refused**, with a sentence
  saying to choose a policy or reject it — rather than quietly marking it done
  and claiming a link that does not exist.
- **Rejecting never deletes.** The row, its amount, its raw source and its
  statement all stay. "Nothing is discarded" is the rule the whole Back Office
  is built on, and a reconciliation screen that could delete a commission line
  is the one place it would break. The bulk bar says so on screen.
- **The statement's counters are recomputed** after every resolution, because a
  resolved row that still counts as "pending review" on the Ingest strip is the
  screen telling the agent their work did nothing.

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260744_reconciliation.sql` | 3 columns, 2 indexes, `get_reconciliation_summary()` |
| `supabase/functions/statement-review/index.ts` | the only write path |
| `app.html` — `// <recon-core>` block | Pure: queues, priority, sorting, queue building, headline |
| `app.html` — `#bopanel-reconciliation`, `rc*` | The screen |
| `test/reconciliation.test.mjs` | 39 tests — `npm run test:recon` |

`recon-core` declares **one** dependency — `commMoney` from `comm-core`, itself
pure. The test loads both blocks together. Duplicating a money formatter so
each core were standalone would give this app two ways to print a dollar
amount, which is what these blocks exist to stop.

---

## Verification performed at build time

| Layer | Result |
|---|---|
| Unit tests | **39** (`npm run test:recon`) |
| Full suite | **628 tests + `npm run check` clean** |
| End-to-end against production | **29/29** — real `statement-review`, two accounts, every boundary |
| Headless click-through | **31/31** — real browser driving the real edge function |
| Residue after both live runs | **zero** |

### What the checks found

**An existing invariant caught a real duplication in this phase's code.**
`test/back-office.test.mjs` asserts *exactly one `statement-parse` call site*,
because "two ways to parse is two places for the auth header and the reporting
to drift apart". The stuck-upload **Try again** button had added a second one.
Fixed by calling `boParseNow()` — which already owns the session header, the
retry flag and the failure reporting — instead of re-implementing it. The test
was right and the code changed.

**The click-through could not call the edge function at first.** The CORS
allowlist (`_shared/cors.ts`) covers the production origins plus
`http://localhost:8080` behind the `ALLOW_DEV_ORIGINS` secret, and the harness
serves from a random `127.0.0.1` port. Rather than flip a production secret for
a test, web security was relaxed **inside the throwaway Chrome profile only** —
the same choice `docs/agency-team-screen.md` records for the `transfer-leads`
run. Nothing server-side was altered, and `e2e-recon.mjs` exercises the same
calls for real, with real CORS.

---

## Testing it by hand

1. **Back Office → Reconciliation.** Three queues with counts, and a headline
   leading with the money at stake.
2. **Policy Match Review.** Biggest money first, marked high. A line that never
   matched says *no match* rather than 0%, and the parser's reason is on the
   row.
3. **Sort by Match %.** Rows that never matched go to the end, not the top.
4. **Link…** on a row. The picker lists your own policies, nearest name first.
   Confirm — the row becomes a manual match at 100% with your name on it.
5. **Tick two rows.** A bulk bar appears with Approve / Reject and the reminder
   that rejecting never deletes. Reject them, then switch the status filter to
   **Rejected** — they are still there, amounts intact.
6. **Unlinked Policies.** In-force policies whose draft date passed more than
   45 days ago that no commission line points at, with how long they have
   waited.
7. **Stuck Uploads.** Failed statements with the carrier-facing error and a
   **Try again** that re-reads the file.
8. **Reload.** The queue you were on is still selected.
