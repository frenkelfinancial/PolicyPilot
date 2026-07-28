# Claude Code prompt — commit Leads, then make Summary + Policy Tracker theme-aware

> Paste below the line into the same Claude Code session/branch (`leads-ledger-restyle`).
> Goal: commit the finished Leads work, then retrofit the other two Ledger pages so all
> three respond to the light/dark toggle consistently — no more "Leads dark, others light."

---

Two tasks, in order.

## Task 1 — Commit the Leads restyle now
Commit the current uncommitted Leads work on branch `leads-ledger-restyle` as its own commit, e.g.:
`leads: restyle to Ledger 2a (both themes, responsive)`
Then continue with Task 2 as a **second commit** on the same branch.

## Task 2 — Retrofit Summary + Policy Tracker to be theme-aware
**Root cause (confirmed):** the `.ledger-leads` scope you just built uses `var(--lg-*)` tokens, so it follows the toggle. The older `.ledger` scope (Summary + Policy Tracker) hard-codes the **light** hex values directly (`.ledger{...background:#F5F3F0;color:#0F1D3D}`, `#B8CCEE`, `#2A5599`, `#FAF8F5`, `#3A73C9`, `#948C7F`, `#F0EDE7`, `#FFFFFF`, `#E4E0DA`, `'Spline Sans'`, …). That's why they stay light in dark mode.

**The fix is a literal → token swap.** The `--lg-*` tokens are already defined for **both** themes (`:root` = dark values, `body.light` = light values), so every `.ledger` rule that references a token becomes automatically theme-aware. Do NOT redefine tokens or invent new palettes — just replace the hard-coded literals.

### Scope of the swap
1. Every rule under the `.ledger` selector in the `<style>` block (the Summary + Policy Tracker CSS: `.ledger`, `.lg-*`, `.pt-*`, `.tracker-*`, and any status-pill rules there).
2. **Inline styles** in the Summary and Policy Tracker section markup (the sections carrying the `.ledger` class) — same as the 5 inline button retints you did for Leads. Grep those sections for `#` hex literals and convert them too.
3. Any JS that injects hard-coded Ledger hex for Summary/Tracker rows/pills (mirror what you did for `renderLeads()` → `lead-pill--{status}`).

### Exact mapping (light hex currently in `.ledger` → token to use)
```
#F5F3F0 → var(--lg-canvas)        #FFFFFF → var(--lg-card)         #FAF8F5 → var(--lg-inner)
#E4E0DA → var(--lg-border)        #F0EDE7 → var(--lg-divider)      #D8D3CA → var(--lg-border-strong)
#0F1D3D → var(--lg-text1)         #3B372F → var(--lg-text2)        #6B6459 → var(--lg-text3)
#948C7F → var(--lg-caption)       #B0A99C → var(--lg-faint)
#3A73C9 → var(--lg-blue)          #2A5599 → var(--lg-blue-deep)    #B8CCEE → var(--lg-blue-border)
#E7EFFB → var(--lg-blue-soft)     #5B94E8 → var(--lg-blue-mark)
#1B7A43 → var(--lg-green)         #9CC7AB → var(--lg-green-border) #E4F2E9 → var(--lg-green-soft)
#B3261E → var(--lg-red)           #E4B7B4 → var(--lg-red-border)   #FAE8E7 → var(--lg-red-soft)
sold bg #F2F8F4 → var(--lg-sold-bg)   sold border #C6E0CF → var(--lg-sold-border)
```
Status pills in Summary/Tracker, if any, map to the same pill tokens you defined:
`--lg-pill-{new|called|noans|appt|obj|ni|sold}-{fg|bg}`.

**Fonts:** `'Spline Sans'` and `'Spline Sans Mono'` are theme-independent, so they can stay — but to mirror the `.ledger-leads` pattern, set `--sans`/`--mono` on the `.ledger` scope and reference `var(--sans)`/`var(--mono)` in its rules.

**If a literal has no exact `--lg-*` match:** pick the closest existing token; only add a new token (defined under both `:root` and `body.light`) if truly none fits, and tell me which and why.

### Preserve — restyle only
No functional changes to Summary or Policy Tracker: keep all IDs, classes, `data-*`, inline handlers, sort/filter/render functions, and the responsive rules already in place. This is a color/token swap, not a rebuild. Do not touch layout or breakpoints except to fix any dark-mode-only contrast bug you introduce.

## Verify (both tasks)
- Toggle the theme and confirm all **three** Ledger pages — Summary, Policy Tracker, Leads — now render correctly in **both** light and dark, and visually match each other in each mode.
- Headless screenshots (same harness/widths as before: 760/1024/1280/1440/1920/2560), both themes, for Summary + Tracker; confirm no light-on-light or dark-on-dark contrast failures, correct pill colors, mono numerals, and no layout regression / horizontal overflow.
- `npm run check` → 0 new errors/warnings. Then `npm run prebuild` to sync `www/`.
- Commit Task 2 (e.g. `ledger: tokenize Summary + Tracker for dark-mode parity`).
- Report: files changed, a concise per-page diff summary, before/after screenshots in both themes, and confirmation the three pages are now consistent. Leave both commits on `leads-ledger-restyle` for my review.
