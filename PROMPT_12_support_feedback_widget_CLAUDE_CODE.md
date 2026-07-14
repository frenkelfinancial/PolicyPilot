# PROMPT 12 — In-app Support / Feedback widget (Claude Code)

> Purpose: run inside the PolicyPilot repo. The backend framework is ALREADY
> BUILT and committed — this prompt adds the frontend widget to app.html,
> applies the SQL, deploys the function, and verifies end-to-end.

---

You are adding a **Support / Feedback** entry to the left sidebar of the desktop CRM (`app.html`) for my live PolicyPilot / ProducerStack system — placed in the sidebar's bottom block, **directly above the Settings item**. The goal: any logged-in agent can open it to report a bug, request a feature, ask a question, or give feedback — and the copy should make clear we **highly encourage constructive criticism** because it's how we make this the best CRM for producers.

## What already exists (source of truth — read these first, do NOT rebuild)

- `supabase/migrations/20260714_support_tickets.sql` — `support_tickets` table + RLS. **Schema changes are pasted manually into the Supabase SQL Editor — never `supabase db push`.** The file is idempotent.
- `supabase/functions/support-ticket/index.ts` — verifies the caller's JWT, inserts the ticket with the service-role key, then emails me via Resend. Reuses `_shared/cors.ts` and the existing live `RESEND_API_KEY` + `DIGEST_FROM` secrets. Reads the payload shape documented in its header comment — the widget must send exactly that shape.
- `app.html` is a single ~22k-line static file (vanilla JS + supabase-js via `sb`), deployed on GitHub Pages, Capacitor-wrapped for mobile. No React/Next anywhere — do not introduce frameworks or new build steps.

## Facts about the existing UI — do NOT "fix" or collide with these

1. **Placement is the sidebar, not a floating button.** The left sidebar (`.sidebar`, fixed, 64px collapsed / expands on hover) ends with a `.sidebar-bot` block (~line 3526) containing the Settings `.nav-item` (`onclick="nav('settings')"`, `data-ico="gear"`) followed by the sign-out button. Insert the new item as a `.nav-item` **inside `.sidebar-bot`, immediately BEFORE the Settings item**, using the exact same markup shape: `<span class="ico" data-ico="…"></span><span class="nav-lbl-text">Support</span>`. It opens the modal via `onclick` — it is NOT a `nav('…')` view and must never get the active/selected nav state. Study how `data-ico` icons are registered in app.html and reuse an existing chat/help/lifebuoy icon if one exists; otherwise add one following the exact same icon-definition pattern. Note `line 9735` already queries `.sidebar .nav-item[onclick*="settings"]` — make sure your insertion doesn't break that selector or any sidebar hover/collapse styling.
2. **Desktop only.** The sidebar is the computer-size layout's nav — if app.html hides/replaces the sidebar on its mobile breakpoint, the item disappears with it automatically; add no extra media queries unless the sidebar itself is still visible on mobile (check first). Never on marketing pages (index/features/pricing/support.html) — app.html only, and only after login (the sidebar starts `display:none` until auth completes, which covers this).
3. **Reuse existing patterns, don't invent new ones:**
   - Modal: the `.overlay` > `.modal` pattern (see `#pbAddFundsModal` around line ~4959), including the `onclick="if(event.target===this)…"` backdrop-dismiss.
   - Toast: `showToast(message, color)` already exists — use it for success (`#10b981`) and failure.
   - HTML escaping: `esc()` is defined near the top of app.html.
   - Edge calls: `const { data, error } = await sb.functions.invoke('support-ticket', { body })` — supabase-js attaches the JWT automatically.
   - Styling: match the app's existing CSS variables (`var(--card)`, `var(--text)`, `var(--accent)`, etc.). The sidebar item should inherit all `.nav-item` styling untouched; only the modal needs new CSS.
4. **The `CARRIER_BONUSES` / `COMP` mirror rules in CLAUDE.md are untouched by this work** — you should not need to modify any data files.

## The widget itself

- **Launcher:** the sidebar `.nav-item` per fact #1 — icon + "Support" label (label shows on sidebar hover-expand like every other item), sitting directly above Settings.
- **Panel/modal contents:**
  - Heading: "Support & Feedback"
  - Sub-copy (verbatim spirit, tune the words): *"Found a bug? Want a feature? Think something sucks? Tell us. We highly encourage constructive criticism — it's how we make Producer Stack the best CRM for producers."*
  - Type selector (segmented buttons or select): 🐞 Bug · 💡 Feature request · 📣 Feedback · ❓ Question — maps to `type`: `bug` / `feature` / `feedback` / `question` (the edge function rejects anything else).
  - Subject (single line, required, max 200 chars) and Message (textarea, required, max 5000 chars) with a live character counter on the textarea.
  - Auto-attached context (shown as fine print "We'll include your current page & browser info to help us debug"): `{ view: <current app view/section id>, url: location.href, user_agent: navigator.userAgent, viewport: innerWidth+'x'+innerHeight, app_version: <existing version const if one exists, else null> }`.
  - Submit button with a loading state; disable while in-flight; on success replace the form with a thank-you state showing the returned `ticket_id` ("Ticket #… — we read every one of these") and auto-close after a few seconds + `showToast('Thanks — feedback received!', '#10b981')`. On error, keep the form contents intact and show the server's error message.
  - Escape key and ✕ button both close it. No data is persisted client-side.

## Work in this exact order, confirming each step

1. **Read the framework files** listed above plus the sidebar markup/CSS (`.sidebar`, `.sidebar-bot`, `.nav-item`, the `data-ico` icon system) in app.html so placement and visibility rules match reality, not this prompt's line numbers.
2. **SQL:** give me the contents of `supabase/migrations/20260714_support_tickets.sql` as a block to paste into the Supabase SQL Editor, and wait for my confirmation that it ran.
3. **Secrets + deploy:**
   - `supabase secrets set SUPPORT_NOTIFY_TO="jacef8778099@gmail.com"` (confirm with me first if a different support inbox should be used).
   - `supabase functions deploy support-ticket` (JWT verification stays ON — do not pass `--no-verify-jwt`).
   - `RESEND_API_KEY` and `DIGEST_FROM` already exist and are live (wallet emails use them) — reuse, never rotate or hardcode.
4. **Frontend:** add the sidebar item, modal, CSS, and submit JS to app.html following facts #1–3. Keep the modal/JS self-contained (one CSS block, one HTML block, one JS block, clearly comment-fenced `<!-- support-widget -->` so it's easy to find in the 22k-line file); the sidebar item is the one-line insertion in `.sidebar-bot`.
5. **Verify before calling it done:**
   - Serve app.html locally, log in, confirm: "Support" item sits directly above Settings, label appears on sidebar hover-expand, hidden while logged out, opening it never marks it (or Settings) as the active nav view, and sidebar collapse/hover behavior is unchanged.
   - Submit one real test ticket of type `feedback`; confirm the row lands in `support_tickets`, the email arrives at SUPPORT_NOTIFY_TO with reply-to set to my login email, and the modal shows the ticket id.
   - Confirm a submission with an empty subject is blocked client-side and (if forced) rejected server-side with a readable error.
   - Show me a diff summary of app.html changes (it's huge — summarize, don't dump).

Do not restyle unrelated parts of app.html, do not touch the dialer, and do not add this widget to any other page.
