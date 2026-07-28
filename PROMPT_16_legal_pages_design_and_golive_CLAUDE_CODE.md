# PROMPT 16 — Claude Code — Legal pages: match site design + wire into every footer + push LIVE

> **Target:** Claude Code, ProducerStack repo (repo root = the folder containing `index.html`, `styles.css`, `app.html`).
> **Goal:** Take the finished `privacy-policy.html` and `terms-of-service.html` (legal text is FINAL — written July 27, 2026),
> redesign them so they look like first-class pages of producerstackcrm.com, link them from the footer of every page and
> from the signup flow, then commit and push so they are LIVE on GitHub Pages — **fully autonomous, zero manual steps for me.**
> The only thing you never do is change the legal wording.

---

## Hard rules — read twice

1. **The legal TEXT is frozen.** Every sentence, heading, number, table value, date, email, and phone number in
   `privacy-policy.html` and `terms-of-service.html` stays byte-for-byte identical in meaning and order. You are
   re-skinning the container, not editing the contract. Do not "improve," shorten, reword, re-number, or reorder
   anything. If a design choice would force a wording change — change the design, not the words.
2. **Do not touch app logic.** No edits to `app.html` JS, Supabase functions, SQL, or billing. The one exception is
   the small signup-consent link-in (Step 4), which is markup only.
3. **Fully autonomous.** No approval gates in this prompt. Work through every step including `git push`. If the
   pre-push hook (`.githooks/pre-push`) blocks, read what it wants, satisfy it legitimately, and push again — never
   bypass hooks with `--no-verify`.
4. **Idempotent.** Running this prompt twice must not duplicate nav bars, footers, or links.

## Ground truth about the site (verify against the repo — do not assume)

- Static HTML on **GitHub Pages**, custom domain `producerstackcrm.com` (see `CNAME`). A push to the default branch
  IS the deploy. There is no build step.
- Marketing pages (`index.html`, `features.html`, `how-it-works.html`, `pricing.html`, `support.html`) share:
  - `styles.css` + `shared/tokens.css` design tokens; fonts **Plus Jakarta Sans** (UI) and **DM Mono** (numbers)
    loaded from Google Fonts with `preconnect`.
  - The animated background shell: `<div class="bg-canvas">` with `.bg-aurora`, six `.orb`s, `.bg-grid`, `.bg-vignette`.
  - The fixed nav: `.nav > .nav-inner` with logo (`assets/logos/producer-stack-logo.png`), links
    (Features / How It Works / Pricing / Support), `.btn-ghost` Sign In + `.btn-nav` Start Free Trial, hamburger +
    `.mob-menu`, and the scroll listener that toggles `.scrolled`.
  - The page-top pattern: `.page-hero` with `.eyebrow`, `.page-h` (with `.hl` gradient span), `.page-sub`, and
    `.anim d1/d2/d3` stagger classes.
  - `.reveal` + IntersectionObserver scroll-in animation.
  - The footer: `.ft` with brand blurb, Product / Features / Support columns, and `.ft-bottom` with
    `© 2026 Producer Stack` and Privacy · Terms links.
  - Favicon: `assets/logos/producer-stack-logo.png`.
- The two legal pages currently use their own minimal standalone dark stylesheet (self-contained `<style>` block,
  no nav, no footer, no fonts). Content is complete and correct — 28 ToS sections, 14 Privacy sections, rate tables,
  callouts (`.callout` accent-left-border and `.shout` red-left-border boxes), and a `.contact` card.
- `PolicyPilot_Design_System.docx` and `PRODUCT.md` document the design personality: modern, fast, craft-first,
  no hustle-bro energy, dark theme, bright-light legible.

## Step 1 — Redesign the two legal pages as native site pages

Rebuild `privacy-policy.html` and `terms-of-service.html` on the marketing-page template:

