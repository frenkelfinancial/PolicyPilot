# ProducerStack "Ledger" 2a — Design System

The single source of truth for the Ledger look. Three files, three jobs:

| File | What it is | Who consumes it |
|---|---|---|
| `ledger.css` | Tokens + full component library | Claude Code (drop into `app.html`), any new page |
| `ledger-design-system.html` | Live gallery — every component, both themes, fluid | You (eyeball / screenshot), Claude Code (copy exact values) |
| `LEDGER_DESIGN_SYSTEM.md` | This file — the spec + class reference | **Claude Design** (paste §1), Claude Code (read §3) |

Open `ledger-design-system.html` in a browser. Everything is exercised there: KPI cards
and strips, a 42-row paginated sortable table, all eight status pills, the inline-editable
status select, chips, segmented toggles, forms with error/disabled states, buttons, the
activity feed, a CSS bar chart, the pager, an empty state, and a live token/type/shadow
reference. The theme toggle in the topbar swaps every token.

> **Token parity is enforced.** Every `--lg-*` value in `ledger.css` is byte-identical to
> the block already shipping in `app.html` (lines ~197–230) — 39 dark + 39 light, verified.
> This file does **not** fork the palette. Tokens `ledger.css` adds on top are listed in §4.

---

## 1. Paste this into Claude Design

Everything between the rules below is the complete, self-contained brief. Replace the two
`[BRACKETED]` blocks. Attach a screenshot if you're restyling an existing page.

---

Design the **[PAGE NAME]** page for ProducerStack, a life-insurance agent CRM, in the exact
"Ledger" style specified below — the same fonts, colors, tokens, sidebar, and topbar as our
approved Summary and Policy Tracker pages. One direction only.

Context: agents live in this tool 6+ hours a day tracking policies, commissions,
chargebacks, and leads across multiple carriers (Americo, Mutual of Omaha, Transamerica,
Corebridge, American-Amicable, Ethos). It's an operational workhorse, not a marketing page.
Data density matters more than visual delight. Reference points: Attio, Linear, Ramp,
Retool — left-aligned, tight vertical rhythm, 13px body text, tables that look like real
tables with visible row separators. Think a bank's internal tooling, not a startup landing
page.

### Page requirements

[PAGE-SPECIFIC REQUIREMENTS — list every feature, control, column, stat, and interaction
the page needs. If restyling an existing page: "This is a feature-for-feature restyle of
the attached screenshot: every element, control, and column must exist in the redesign. The
DATA is placeholder — all values are dynamic per agent at runtime, so use realistic fake
data, don't copy the screenshot's numbers. Layout spacing may flex; the information shown
may not." Show any hidden states (dropdowns, modals, expanded rows) OPEN on one example so
they get designed.]

### Use the established Ledger component library

Build from these existing patterns — do not invent new component styles:

- **KPI card**: white card, label UPPERCASE 10.5–11px `#948C7F`, value 22px/600 Spline Sans
  Mono, optional caption 11px, padding 13px 16px. Strips extend the grid to however many
  stats the page needs.
- **Data table**: header 34px on `#FAF8F5`, UPPERCASE muted column labels, rows 38px,
  visible `#F0EDE7` dividers, hover `#FAF8F5`, money/dates/IDs in mono. Paginate at 15 rows
  with page chips. Tables sit in their own overflow-x wrapper.
- **Status pills**: 11px/600, padding 2px 8px, radius 6px, per the palette below.
  Inline-editable statuses render as a select styled as the pill with a chevron.
- **Filter chips & toggles**: white bg, `#E4E0DA` border, 12.5px/500; active = border
  `#B8CCEE`, text `#3A73C9`. Used for view toggles and period switches (Daily / Weekly /
  Monthly where relevant).
- **Form controls**: inputs/selects white bg, `#E4E0DA` border, 6px radius, labeled with
  UPPERCASE muted labels.
- **Primary button**: `#3A73C9` → hover `#2A5599`, white, 12.5px/600, padding 7px 12px.
- **Feed rows** (activity/timelines): 9px 0 padding, `#F0EDE7` divider, 8px status dot,
  title 12.5/500, meta 11.5 `#948C7F`, amount 12/600 mono, time 10.5 `#B0A99C`.
- **Charts**: bars `#5B94E8` (current/active `#3A73C9`), radius 3px 3px 0 0, axis labels
  10px mono `#948C7F`. Neutral grays for secondary series — never a rainbow.
