# PROMPT 3B — Claude Code — Phase 2 messaging-compliance fixes (pre-deploy)

> Context: you built Phase 2 (SMS/MMS/email metering + compliance) in the working
> tree — `data/sql/019_messaging_compliance.sql`, `_shared/messaging-shared.ts`,
> `_shared/tcpa.ts`, the eight edge functions, and the segment/TCPA unit tests.
> **Nothing has been deployed or run against the DB yet.** A Cowork review of the
> migration + compliance gate found five issues to fix *before* the SQL is applied.
>
> **Hard rules (unchanged):** do NOT run SQL against the database, do NOT deploy
> functions, do NOT set secrets, do NOT touch Telnyx/Resend. This prompt is
> **code + SQL text + unit tests only.** Money stays in mills. Because `019` has
> not been applied yet, edit it **in place** (do not add a new migration to patch
> it). Keep `npm run test:messaging` green and extend it. When done, stop and
> report a diff summary for Jace to green-light — same SQL-gate handoff as before.

---

## Fix 1 (highest priority) — E.164 phone normalization at every compare + write point

**Problem:** consent and DNC matching use exact string equality on the raw
recipient string. `messaging-shared.ts` does `.eq(contactCol, toAddress)` with no
normalization, and the inbound STOP handler inserts whatever format the provider
sends (Telnyx → `+1…`). If an agent's contact is stored as `(555) 123-4567` or
`5551234567` while the DNC row is `+15551234567`, the DNC check **misses and a
message goes to someone who sent STOP** — breaking the core "never contact an
opt-out" guarantee. Consent has the same mismatch but fails closed (wrongly
blocks), producing confusing false `no_consent` errors.

**Do:**
1. There is already a working `toE164()` in `_shared/dialer-next-lead.ts`
   (handles `+`, 10-digit, and `1`+10-digit; returns `""` on unparseable).
   **Extract it into a new `_shared/phone.ts`** and re-import it in
   `dialer-next-lead.ts` so there's one canonical implementation (no behavior
   change to the dialer). Export both `toE164(raw)` and a boolean
   `isValidE164(raw)` helper.
2. In `messaging-shared.ts` `runComplianceGate`, for phone channels (`sms`/`mms`):
   normalize `toAddress` via `toE164()` **once at the top**, and use the
   normalized value for the consent lookup, the DNC lookup, and the quiet-hours
   timezone lookup. If `toE164()` returns `""` for a phone channel, short-circuit
   `ok:false` with `reason:"invalid_phone"` (fail closed — never send). Leave
   email addresses untouched except `trim().toLowerCase()` for the email path so
   case differences don't cause consent/DNC misses.
3. Normalize **on write** everywhere a phone number lands in `consent_records`,
   `dnc_list`, `messages.to_address`, `inbound_messages.from_address`, and the
   inbound STOP → `dnc_list` insert **and** the "match the last outbound" lookup
   in `messaging-inbound-webhook` (`.eq("to_address", fromNumber)`): run the
   number through `toE164()` first so stored values are canonical E.164. Do the
   same in `messaging-send-sms` / `-mms` before inserting the `messages` row.
4. No data backfill needed (nothing deployed), but add a one-line comment in
   `019` noting that all phone columns are expected to hold E.164 and that reads
   assume it.
5. Tests: add `_shared/phone.test.ts` covering `toE164` for `+1…`, 10-digit,
   `1`+10-digit, punctuation, empty/garbage → `""`, and idempotency
   (`toE164(toE164(x)) === toE164(x)`).

## Fix 2 — consent-revocation resurrection

**Problem:** the consent query filters `.is("revoked_at", null)` **before**
ordering by `captured_at desc`. If a contact has an older non-revoked grant plus a
newer revoked one, the stale older row wins and the send is allowed even though
consent was more recently revoked.

