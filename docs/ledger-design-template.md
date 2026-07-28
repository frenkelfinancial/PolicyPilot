# ProducerStack "Ledger" — Claude Design Template

Reusable prompt for designing ANY new ProducerStack page in the approved Ledger style.

How to use:
1. Copy everything below the divider into Claude Design.
2. Replace the two [BRACKETED] blocks with your page name and its features/content.
3. Attach a screenshot of the existing page if you're restyling one (recommended).
4. When done, download as **standalone HTML** into `docs/design-reference/` and hand it
   to Claude Code with the standard implementation instructions.

---

Design the **[PAGE NAME]** page for ProducerStack, a life-insurance agent CRM, in the
exact "Ledger" style specified below — the same fonts, colors, tokens, sidebar, and
topbar as our approved Summary and Policy Tracker pages. One direction only.

Context: agents live in this tool 6+ hours a day tracking policies, commissions,
chargebacks, and leads across multiple carriers (Americo, Mutual of Omaha,
Transamerica, Corebridge, American-Amicable, Ethos). It's an operational workhorse,
not a marketing page. Data density matters more than visual delight. Reference
points: Attio, Linear, Ramp, Retool — left-aligned, tight vertical rhythm, 13px body
text, tables that look like real tables with visible row separators. Think a bank's
internal tooling, not a startup landing page.

## Page requirements

[PAGE-SPECIFIC REQUIREMENTS — list every feature, control, column, stat, and
interaction the page needs. If restyling an existing page: "This is a
feature-for-feature restyle of the attached screenshot: every element, control, and
column must exist in the redesign. The DATA is placeholder — all values are dynamic
per agent at runtime, so use realistic fake data, don't copy the screenshot's
numbers. Layout spacing may flex; the information shown may not." Show any hidden
states (dropdowns, modals, expanded rows) OPEN on one example so they get designed.]

## Use the established Ledger component library

Build from these existing patterns — do not invent new component styles:

- **KPI card**: white card, label UPPERCASE 10.5–11px #948C7F, value 22px/600
  Spline Sans Mono, optional caption 11px, padding 13px 16px. Strips extend the
  grid to however many stats the page needs.
- **Data table**: header 34px on #FAF8F5, UPPERCASE muted column labels, rows 38px,
  visible #F0EDE7 dividers, hover #FAF8F5, money/dates/IDs in mono. Paginate at 15
  rows with page chips. Tables sit in their own overflow-x wrapper.
- **Status pills**: 11px/600, padding 2px 8px, radius 6px, per the palette below.
  Inline-editable statuses render as a select styled as the pill with a chevron.
- **Filter chips & toggles**: white bg, #E4E0DA border, 12.5px/500; active = border
  #B8CCEE, text #3A73C9. Used for view toggles and period switches (Daily / Weekly /
  Monthly where relevant).
- **Form controls**: inputs/selects white bg, #E4E0DA border, 6px radius, labeled
  with UPPERCASE muted labels.
- **Primary button**: #3A73C9 → hover #2A5599, white, 12.5px/600, padding 7px 12px.
- **Feed rows** (activity/timelines): 9px 0 padding, #F0EDE7 divider, 8px status
  dot, title 12.5/500, meta 11.5 #948C7F, amount 12/600 mono, time 10.5 #B0A99C.
- **Charts**: bars #5B94E8 (current/active #3A73C9), radius 3px 3px 0 0, axis labels
  10px mono #948C7F. Neutral grays for secondary series — never a rainbow.
- **Icons**: inline SVG only, 18×18, stroke 1.5, currentColor.
- **Topbar**: white, 50px, page name left (15px/600), date right in mono, theme
  toggle, avatar 26×26 #0F1D3D.

## Responsive requirement

Build the layout fluid, not fixed. No max-width cap and no fixed pixel widths on
containers — content stretches to fill the full space beside the sidebar at every
resolution (this matches the live app, which removed the 1440px cap). Grids use
fr / repeat(auto-fit, minmax(...)) so cards widen and extra columns form on big
screens. Tables get their own overflow-x wrapper. Tokens (fonts, paddings, radii,
colors) stay constant at every width. Must look right at 1280, 1440, 1920, 2560.

## Hard constraints — never do any of these

- Blue is an accent only (links, active states, focus rings, one chart series,
  primary button) — never a background, never a gradient, never >~5% of the screen
- No purple/blue gradients, no glassmorphism, no backdrop-blur
- No emoji as icons — SVG only, single stroke weight
- Single 6px radius across the whole system
- No large rounded pill buttons, no floating action bubbles
- No centered hero sections, no 3-column icon-title-body feature grids
- Layered subtle shadows only (per spec), never a generic drop shadow
- Two typefaces only: Spline Sans + Spline Sans Mono — never Inter

## STYLE SPEC — ProducerStack "Ledger" (2a)