- **Icons**: inline SVG only, 18×18, stroke 1.5, currentColor.
- **Topbar**: white, 50px, page name left (15px/600), date right in mono, theme toggle,
  avatar 26×26 `#0F1D3D`.

### Responsive requirement

Build the layout fluid, not fixed. No max-width cap and no fixed pixel widths on containers
— content stretches to fill the full space beside the sidebar at every resolution (this
matches the live app, which removed the 1440px cap). Grids use `fr` /
`repeat(auto-fit, minmax(...))` so cards widen and extra columns form on big screens. Tables
get their own overflow-x wrapper. Tokens (fonts, paddings, radii, colors) stay constant at
every width. Must look right at 1280, 1440, 1920, 2560.

### Hard constraints — never do any of these

- Blue is an accent only (links, active states, focus rings, one chart series, primary
  button) — never a background, never a gradient, never >~5% of the screen
- No purple/blue gradients, no glassmorphism, no backdrop-blur
- No emoji as icons — SVG only, single stroke weight
- Single 6px radius across the whole system
- No large rounded pill buttons, no floating action bubbles
- No centered hero sections, no 3-column icon-title-body feature grids
- Layered subtle shadows only (per spec), never a generic drop shadow
- Two typefaces only: Spline Sans + Spline Sans Mono — never Inter

### STYLE SPEC — ProducerStack "Ledger" (2a)

**Fonts**

- UI: `'Spline Sans'` (400/500/600), Google Fonts
- Money / policy #s / dates / timestamps: `'Spline Sans Mono'` (400–600)
- Sizes: 10.5, 11, 11.5, 12, 12.5, 13, 15, 18, 22px · line-height 1.45
- Body & table cells 13px · KPI value 22px/600 mono · page title 15px/600
- Section titles 13px/600 · labels/column headers 10.5–11px UPPERCASE, letter-spacing
  .06–.08em, weight 600, color `#948C7F`

**Colors**

- Page canvas `#F5F3F0` (warm gray) · cards `#FFFFFF`
- Table header + row hover `#FAF8F5`
- Borders: frame `#D8D3CA` · cards/controls `#E4E0DA` · row dividers `#F0EDE7`
- Text: primary `#0F1D3D` · secondary `#3B372F` · muted mono `#6B6459` · captions `#948C7F`
  · faint `#B0A99C`
- Blue (accent only): mark/badges `#5B94E8` · interactive `#3A73C9` · hover `#2A5599`
- Green `#1B7A43` · red `#B3261E` (negative amounts too)

**Status pills** (11px/600, padding 2px 8px, radius 6px)

- Active/Paid: `#1B7A43` on `#E4F2E9` · Pending: `#8A6116` on `#F6EDD8`
- Sub/Approved / Issued–Not Paid: `#2A5599` on `#E7EFFB` · Lapsed: `#A34E0C` on `#FBEBDD`
- Charge Back: `#B3261E` on `#FAE8E7` · Declined: `#5A6472` on `#ECEEF1`
- Dots (feed): `#2E9E5B`, `#C9971F`, `#5B94E8`, `#D97B2A`, `#D2483F`, `#98A1AE`
- Chargeback row highlight bg: `#FCF1F0`

**Sidebar rail** (cool-tinted, hover-expand)

- 68px collapsed → 232px on hover · transition width .18s ease
- bg `#EEF2FB` · border-right 1px solid `#DFE6F3` · padding 12px 10px
- Items 36px tall, radius 6px, 3px gap · 18×18 icons, stroke 1.5, currentColor
- Idle `#4C5568` · active: bg `#DCE7F8`, icon `#3A73C9`, label `#0F1D3D`/600
- Labels 13px/500, hidden collapsed · dividers `#DFE6F3` · Sign out `#8A93A6`
- Nav: Summary, Quote + Underwriting, Policy Tracker, Carrier Mail, Bonus Tracker, Leads,
  Calendar, Phone Book, Web Dialer, Agency · footer: Support, Settings, Sign out

**Space / radius / shadow**

- Spacing scale 4 · 8 · 12 · 16 · 24 · 32
- Radius: 6px everywhere (single radius)
- Shadow sm: `0 1px 2px rgba(15,29,61,.05)`
- Shadow md: sm + `0 4px 12px rgba(15,29,61,.05)`
- Frame: `0 1px 2px rgba(15,29,61,.06), 0 8px 24px rgba(15,29,61,.06)`