**Do:** in `runComplianceGate`, fetch the single most-recent consent row for the
recipient **regardless of `revoked_at`** (order by `captured_at desc, limit 1`),
then require that row to have `revoked_at IS NULL` **and** `consent_type <> 'none'`.
Any newer revoked row therefore correctly blocks the send. Keep the `reason` as
`no_consent` (add `detail` distinguishing "revoked" vs "never granted" if cheap).

## Fix 3 — distinguish `express` vs `express_written` for SMS/MMS

**Problem:** the gate allows any `consent_type <> 'none'`, so a marketing SMS
would pass on merely oral `express` consent, which TCPA requires to be **written**
for marketing texts. Email has no such rule.

**Do:** make the SMS/MMS consent check require `consent_type = 'express_written'`;
allow `express` or `express_written` for email. Make the strictness a
`billing_config` boolean `sms_require_written_consent boolean not null default true`
(add it in `019`) so the compliant default holds but a transactional-only sender
can relax it deliberately — read it in the gate. Comment clearly that flipping it
to `false` is a compliance decision the operator owns.

## Fix 4 — quiet-hours function name is inverted

**Problem:** `isWithinQuietHours()` in `tcpa.ts` returns `true` during the
**allowed** window (8am–9pm), not during quiet hours. A compliance-critical
predicate with a misleading name is a sign-flip waiting to happen.

**Do:** rename to `isWithinAllowedHours()` (keep the same semantics — true = OK to
send), update the caller in `messaging-shared.ts` and all references in
`tcpa.test.ts`. Optionally keep a one-line deprecated alias if anything else
imports it, but grep first — if nothing else uses it, just rename cleanly.

## Fix 5 — unmapped area code fails open for western recipients

**Problem:** `timezoneForPhone()` falls back to `America/New_York` for any
unmapped area code. Eastern mornings start before western ones, so an unmapped
**western** number (or a toll-free number: 800/888/877/866/855/844/833, which have
no geography) could receive a text at 8am Eastern = its real 5am. Fail-open in the
one direction that matters.

**Do:** add a conservative fallback path. When the area code is **not** in
`AREA_CODE_TIMEZONES` (including toll-free prefixes), do not assume Eastern —
instead treat the send as allowed only if the current time is within
`[8am, 9pm)` in **both** `America/New_York` **and** `America/Los_Angeles` (the
intersection window, ~11am–9pm Eastern). This guarantees no contiguous-US zone is
violated for an unknown number. Implement as an `isWithinAllowedHoursUnknownTz()`
helper (or have `runComplianceGate` detect the fallback case and apply the
intersection) rather than silently defaulting the timezone. Add tests in
`tcpa.test.ts` for: known western code near its own boundary, and an
unmapped/toll-free number correctly blocked at 8:30am Eastern but allowed at noon
Eastern.

## Fix 6 — a2p status enum has no post-approval failure states

**Problem:** `a2p_registrations.status` CHECK is
`('not_started','pending','approved','rejected')`. If Telnyx **suspends** or
**expires** a campaign after approval, there's no state to represent it and the
gate (`status <> 'approved'`) would keep sending.

**Do:** extend the CHECK in `019` to
`('not_started','pending','approved','rejected','suspended','expired')`. The gate
already blocks anything `<> 'approved'`, so it handles the new states correctly —
just confirm that and add a code comment. In `a2p-status-poll`, map Telnyx
suspended/expired campaign states onto these values when the adapter returns them
(guard behind the existing "verify exact Telnyx field names" adapter comment — do
not invent field names; if unknown, leave a TODO in the adapter, not a guess).

---

## Wrap-up
- Update `package.json` `test:messaging` to include `_shared/phone.test.ts` and
  keep everything green: `npm run test:messaging`.
- Do **not** deploy, run SQL, or touch providers. Stop at the SQL gate and report:
  the files changed, the new `019` diff (fee/flag columns + enum), and the updated
  test count, so Jace can green-light applying `019` and deploying.
