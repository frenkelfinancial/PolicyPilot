# PROMPT 5 — Claude Cowork — The Browser / Visual / Human Steps Only

> Purpose: Claude Code does all the code, SQL, Stripe-API, and deploy work.
> This Cowork prompt covers ONLY the things Code genuinely can't do — the
> browser/GUI, DNS-at-my-registrar, real-inbox, and real-device checks. It is
> organized by phase. Run the matching section when that phase reaches it
> (Code will tell you when it hands a step off). Do NOT run a section early.
>
> Paste into a Cowork session with the PolicyPilot repo attached.

---

## North-Star principles (the four I'm beating Ringy on — verify them with human eyes)
1. **Billing transparency** — visually confirm balance + itemized ledger read correctly to a real user.
2. **Never charge for undelivered** — confirm a failed test message visibly shows "$0.00 — not charged."
3. **Deliverability & compliance moat** — confirm A2P is actually approved and email authenticates.
4. **Email that actually works** — confirm a real test email lands in the **inbox**, not spam.

## Ground truth
- Money is in **mills** ($1 = 1000 mills); everything else already built/deployed by Claude Code.
- Only do the section for the phase that's currently live. Nothing destructive without my OK.

---

## §1 — After Phase 1 go-live (wallet). Mostly optional — Code did it via Stripe API.
1. **Visual Stripe sanity check (optional):** in the Stripe dashboard, confirm the **Wallet Top-Up** product/prices exist (test + live) and that the old **per-number subscriptions were cancelled** during migration — no customer is still being billed the old $3/number subscription on top of wallet renewals.
2. **Eyeball the app:** open the live app Billing tab and confirm balance shows in dollars, "Add funds" opens checkout, and a $0 account is blocked from calling/buying a number.
3. Report anything that looks off; otherwise Phase 1 is confirmed.

## §2 — During Phase 2 (SMS/MMS/email + A2P). These BLOCK go-live — required.
1. **Email sending domain (DNS at my registrar):** add the **SPF, DKIM, DMARC, and return-path/MX** records the email provider gives (use the `reports.`-style subdomain to isolate reputation). Wait until the provider shows the domain **verified/green**. Paste me the exact records and where each goes.
2. **Telnyx A2P 10DLC (dashboard):** complete/submit the **brand** and **campaign** if the API adapter Code built needs dashboard finishing, and **watch it through to `approved`.** Record the brand/campaign IDs and the **real fees Telnyx charged** so Code's pass-through `a2p_registration` ledger amounts match reality. SMS/MMS must stay blocked until approved.
3. **Real inbox deliverability check:** send one test email to a real Gmail/Apple address and confirm it lands in **Primary/Inbox**, DKIM passing, not spam, with the signature intact and a reply threading back into the app.
4. **Failed-message visual proof:** trigger one undelivered test text and confirm in the app ledger it shows **"Not charged · $0.00"** (the money was held then voided). This is the differentiator — verify it with your own eyes.
5. Mark which items are green; anything red blocks live texting/email.

## §3 — After Phase 3 (transparency UI). Real-device + live-card checks.
1. **Device UI check:** open the Billing tab on **iOS, Android, and web** and confirm the wallet dashboard, itemized ledger, live cost preview, and monthly-spend summary render correctly with my design system intact (no broken layout, correct tokens).
2. **Live auto-recharge check:** with a real saved card, spend the balance below the auto-recharge threshold and confirm the card is charged **once** off-session, the wallet refills, a receipt appears, and there's **no double-charge and no SCA failure**.
3. **Undelivered-in-context:** confirm pending holds and voided ($0.00) rows are clearly distinct from settled charges to a normal user reading the screen.
4. Report results; if all green, the full wallet system is confirmed end-to-end.

## Do NOT
- Don't run a section before its phase is live. Don't approve A2P go-live or flip the email domain live until verified. Nothing destructive without my OK.
