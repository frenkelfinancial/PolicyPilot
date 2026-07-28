# Claude Design prompt — Leads page in ProducerStack "Ledger" (2a) style

> Paste everything below the line into Claude. It restyles the **Leads** page to be
> visually identical to the Summary and Policy Tracker "Ledger" designs.

---

Design the **Leads page** for ProducerStack — the screen where an insurance agent views and works their leads. It must be **visually identical in style** to my existing "Ledger" (2a) Summary and Policy Tracker screens: same fonts, colors, sidebar rail, topbar, spacing, radii, shadows, status pills, KPI cards, and table treatment. This is a single self-contained HTML mockup (1440px canvas) with realistic sample data — match the system exactly, don't invent new visual conventions.

## Exact style system to follow (do not deviate)

**Fonts**
- UI: `'Spline Sans'` (400/500/600), from Google Fonts.
- Money / phone numbers / policy #s / dates / timestamps: `'Spline Sans Mono'` (400–600).
- Sizes: 10.5, 11, 11.5, 12, 12.5, 13, 15, 18, 22px · line-height 1.45.
- Body & table cells 13px · KPI value 22px/600 mono · page title 15px/600 · section titles 13px/600 · labels & column headers 10.5–11px UPPERCASE, letter-spacing .06–.08em, weight 600, color `#948C7F`.

**Colors**
- Page canvas `#F5F3F0` (warm gray) · cards `#FFFFFF`.
- Table header + row hover `#FAF8F5`.
- Borders: frame `#D8D3CA` · cards/controls `#E4E0DA` · row dividers `#F0EDE7`.
- Text: primary `#0F1D3D` · secondary `#3B372F` · muted mono `#6B6459` · captions `#948C7F` · faint `#B0A99C`.
- Blue (accent only): mark/badges `#5B94E8` · interactive `#3A73C9` · hover `#2A5599`.
- Green `#1B7A43` · red `#B3261E` (negative amounts too).

**Status pills** (11px/600, padding 2px 8px, radius 6px) — use my lead statuses, mapped onto the same six pill families:
- **New** → amber: `#8A6116` on `#F6EDD8`
- **Called** → gray: `#5A6472` on `#ECEEF1`
- **No Answer** → orange: `#A34E0C` on `#FBEBDD`
- **Appointment Set** → blue: `#2A5599` on `#E7EFFB`
- **Objection** (Social / Banking) → red: `#B3261E` on `#FAE8E7`
- **Not Interested** → gray: `#5A6472` on `#ECEEF1`, and set the whole row to ~55% opacity
- **Sold** → green pill `#1B7A43` on `#E4F2E9`, and tint the whole row background a faint green (mirror the chargeback-row-highlight pattern, but positive)

Feed / activity dots (if used): `#2E9E5B`, `#C9971F`, `#5B94E8`, `#D97B2A`, `#D2483F`, `#98A1AE`.

**Sidebar rail** (cool-tinted, hover-expand)
- 68px collapsed → 232px on hover · `transition: width .18s ease`.
- bg `#EEF2FB` · border-right 1px solid `#DFE6F3` · padding 12px 10px.
- Items 36px tall, radius 6px, 3px gap · 18×18 icons, stroke 1.5, currentColor.
- Idle `#4C5568` · active: bg `#DCE7F8`, icon `#3A73C9`, label `#0F1D3D`/600.
- Labels 13px/500, hidden when collapsed · dividers `#DFE6F3` · Sign out `#8A93A6`.
- Nav order: Summary, Quote + Underwriting, Policy Tracker, Carrier Mail, Bonus Tracker, **Leads (active on this screen)**, Calendar, Phone Book, Web Dialer, Agency · footer: Support, Settings, Sign out.

**Space / radius / shadow**
- Spacing scale 4 · 8 · 12 · 16 · 24 · 32.
- Radius: 6px everywhere (single radius).
- Shadow sm: `0 1px 2px rgba(15,29,61,.05)`.
- Shadow md: sm + `0 4px 12px rgba(15,29,61,.05)`.
- Frame: `0 1px 2px rgba(15,29,61,.06), 0 8px 24px rgba(15,29,61,.06)`.