- **Head:** same font preconnects/loads, `styles.css`, favicon, plus a real `<meta name="description">` for each
  (e.g. "How Producer Stack collects, uses, and protects your data." / "The terms that govern your use of Producer
  Stack."). Keep `<title>` as "Privacy Policy — Producer Stack" / "Terms of Service — Producer Stack".
- **Shell:** the standard `bg-canvas` background, the standard nav (no link marked `.active` — or add a subtle
  "Legal" treatment if the nav supports it without CSS surgery), the standard mobile menu, and the standard footer —
  copied from `pricing.html` so it stays in sync with the newest footer markup.
- **Hero:** `.page-hero` with eyebrow "Legal", `.page-h` "Privacy <span class=hl>Policy</span>" /
  "Terms of <span class=hl>Service</span>", and the effective date as the `.page-sub` (keep the exact date text
  "Effective date: July 27, 2026").
- **Body layout:** a single readable column (~760–820px) inside the standard `.section > .sec-shell` wrapper.
  Restyle the existing elements with a small page-scoped `<style>` block that uses the site tokens
  (`var(--text)`, `var(--text2)`, `var(--border)`, `var(--accent)`, etc.) instead of the old hardcoded hex values:
  - `h2` section headings in Plus Jakarta Sans semibold with the thin bottom border, generous top spacing.
  - Rate/pricing tables restyled like the pricing page's rate cards: rounded 16px border, `rgba` card background,
    uppercase 11px letter-spaced header row, **DM Mono for all dollar amounts**.
  - `.callout` (accent left border) and `.shout` (red left border) keep their semantics but pick up the site's
    card background and radius.
  - `.contact` card styled like a site card.
  - Links in `var(--accent)`.
- **Sticky table of contents:** on ≥1100px viewports, a slim left-rail TOC (section numbers + short titles,
  anchor links, current-section highlight via IntersectionObserver — reuse the pattern already on the page for
  `.reveal`). On smaller screens it collapses into a "Jump to section ▾" `<details>` above the content. Generate
  anchors by adding `id`s to the existing `h2`s — ids only, headings' text untouched.
- **Cross-links:** the pages already link to each other and to `pricing.html` — keep every existing `href` working.
- **Print:** a tiny `@media print` block — white background, black text, hide nav/orbs/footer/TOC. Legal pages get
  printed; make that not look broken.
- **Motion:** apply `.reveal` sparingly (per-section is fine); respect the site's existing reduced-motion handling.

## Step 2 — Verify the redesign locally before wiring anything

- Serve the repo (`python -m http.server` or the repo's `serve.ps1` equivalent) and load both pages headlessly
  (Playwright is fine) at 390px, 768px, and 1440px. Screenshot each and eyeball: no horizontal scroll, tables
  legible on mobile (allow horizontal scroll *inside* the table card only), TOC behaves, footer renders once.
- **Diff the legal text:** extract visible text from the old and new versions of each page (strip tags, collapse
  whitespace) and diff them. The only acceptable differences are the removed "← Back to Producer Stack" link text
  and any TOC/nav/footer chrome you added. **If a single legal sentence differs, stop and fix before proceeding.**

## Step 3 — Footer links on every page (idempotent check)

`index.html`, `features.html`, `how-it-works.html`, `pricing.html`, `support.html` should already have
`.ft-bottom` Privacy · Terms links pointing at `privacy-policy.html` / `terms-of-service.html` (fixed July 27).
Verify each; fix any page still pointing at `#` or missing the links. Also check the other top-level marketing
HTML files in the repo root (e.g. `power-dialer.html`, `underwriting-preview.html`) — if a file has the standard
site footer and is publicly reachable, its footer gets the same two links. Skip drafts/archives.

## Step 4 — Signup consent link-in (markup only)

In `app.html`, find the signup view (search `view=signup` / the signup form). Directly beneath the primary
signup button, add one small muted line if it's not already there:

> By creating an account you agree to the <a href="terms-of-service.html" target="_blank">Terms of Service</a>
> and <a href="privacy-policy.html" target="_blank">Privacy Policy</a>.

Style it with existing tokens (12px, `var(--text3)`, accent links). **No JS, no validation changes, no new
checkbox** — this is a disclosure line, not a logic change. If an equivalent line already exists, update its
hrefs and stop.

## Step 5 — Go live, autonomously

1. `git status` first — expect only the files this prompt touched (plus this prompt file). Anything else modified:
   leave it alone and exclude it from the commit.
2. `git add` the touched files; commit as
   `Legal: redesign privacy policy + terms to site style, wire footer/signup links (text unchanged)`.
3. `git push` to the default branch. Satisfy `.githooks/pre-push` legitimately if it objects.
4. **Verify live:** poll `https://producerstackcrm.com/privacy-policy.html` and
   `https://producerstackcrm.com/terms-of-service.html` (GitHub Pages can take a couple of minutes; retry with
   backoff up to ~5 min). Confirm HTTP 200, the new design markers are present (e.g. the `bg-canvas` div and
   "Effective date: July 27, 2026"), and grab one live screenshot of each.
5. Spot-check one live footer (`https://producerstackcrm.com/pricing.html`) resolves its Privacy/Terms links to 200s.

## Step 6 — Report

End with: files changed, a before/after screenshot pair per legal page, the text-diff result from Step 2
("legal text identical" or what you fixed), the live URLs with their HTTP statuses, and the commit hash.

## Do NOT

- Do not edit any legal wording, section numbers, rates, dates, or contact info.
- Do not touch Supabase, SQL, edge functions, billing logic, or any JS beyond the IntersectionObserver TOC.
- Do not add analytics, trackers, or third-party scripts to the legal pages (the Privacy Policy promises none).
- Do not restructure `styles.css` — page-specific styling lives in each page's own `<style>` block.
- Do not force-push, amend published history, or bypass git hooks.