**Layout**

- Fluid full-width content beside the sidebar (no max-width cap) · topbar 50px white,
  border-bottom `#E4E0DA`, padding 0 24px
- Avatar 26×26, bg `#0F1D3D`, radius 6 · content padding 20px 24px, gaps 16px
- KPI: auto-fit grid, gap 14px, card padding 13px 16px
- Table: header 34px on `#FAF8F5` · rows 38px, padding 0 16px, col-gap 12px, hover `#FAF8F5`
- Filter chips: padding 6px 10px, 12.5px/500, white bg, `#E4E0DA` border; active chip border
  `#B8CCEE` + text `#3A73C9`
- Primary button: `#3A73C9` → hover `#2A5599`, white, 12.5px/600, padding 7px 12px
- Chart bars `#5B94E8` (current `#3A73C9`), radius 3px 3px 0 0, axis labels 10px mono
  `#948C7F`
- Feed rows: 9px 0 padding, divider `#F0EDE7`, 8px dot, title 12.5/500, meta 11.5 `#948C7F`,
  amount 12/600 mono, time 10.5 `#B0A99C`

---

## 2. Theme model

`ledger.css` mirrors `app.html` exactly:

```css
:root      { /* DARK — the default theme */ }
body.light { /* LIGHT — the hexes quoted in the spec above */ }
```

The spec in §1 quotes the **light** values because that's what Claude Design should draw.
Every component rule references tokens only — there are no theme literals below the token
block, so a page built on these classes is theme-aware for free.

Put `class="ledger"` on the app shell (or `<body>`). Add `light` alongside it for the light
theme. The gallery ships as `<body class="light ledger">`.

## 3. Class reference

Scope prefix `.ledger`, component prefix `lg-`. Everything is namespaced so it can coexist
with the legacy `app.html` CSS.

### Shell

```html
<div class="lg-app">
  <div class="lg-railwrap"><nav class="lg-rail">…</nav></div>
  <div class="lg-main">
    <header class="lg-topbar">…</header>
    <main class="lg-content">…</main>
  </div>
</div>
```

`.lg-railwrap` is the 68px spacer; `.lg-rail` is `position:fixed` and expands to 232px on
hover/focus-within so it overlays content instead of shoving the layout.

| Class | Notes |
|---|---|
| `.lg-rail-brand` `.lg-rail-mark` `.lg-rail-name` | Brand row; name fades in on expand |
| `.lg-nav` `.lg-nav-item` `.lg-nav-item.active` | 36px items, 3px gap, 18×18 icon + `<span>` label |
| `.lg-rail-div` `.lg-rail-foot` `.lg-signout` | Divider, bottom-pinned group, muted sign-out |
| `.lg-topbar-title` `.lg-topbar-spacer` `.lg-topbar-date` | 15px/600 · flex spacer · mono date |
| `.lg-iconbtn` `.lg-avatar` | 28px icon button · 26×26 `#0F1D3D` initials |
| `.lg-content` | `padding:20px 24px`, `gap:16px`, fluid |

### Layout grids

| Class | Behavior |
|---|---|
| `.lg-grid.lg-grid--2` | `auto-fit, minmax(320px, 1fr)` |
| `.lg-grid.lg-grid--3` | `auto-fit, minmax(260px, 1fr)` |
| `.lg-grid.lg-grid--split` | `2fr / 1fr`, stacks under 1100px |

No container has a `max-width`. Extra columns form on their own at 1920/2560.

### KPI

```html
<div class="lg-kpis">
  <div class="lg-kpi">
    <div class="lg-kpi-l">Submitted AP</div>
    <div class="lg-kpi-v">$48,320</div>
    <div class="lg-kpi-c"><span class="lg-delta lg-pos">+12.4%</span> vs. last month</div>
  </div>
</div>
```

`.lg-kpis` = auto-fit `minmax(168px, 1fr)`, gap 14px. `.lg-kpistrip` is the same grid as one
bordered card with `#F0EDE7` dividers between cells. Add `.lg-pos` / `.lg-neg` to `.lg-kpi-v`.

### Table

```html
<div class="lg-tablewrap">
  <table class="lg-table">
    <thead><tr><th class="lg-th-sort" data-k="client" aria-sort="none">Client …</th></tr></thead>
    <tbody><tr><td class="lg-cell-primary">…</td><td class="lg-num">$18,000</td></tr></tbody>
  </table>
</div>
```

