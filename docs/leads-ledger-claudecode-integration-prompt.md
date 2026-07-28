# Claude Code prompt — integrate the redesigned Leads page (Ledger 2a), both themes, fully responsive

> **How to use:** open Claude Code in the ProducerStack repo, paste everything below the line,
> and fill the three INPUT blocks (design spec, the new Leads HTML for light **and** dark,
> and screenshots). Claude Code runs the whole integration start to finish.

---

You are working in my ProducerStack repo. Integrate a **redesigned Leads page** (the "Ledger" 2a visual system) into the **live app**, wired for **both light and dark themes**, and **fully responsive so it doesn't break at different screen resolutions**. Restyle only — preserve every existing function, ID, class, handler, and data hook. Work start to finish; don't hand back a partial change.

## INPUTS I'm giving you

**1. DESIGN SPEC (the Ledger 2a style system):**
```
[PASTE THE STYLE SPEC HERE — or point to docs/leads-ledger-design-prompt.md]
```

**2. NEW LEADS PAGE HTML — light + dark versions from Claude Design:**
```
LIGHT: [paste HTML or give file path]
DARK:  [paste HTML or give file path]
```

**3. SCREENSHOTS:** [attach the light + dark screenshots at desktop width. Treat these as the visual source of truth for spacing, alignment, and proportions.]

---

## Step 0 — Find the real file(s) and make a safety net
`app.html` (repo root) and `www/app.html` have **diverged** — `www/app.html` is currently newer/larger and is where `toggleTheme()` and the full `renderLeads()` live. Before editing:
- Determine which file is actually served/deployed (check `git log`, recency, capacitor/build config, and which one has the complete Leads JS). Edit that one.
- If **both** are live copies, apply the identical change to both and say so. If it's ambiguous, ask me before proceeding.
- Create a git branch (e.g. `leads-ledger-restyle`) and commit the current state first so the change is reversible.

## Step 1 — Inventory what must NOT break
Scan the `#sec-leads` markup **and** every JS symbol it depends on, then produce a short "preservation list." You are restyling, not rebuilding — nothing on this list may be renamed or removed:
- Render/logic: `renderLeads()`, `filterLeads()`, `leadsTab()`, `setLeadView()`, `setLeadsPerPage()`, `leadsPage()`, `STATUS_CONFIG`, the standard **and** compact (`.compact-card` / `view-compact2` / `view-compact4`) row templates.
- Structural IDs: `#sec-leads`, `#lead-subtabs`, `#lead-search`, `#lead-filter-status`, `#lead-filter-source`, `#lead-filter-state`, `#vsw-standard/#vsw-compact2/#vsw-compact4`, `#lead-per-page`, `#lead-count-display`, `#lead-bulk-bar`, `#bulk-status-sel`, `#lead-select-all-row`, `#lead-list-container`, `#lead-pagination-top/-bot`, `#leads-empty`.
- Per-row hooks (used by delegated events): `.lead-cb`, `.lead-notes-cb`, `.lead-disposition-cb`, `.lead-call-btn`, `.lead-sold-btn`, `.lead-quick-quote-btn`, `.lead-edit-info-btn`, `.lead-delete-lead-btn`, `.lead-new-field-btn`, and every `data-lid` / `data-phone-href` / `data-tab` / `data-count` / `data-field` attribute.
- Inline handlers: `openAddLeadModal()`, `openImportModal()`, `openDupeRemoveModal()`, `openIntegrationsModal()`, `guardedOpenPowerDialer()`, `guardedOpenPreviewDialer()`, `bulkSetStatus()`, `bulkDelete()`, `clearBulkSelection()`, `toggleSelectAll()`, `selectAllPages()`.
Confirm this list back to me before making changes.

## Step 2 — Follow the pattern the other Ledger pages already use
The **Summary** and **Policy Tracker** sections were already restyled into this same Ledger system. Read how they were done and match it exactly so Leads is consistent — do not invent parallel tokens:
- Fonts: the app currently ships DM Sans / DM Mono / Sora. The Ledger look needs **Spline Sans** + **Spline Sans Mono**. Load them the same way the restyled sections do (Google Fonts `<link>`), and apply the **mono** face to money, phone numbers, quotes, dates, and timestamps.
- Theme variables: colors live in CSS variables — `:root` holds the **dark** theme, `body.light` holds the **light** theme. Reuse the existing `--ds-color-*`, `--text*`, `--border*`, `--card`, `--bg*`, `--accent`, `--sans`, `--mono` tokens rather than hard-coding hex in the Leads markup.

