# PROMPT 4 (Phase 3 of 3) — Claude Code — Billing-Transparency UI (BUILD + DEPLOY)

> Purpose: Build and ship the customer-facing wallet experience that makes my
> billing obviously clearer than Ringy's (their #1 complaint is that users
> can't see what they're spending). You build the UI AND deploy it. The
> auto-recharge Stripe automation you can wire via the Stripe API; the only
> browser/human bits are a real-device UI check and confirming off-session
> charges behave — those go to the Cowork prompt (file 05, §3).
>
> Run only after Phases 1 and 2 are verified LIVE. Re-read what shipped first.

---

## North-Star principles — this phase is almost entirely #1
1. **Billing transparency (the whole point).** The user always knows: current balance, what every past action cost (itemized), what a *pending* action will cost *before* confirming, and their spend trend. No surprises — the opposite of Ringy's "usage cost confusion."
2. **Never charge for undelivered** — surface it: pending holds show as "Pending," voided (undelivered) items show as **"Not charged · $0.00,"** so the user SEES the promise working.
3. **Deliverability & compliance moat** — surface A2P status and any compliance block in plain language.
4. **Email that actually works** — email sends appear in the same unified activity/ledger.

## Step 0 — Re-read shipped reality
Confirm real names: wallet tables, `wallet_ledger` columns (`entry_type`, `category`, `amount_mills`, `balance_after_mills`, `units`, `unit_rate_mills`, `status`), `billing_config` mills rates, `messages`/`a2p_registrations`. Build against the real schema. All money renders `mills / 1000` → `$X.XX`.

## Ground truth
- Frontend is the static `app.html` SPA — vanilla JS + my design tokens (`styles.css`, `shared/tokens.css`, `PolicyPilot_Design_System.docx`). No framework. Match the Billing section from Phase 1. Read via the existing Supabase client patterns in `app.html`; respect RLS (agent sees only their own).
- Deploy through the existing build/serve pipeline (and Capacitor iOS/Android if relevant). Approval gate before any live Stripe change.

## Build these, all matching my design system exactly

### 1. Wallet dashboard (top of Billing)
Big current balance in dollars; low-balance chip under threshold; **Add funds** (presets + custom, reusing the Phase-1 top-up checkout); plain note that **balance & credits never expire.**

### 2. Itemized ledger (the transparency centerpiece)
Filterable table of `wallet_ledger`: date, human description ("Outbound SMS — 2 segments @ $0.01"), category icon, units, unit rate, amount (− debit / + credit), running balance-after, and a **status pill**:
- `settled` → charged.
- `pending` → "Pending — held, not yet charged."
- `voided` → **"Not charged — message undelivered · $0.00"** in a reassuring style.
Filter by category + date range. CSV export (match the existing billing-history export pattern).

### 3. Live pre-send / pre-action cost preview
Before any spend, show exact cost from real rates + the Phase-2 segment helper:
- SMS/MMS composer: "This message = **3 segments = $0.03**," updating as they type; warn on crossing a segment boundary.
- Bulk/campaign: "Sending to 412 recipients ≈ **$X.XX**" before confirm.
- Call/power-dialer: per-minute rate + running "this session so far" cost.
- Buying a number: "$3.00/mo (local)" or "$10.00/mo (toll-free), renews {date} from your balance."
Every estimate reads `billing_config` — never hardcode.

### 4. Running spend + projection
"This month" summary: spent-to-date by category (calls/texts/MMS/email/numbers/A2P) + a simple pace projection. Directly answers Ringy's #1 complaint.

### 5. Low-balance alerts + auto-recharge
- Settings UI writing `wallet_accounts.auto_recharge_*` ("when balance drops below $X, add $Y").
- **Wire the automation via the Stripe API** (SetupIntent / saved card, off-session): when balance crosses the threshold, charge the saved card `auto_recharge_amount_mills` off-session and top up via the Phase-1 `wallet_topup` path (idempotent on PaymentIntent id). Guardrails: max one auto-recharge per short window, stop-after-repeated-failure, notify on failure, no double-charge on webhook retries. **Approval gate before enabling live off-session charging.**
- Low-balance banner + past-due number notice ("top up to keep (833) 555-0199") — never a silent release.

### 6. Compliance status surface
Show A2P status ("In review / Approved") and, where a send is blocked (no consent, DNC, quiet hours), a plain-English reason — never a silent failure.

## Hand off to Cowork (file 05, §3)
List for me: the real-device/browser UI check (Billing tab renders with design system intact on iOS/Android/web) and confirming a real off-session auto-recharge actually charges the saved card once without an SCA failure — a live-card check you'll want eyes on.

## Do NOT
- Don't change billing *logic* or rates — this phase presents the Phase 1–2 system. If you find a rate/logic bug, flag it, don't silently patch here.
- Don't hardcode rates/amounts/from-addresses. No framework, no foreign styling — match my tokens.
- No live off-session charging enabled without my go.

Prioritize: the user can instantly, correctly answer "what's my balance, what did that cost, what will this cost, and did that failed text charge me?" Ask before anything destructive.