### Fonts

- UI: 'Spline Sans' (400/500/600), Google Fonts
- Money / policy #s / dates / timestamps: 'Spline Sans Mono' (400–600)
- Sizes: 10.5, 11, 11.5, 12, 12.5, 13, 15, 18, 22px · line-height 1.45
- Body & table cells 13px · KPI value 22px/600 mono · page title 15px/600
- Section titles 13px/600 · labels/column headers 10.5–11px UPPERCASE,
  letter-spacing .06–.08em, weight 600, color #948C7F

### Colors

- Page canvas #F5F3F0 (warm gray) · cards #FFFFFF
- Table header + row hover #FAF8F5
- Borders: frame #D8D3CA · cards/controls #E4E0DA · row dividers #F0EDE7
- Text: primary #0F1D3D · secondary #3B372F · muted mono #6B6459 · captions #948C7F
  · faint #B0A99C
- Blue (accent only): mark/badges #5B94E8 · interactive #3A73C9 · hover #2A5599
- Green #1B7A43 · red #B3261E (negative amounts too)

### Status pills (11px/600, padding 2px 8px, radius 6px)

- Active/Paid: #1B7A43 on #E4F2E9 · Pending: #8A6116 on #F6EDD8
- Sub/Approved / Issued–Not Paid: #2A5599 on #E7EFFB · Lapsed: #A34E0C on #FBEBDD
- Charge Back: #B3261E on #FAE8E7 · Declined: #5A6472 on #ECEEF1
- Dots (feed): #2E9E5B, #C9971F, #5B94E8, #D97B2A, #D2483F, #98A1AE
- Chargeback row highlight bg: #FCF1F0

### Sidebar rail (cool-tinted, hover-expand)

- 68px collapsed → 232px on hover · transition width .18s ease
- bg #EEF2FB · border-right 1px solid #DFE6F3 · padding 12px 10px
- Items 36px tall, radius 6px, 3px gap · 18×18 icons, stroke 1.5, currentColor
- Idle #4C5568 · active: bg #DCE7F8, icon #3A73C9, label #0F1D3D/600
- Labels 13px/500, hidden collapsed · dividers #DFE6F3 · Sign out #8A93A6
- Nav: Summary, Quote + Underwriting, Policy Tracker, Carrier Mail, Bonus Tracker,
  Leads, Calendar, Phone Book, Web Dialer, Agency · footer: Support, Settings,
  Sign out

### Space / radius / shadow

- Spacing scale 4 · 8 · 12 · 16 · 24 · 32
- Radius: 6px everywhere (single radius)
- Shadow sm: 0 1px 2px rgba(15,29,61,.05)
- Shadow md: sm + 0 4px 12px rgba(15,29,61,.05)
- Frame: 0 1px 2px rgba(15,29,61,.06), 0 8px 24px rgba(15,29,61,.06)

### Layout

- Fluid full-width content beside the sidebar (no max-width cap) · topbar 50px
  white, border-bottom #E4E0DA, padding 0 24px
- Avatar 26×26, bg #0F1D3D, radius 6 · content padding 20px 24px, gaps 16px
- KPI: auto-fit grid, gap 14px, card padding 13px 16px
- Table: header 34px on #FAF8F5 · rows 38px, padding 0 16px, col-gap 12px,
  hover #FAF8F5
- Filter chips: padding 6px 10px, 12.5px/500, white bg, #E4E0DA border; active chip
  border #B8CCEE + text #3A73C9
- Primary button: #3A73C9 → hover #2A5599, white, 12.5px/600, padding 7px 12px
- Chart bars #5B94E8 (current #3A73C9), radius 3px 3px 0 0, axis labels 10px mono
  #948C7F
- Feed rows: 9px 0 padding, divider #F0EDE7, 8px dot, title 12.5/500, meta 11.5
  #948C7F, amount 12/600 mono, time 10.5 #B0A99C

---

## Companion: standard Claude Code implementation prompt

After downloading the design, save it to `docs/design-reference/<Name>.html` (plus
screenshots), then give Claude Code:

> Read CLAUDE.md first. Restyle the existing [PAGE NAME] section in app.html to
> match the approved Ledger design at docs/design-reference/<Name>.html — read it in
> full first and copy its CSS values verbatim. Reuse/extend the existing .ledger
> stylesheet and tokens; no duplicate or conflicting rules. This is a reskin: every
> existing behavior keeps working, rewired onto the new markup. Preserve the
> reference's fluid layout (no max-width caps — same approach as Summary/Tracker).
> No email-parsing content. No changes to CARRIER_BONUSES or COMP. Verify with
> node --check plus a jsdom harness covering every interactive element, run a token
> audit (Ledger hexes only, 6px radius, no gradients), confirm other sections are
> untouched in the diff, then commit, merge to main, push, and show the push output
> with any judgment calls.