**Layout**
- Canvas 1440px · topbar 50px white, border-bottom `#E4E0DA`, padding 0 24px · avatar 26×26, bg `#0F1D3D`, radius 6.
- Content padding 20px 24px, gaps 16px.
- KPI: 4-col grid, gap 14px, card padding 13px 16px.
- Table: header 34px on `#FAF8F5` · rows 38px, padding 0 16px, col-gap 12px, hover `#FAF8F5`, dividers `#F0EDE7`.
- Filter chips / tabs: padding 6px 10px, 12.5px/500, white bg, `#E4E0DA` border; active chip border `#B8CCEE` + text `#3A73C9`.
- Primary button: `#3A73C9` → hover `#2A5599`, white, 12.5px/600, padding 7px 12px.
- Chart bars `#5B94E8` (current `#3A73C9`), radius 3px 3px 0 0, axis labels 10px mono `#948C7F`.

## Page content & structure (Leads-specific)

**Topbar** — page title "Leads" (15px/600), a right-aligned agent avatar, and primary actions: `+ Add Lead`, `+ Import Leads` (primary button), plus `Power Dial` and `Preview Dial` buttons.

**KPI strip** — 4 cards, mono values (22px/600): **Total Leads**, **New This Week**, **Appointments Set**, **Sold / Conversion %**. Small caption label above each in the 10.5–11px uppercase caption style. Optionally a tiny trend delta in green/red.

**Status tabs** (chip row, matching filter-chip style) with live counts: `All`, `New`, `No Answer`, `Appointment Set`, `Objections`, `Not Interested`. Active tab uses the active-chip treatment (`#B8CCEE` border, `#3A73C9` text).

**Filter toolbar** (one white card, padding 16px 20px): a search input (`Search name, phone, email…`, magnifier icon, 36px tall, `#E4E0DA` border, radius 6), then dropdowns for **All Statuses**, **All Sources**, **All States**, a right-aligned standard/2-col/4-col view switcher, a per-page selector, and a lead-count readout (`128 leads`).

**Leads table** — render leads as a dense **Ledger table** matching the Policy Tracker (34px header row on `#FAF8F5`, 38px body rows, `#F0EDE7` dividers, hover `#FAF8F5`). Columns:
1. select checkbox (18×18, radius 6, `#E4E0DA` border)
2. **Name** (13px, primary `#0F1D3D`, 500)
3. **Phone** (mono, interactive blue `#3A73C9`, click-to-call)
4. **State** (mono, muted)
5. **Source** (plain)
6. **Status** (pill per mapping above)
7. **Quote** (mono `$`; show faint `Not set` in `#B0A99C` when empty)
8. **Last Contact** (mono date `#6B6459`)
9. **Actions** (compact icon buttons: dial, edit, delete; a green `Sold` pill-button; a `Quote` button)

Include an **expanded-row** treatment for the focused lead that reveals a notes textarea (`#E4E0DA` border, radius 6, `#FAF8F5` inner bg), a prominent **CLICK TO CALL** button (primary blue), a **disposition** dropdown, and any custom fields laid out as label/value pairs (labels in the 10.5px uppercase caption style, mono values). This is the one card-like moment — keep it inside the Ledger frame.

**Bulk-action bar** — appears above the table when rows are selected: `N selected`, a `Set status` dropdown + `Apply` button, `Power Dial` / `Preview Dial`, `Delete Selected` (red), and `Clear Selection`. Keep it in the same card/border language.

**Pagination** — Prev / Page N / Next in the muted caption style, top and bottom.

**Empty state** — a centered users icon, `No leads yet.` with an interactive-blue `Import leads from CSV or Excel.` link.

## Output requirements
- Single self-contained HTML file, inline CSS, Google Fonts `<link>` for Spline Sans + Spline Sans Mono.
- Populate with ~10–14 realistic sample leads spanning every status so all pills, the Sold green-tint row, and the dimmed Not-Interested row are visible.
- Light theme only, 1440px canvas, pixel-consistent with the Summary / Policy Tracker Ledger screens.
- No localStorage/sessionStorage. Static mockup is fine (no backend), but the sidebar hover-expand and row hover states should work.