| Class | Notes |
|---|---|
| `.lg-tablewrap` | **Required.** `overflow-x:auto` — the page never scrolls sideways |
| `thead th` | 34px, `--lg-inner`, UPPERCASE 10.5/600 (not sticky — see note below) |
| `.lg-th-sort` | Hover → blue; caret shows when `aria-sort` ≠ `none`, flips on `descending` |
| `tbody td` | 38px, `--lg-divider` bottom, 16px outer gutter / 12px between columns |
| `.lg-cell-primary` | The name column — `--lg-text1`, 500 |
| `.lg-mono` `.lg-num` | Mono + tabular figures; `.lg-num` also right-aligns |
| `.lg-row--cb` `.lg-row--sold` `.lg-row--sel` | Chargeback wash, sold wash, selected |
| `.lg-cellactions` `.lg-rowbtn--edit` `.lg-rowbtn--del` | 26px row actions, tinted on hover |
| `.lg-check` | 15px checkbox, `accent-color:var(--lg-blue)` |

Paginate at 15 rows using `.lg-pager` / `.lg-pginfo` / `.lg-pgchip` / `.lg-pgbtn`.

> **Don't add `position:sticky` to `thead th`.** `.lg-tablewrap` is a scroll container
> (`overflow-x:auto` also computes `overflow-y` to `auto`), so a sticky header sticks to the
> wrapper rather than the viewport and never actually moves — the same class of bug as
> `.sec-shell{overflow:hidden}` silently killing sticky. With 15-row pages it buys nothing.

### Status pills

`.lg-pill` + one of `--active` `--paid` `--pending` `--approved` `--sub` `--issued`
`--lapsed` `--chargeback` `--declined`.

Inline-editable — the wrapper carries the pill colors, the `<select>` is transparent:

```html
<span class="lg-pillsel lg-pill--approved">
  <select><option>Pending</option><option selected>Approved</option>…</select>
</span>
```

> The chevron on `.lg-pillsel` is a CSS **mask** driven by `currentColor`, not a hex baked
> into an SVG data-URI. `app.html`'s `.pt-status--*` rules hardcode the light stroke color
> inside the data-URI, so those carets are near-invisible in dark mode — use the mask
> approach for anything new. (`.lg-select` still needs a background-image, so it gets a
> per-theme `--lg-caret-img`.)

### Chips, toggles, buttons

| Class | Notes |
|---|---|
| `.lg-chips` `.lg-chip` `.lg-chip.active` | 6px 10px, 12.5/500; active = blue border + blue text |
| `.lg-badge` `.lg-badge--blue` | Count badge inside a chip or heading |
| `.lg-seg > button` | Segmented Daily / Weekly / Monthly; active cell gets `--lg-blue-soft` |
| `.lg-toolbar` `.lg-toolbar-spacer` | Wrapping flex row for filter bars |
| `.lg-btn--primary` `--ghost` `--danger` | 7px 12px, 12.5/600 |

### Forms

`.lg-field` › `.lg-label` (UPPERCASE muted) + `.lg-input` / `.lg-select` / `.lg-textarea`
(32px, `--lg-border`, 6px). `.lg-searchwrap` positions an 18×18 icon inside the input.
`.lg-formgrid` is auto-fit `minmax(200px, 1fr)`. States: `.lg-invalid`, `:disabled`,
`.lg-help`, `.lg-error`.

### Feed

```html
<div class="lg-feed">
  <div class="lg-feed-row">
    <span class="lg-dot lg-dot--green"></span>
    <div class="lg-feed-main">
      <div class="lg-feed-title">…</div><div class="lg-feed-meta">…</div>
    </div>
    <span class="lg-feed-amt lg-pos">+$614</span>
    <span class="lg-feed-time">2m</span>
  </div>
</div>
```

Dots: `--green --amber --blue --orange --red --gray`.

### Charts

```html
<div class="lg-chart">
  <div class="lg-bars">
    <div class="lg-barcol"><div class="lg-bar" style="--h:64%"></div></div>
    <div class="lg-barcol"><div class="lg-bar lg-bar--current" style="--h:94%"></div></div>
  </div>
  <div class="lg-axis"><div>Jun</div><div>Jul</div></div>
</div>
```

Height is the `--h` custom property. `.lg-bar--muted` is the neutral-gray secondary series —
one blue series only, never a rainbow. `.lg-meter > span[style="--v:76%"]` is the horizontal
progress variant. `.lg-chart-legend` + `.lg-legend-swatch` for the key.