## Step 3 — Apply the redesign for BOTH themes
- Wire the **light** design's palette into `body.light` and the **dark** design's palette into `:root` (from the two HTML files + screenshots). Keep `toggleTheme()` working — Leads must look correct in both. Verify by toggling.
- Status pills — map my lead statuses onto the Ledger pill families, defined for both themes:
  - New → amber `#8A6116` / bg `#F6EDD8`
  - Called → gray `#5A6472` / bg `#ECEEF1`
  - No Answer → orange `#A34E0C` / bg `#FBEBDD`
  - Appointment Set → blue `#2A5599` / bg `#E7EFFB`
  - Social/Banking Objection → red `#B3261E` / bg `#FAE8E7`
  - Not Interested → gray `#5A6472` / bg `#ECEEF1` + dim the row (~55% opacity)
  - Sold → green `#1B7A43` / bg `#E4F2E9` + faint green row tint
  (Provide dark-theme equivalents consistent with the dark design.)
- Change only the markup/CSS needed for the look; keep all the Step 1 hooks intact.

## Step 4 — RESPONSIVENESS (top priority — the Summary page came out wonky at other resolutions last time; do not repeat that)
Make the Leads page fluid so it auto-fits any monitor. Concretely:
- **No fixed canvas width.** If the design uses a hard `1440px` frame, replace it with a fluid container (`width:100%`, generous/absent `max-width`, centered, padding via `clamp()`). The page must fill and adapt, not sit at a fixed size.
- **KPI cards:** `grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))` — never a hard 4-column grid.
- **Tabs, filter toolbar, and bulk-action bar:** `flex-wrap: wrap` so controls reflow instead of overflowing or clipping.
- **Lead rows / `.lead-wide-grid`:** the current `195px calc(50% - 195px) 155px 1fr` is fragile. Make the columns fluid (minmax/auto) or wrap the table in an `overflow-x:auto` container so it can never force the page wider than the viewport. Below a breakpoint, collapse to the stacked layout — and keep the existing `compact2` / `compact4` grid views working.
- **Sidebar:** it hover-expands 68px → 232px. Reserve the 68px collapsed rail and let expansion **overlay** the content (don't reflow/jump the page), matching the other Ledger pages.
- Use `clamp()` for section paddings and any oversized type. Avoid fixed pixel widths that can overflow.
- **No horizontal scrollbar on `<body>` at any width.** Add/repair media-query breakpoints and verify at **1024, 1280, 1366, 1440, 1536, 1680, 1920, and 2560 (4K)**. Layout must be relative so browser zoom / high-DPI also render cleanly.

## Step 5 — Verify end to end (don't stop early)
- If a headless browser is available (Playwright/Puppeteer), open the edited file and screenshot the Leads page in **both themes** at **1024, 1280, 1440, 1920, 2560**. Otherwise tell me exactly which widths to screenshot. Compare against my reference screenshots and fix any drift (alignment, overflow, pill colors, mono numerals).
- Confirm no JS regressions: status tabs filter, search filters, the 3 view switches, disposition dropdown writes status, bulk bar apply/delete/clear, Sold/Quote/edit/delete buttons, click-to-call, pagination, and empty state — nothing errors in the console.
- Run whatever lint/format/build the repo uses. Follow `CLAUDE.md` conventions (including any mirror rules).
- Report back: the file(s) changed, a concise diff summary, before/after screenshots for both themes, and a checklist of the widths you verified.

## Constraints
- Restyle only — preserve all functionality, IDs, classes, handlers, and data attributes from Step 1.
- Keep the change scoped to the Leads section plus the shared Ledger tokens the Summary/Policy Tracker pages already use. Don't restyle unrelated sections.
- If `app.html` and `www/app.html` are both live, keep them in sync. Ask before any destructive or repo-wide change.