### Misc

`.lg-card` `.lg-card--frame` `.lg-card-head` `.lg-card-title` `.lg-card-sub`
`.lg-card-actions` `.lg-card-body` `.lg-section-title` `.lg-empty` · utilities `.lg-mono`
`.lg-num` `.lg-pos` `.lg-neg` `.lg-muted` `.lg-faint` `.lg-caps` `.lg-strong`.

## 4. Tokens `ledger.css` adds on top of `app.html`

These have no `--lg-*` equivalent in `app.html` yet. Values in the spec were light-only, so
the dark values are derived to match the existing dark ramp. **If you adopt `ledger.css` in
`app.html`, add these to both the `:root` and `body.light` blocks there.**

| Token group | Tokens |
|---|---|
| Sidebar rail | `--lg-rail-bg` `--lg-rail-border` `--lg-rail-idle` `--lg-rail-hover-bg` `--lg-rail-active-bg` `--lg-rail-signout` |
| Chargeback row | `--lg-cb-row` (light `#FCF1F0` — the spec's row wash, distinct from `--lg-red-soft` `#FAE8E7`) |
| Feed dots | `--lg-dot-green` `--lg-dot-amber` `--lg-dot-blue` `--lg-dot-orange` `--lg-dot-red` `--lg-dot-gray` |
| Charts | `--lg-bar` `--lg-bar-current` `--lg-bar-muted` `--lg-bar-track` |
| Elevation / focus | `--lg-sh-sm` `--lg-sh-md` `--lg-sh-frame` `--lg-focus` |
| Type / space scale | `--lg-sans` `--lg-mono` `--lg-fs-*` `--lg-lh` `--lg-ls-caps` `--lg-sp-1…6` `--lg-r` `--lg-r-bar` |
| Fixed metrics | `--lg-topbar-h` `--lg-rail-w` `--lg-rail-w-open` `--lg-row-h` `--lg-thead-h` `--lg-nav-h` `--lg-avatar` `--lg-icon` |
| Caret | `--lg-caret` (mask) `--lg-caret-img` (per-theme select background) |

Shadows are theme-split on purpose: the spec's `rgba(15,29,61,.05)` is invisible on a
`#0E0E0F` canvas, so dark uses `rgba(0,0,0,.40)` at the same geometry.

## 5. Verified

`ledger.css` + `ledger-design-system.html` pass an automated audit:

- CSS comments and braces balanced; all 82 referenced `--lg-*` tokens defined (91 total)
- Theme parity — 60 light overrides, no color token dark-only
- **Token values byte-identical to `app.html`** — 39 dark + 39 light compared, zero drift
- No gradients · no `backdrop-filter`/`blur` · no `Inter` · no emoji in markup
- Radius audit clean across 25 declarations — single 6px system + 3px chart-bar tops only
- Single icon stroke weight (1.5; the 1.6 chevron glyph is a mask, not an icon)
- No px `max-width` cap on any container (`@media` conditions excluded)
- All 116 `lg-*` classes used in markup resolve to a CSS rule, including the 7 status keys
  the table builds at runtime
- Inline gallery script parses under `node --check`

## 6. Companion — Claude Code implementation prompt

After Claude Design returns a page, save it to `docs/design-reference/<Name>.html`, then:

> Read `CLAUDE.md` and `docs/design-reference/LEDGER_DESIGN_SYSTEM.md` first. Restyle the
> existing [PAGE NAME] section in `app.html` to match the approved Ledger design at
> `docs/design-reference/<Name>.html` — read it in full first and copy its CSS values
> verbatim. Build on `docs/design-reference/ledger.css`: reuse its `--lg-*` tokens and
> `lg-*` classes rather than writing new rules, and add any §4 tokens that `app.html` is
> still missing to **both** the `:root` and `body.light` blocks. No duplicate or conflicting
> rules. This is a reskin: every existing behavior keeps working, rewired onto the new
> markup. Preserve the fluid layout (no max-width caps). No email-parsing content. No
> changes to `CARRIER_BONUSES` or `COMP`. Verify with `node --check` plus a jsdom harness
> covering every interactive element, run a token audit (Ledger tokens only, 6px radius, no
> gradients), confirm other sections are untouched in the diff, then `npm run check` and
> `npm run prebuild` to sync `www/`, and report the diff with any judgment calls.
