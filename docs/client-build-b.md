# Build B — Client Self-Serve Quote Wizard

**Status:** Phase 0c — frozen contracts published 2026-05-07.
**Scope:** front-end only. No EmailJS, no backend, no lead storage. Backend
wiring is its own plan (Build B-2).

This doc is the contract between Phases 0a–0c (sequential) and the three
Phase 1 agents (parallel). Phase 1 agents read this file and the four
critical references below — they do not renegotiate any of these decisions.

## Critical references

- `/Users/tanner/Jace- Life Insurance/shared/data.js` — UW_CLASS keys are
  the source of truth for the question-tree `uw_map` values.
- `/Users/tanner/Jace- Life Insurance/shared/quote-engine.js` — `quoteFE`
  is the function the wizard calls; result shape documented inline.
- `/Users/tanner/Jace- Life Insurance/shared/tokens.css` — design tokens.
- `/Users/tanner/Jace- Life Insurance/PolicyPilot_Design_System.docx` —
  canonical design system (Warm Ivory + Midnight Navy + Heritage Green,
  4px radius, no gradients, no decorative icons).

---

## Design tokens — published in `shared/tokens.css`

The token file is anchored to the canonical design system doc. Two
deliberate deltas vs. the design system, justified by the all-ages public
surface (vs the agent dashboard):

| Token | Tokens.css value | Design system value | Reason |
|---|---|---|---|
| `--fs-body` | 18px | 16px | Public surface skews older; 18px reads comfortably without zoom |
| `--hit`     | 48px | 40px (input height) | WCAG 2.5.5 mobile tap-target floor |

Everything else — palette hex codes, 4px radius, type families, 4px-base
spacing scale — comes straight from the design system. **Do not** introduce
new colors, gradients, shadows, or rounded radii larger than 4px.

---

## Question-tree schema — frozen

Phase 1 Agent B writes `shared/health-questions.json` against this schema.
The validator in `shared/uw-translator.js` rejects the file at load time if
any `uw_map` entry references an unknown `UW_CLASS` key.

```json
{
  "version": 1,
  "groups": [
    {
      "id": "heart",
      "label": "Heart and circulation",
      "questions": [
        {
          "id": "heart_event",
          "prompt": "In the last 5 years, have you had a heart attack, bypass, stent, or pacemaker?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "heart_event_when",
              "type": "choice",
              "options": [
                { "value": "lt2",  "label": "Less than 2 years ago" },
                { "value": "gte2", "label": "2 or more years ago" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:lt2":  ["Heart Attack (within 2 yrs)"],
            "yes:gte2": ["Heart Attack (2+ yrs ago)"]
          }
        }
      ]
    }
  ]
}
```

**Hard rule:** every value in every `uw_map` array MUST be an exact key
from `UW_CLASS` in `shared/data.js`. Misspellings, friendlier paraphrases,
or invented keys are silently treated as `"level"` — masking serious
underwriting flags. The translator console.errors on mismatch at load.

**Question coverage (Agent B):** 12–15 grouped yes/no questions across
heart, lung, diabetes, cancer, neuro/cognitive, liver/kidney, mental
health, mobility/build, lifestyle/tobacco, recent hospitalizations,
terminal/transplant, prescriptions. Plain language, no medical jargon
in prompts. Use language a 65-year-old reads without a dictionary.

---

## Translation rules — locked

The client card renderer (Phase 1 Agent C) maps engine results to
client-friendly language using this table. The renderer never shows
`uwClass`, `commPct`, `advComm`, `Select 1 / Level`, or carrier portal
links — those are agent-only fields.

| `result.approval` | Client-facing label       | Color token            | Icon (Phosphor regular) |
|-------------------|---------------------------|------------------------|-------------------------|
| `approved`        | Likely approved           | `--c-ok`               | `check-circle`          |
| `non_instant`     | Approved with review      | `--c-warn`             | `clock-counter-clockwise` |
| `graded`          | Approved with conditions  | `--c-warn`             | `info`                  |
| `declined`        | Not a fit right now       | `--c-text-2` (Graphite) | `circle`                |

**Why declined uses neutral grey, not red:** the design system reserves
Signal Red (`--c-bad`) for critical states like lapsed coverage. A senior
client reading "Not a fit" in red interprets it as personal failure or
rejection. Graphite communicates the fact without alarm. (Per the canonical
doc: "Use color as signal, never as decoration.")

**Always paired with icon + text** — color is never the only signal. A
color-blind user must still read the status.

---

## Submit-stub contract — Phase 2 implements verbatim

`client/wizard.js` exports an internal `submitLead(params)` function. Phase
2 ships it as the stub below. Build B-2 swaps the stub body for an EmailJS
or Supabase write — the signature, return shape, and call sites do not
change.

```js
// client/wizard.js
async function submitLead(params) {
  // STUB — replaced in Build B-2 with EmailJS / Supabase write.
  // The rest of the wizard does not care which it becomes.
  console.log('[stub] submitLead', params);
  return { ok: true };
}
```

**`params` field shape — Phase 2 builds this exactly so Build B-2 can
drop in without touching wizard logic:**

| Field | Type | Source |
|---|---|---|
| `lead_name`       | string | contact step |
| `lead_age`        | number | about-you step |
| `lead_zip`        | string | contact step (5 digits) |
| `lead_email`      | string | contact step (regex-validated) |
| `lead_phone`      | string | contact step (10 digits) |
| `coverage_amount` | number | coverage step |
| `tobacco`         | boolean | tobacco-build step |
| `monthly_low`     | number | min monthly across `eligible` results |
| `monthly_high`    | number | max monthly across `eligible` results |
| `top_carrier_1`   | string | carrierLabel of #1 by monthly asc |
| `top_carrier_2`   | string | carrierLabel of #2 |
| `top_carrier_3`   | string | carrierLabel of #3 |
| `uw_summary`      | string | `summarizeForLead(answers)` from translator |
| `submitted_at`    | string | `new Date().toISOString()` |
| `source`          | string | literal `"client.html"` |

The wizard **always** advances to the results step regardless of stub
return value — the user must see their quote even if the stubbed handoff
fails. Build B-2 will add real error handling.

---

## CSP meta tag — `client.html` (FE-only)

Phase 1 Agent A writes this verbatim into the `<head>` of `client.html`:

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com;
">
```

**No external `connect-src` needed** because there is no fetch in Build B.
Build B-2 will append:
- `https://cdn.emailjs.com` to `script-src`
- `https://api.emailjs.com` to `connect-src`

Per `Lessons Learned/Lessons Learned.md` §"CSP needs two separate EmailJS
entries" — the script and the API endpoint are different hosts and must
both be allowlisted.

---

## Phase 1 dispatch summary

| Agent | Reads | Writes | Out of scope |
|---|---|---|---|
| A | tokens.css, this doc | `client/client.css`, `client.html` skeleton, `window.WizardSlots` | wizard logic, validation, content strings |
| B | data.js (`UW_CLASS` keys), this doc, index.html 1085–1176 | `shared/health-questions.json`, `shared/uw-translator.js` | UI rendering |
| C | tokens.css, quote-engine.js result shape, this doc | `client/card-client.js` (`renderClientCard`, `renderClientCardSet`) | sorting, contact form |

Each agent emits a single contract that the next phase consumes. They do
not negotiate boundaries — that's what this doc is for.

---

## Scenario log — Phase 3b, run 2026-05-07

Each scenario was driven through the full pipeline:
`answersToConditions` → `quoteFE` → top-3 sort/filter → `submitLead(params)` stub.
Numbers below come from a node sandbox loading the live `shared/` + `client/`
files; pa11y reports zero issues at the same commit.

| # | Scenario | Inputs | Top 3 (carrier / monthly / status) | Notes |
|---|---|---|---|---|
| 1 | Happy path healthy | 40M / $15k / non-tob / no health | Transamerica $28.08 approved · Aetna $28.37 approved · Chubb $28.96 approved | Plan said 35M; wizard floor is 40 (validation locks 40–85) so scenario was run at 40. All 15 lead-params fields populated. |
| 2 | Diabetes + COPD | 65F / $10k / non-tob / `lung_condition: yes:copd_inhaler` + `diabetes: yes:t2_unctrl` | Transamerica $57.31 approved · Corebridge $61.49 approved · Aetna $66.27 approved | Translator emits `["COPD (Inhaler — no oxygen)", "Diabetes Type 2 — Uncontrolled or A1C > 8.6"]`. UW_CLASS gives Trans `select` and Core `level` for both — those carriers stay on the approved tier; AmAm/Aetna pick up `rop` so a different scenario is needed to exercise the literal "Approved with conditions" badge in isolation. |
| 3 | Active cancer | 70M / $20k / `cancer: yes:active` | Mutual $331.20 graded · Americo $335.62 graded · Chubb $348.86 graded | Trans/Core/Aetna/AmAm all `decline` for active cancer → eligible filter strips them. Three carriers writing GI products survive — the renderer correctly shows "Approved with conditions" (Burnished Gold), not the "Not a fit right now" fallback. The fallback fires only if every carrier declines. |
| 4 | Build limit fail | 60M / $10k / 68in / 320lb | Transamerica $63.03 approved · Aetna $63.60 approved · Chubb $64.75 approved | `BUILD_LIMITS[68] = [116, 279]` so 320lb fails. Engine pushes carrierWorst to `select2` for everyone, lifting monthly to the s2 tier (was ~$56 at no-build-flag). No "Build Fail — max X lbs" debug string appears in client output. |
| 5 | CC-only | 55F / $12k / non-tob / `payment: cc` | Transamerica $37.32 approved · Corebridge $40.05 approved | List filtered to the two `ccOk` carriers exactly as the plan specifies. |

A11y spot-checks: `npx pa11y http://127.0.0.1:8767/client.html` → "No issues
found" (zero serious/critical). Manual: tab-through reaches every interactive,
Enter on a numeric input on non-contact steps now advances (Phase 3a fix), and
`prefers-reduced-motion: reduce` collapses the smooth-scroll on step change.

### Open follow-ups (Build B-2 backlog)

- Replace `submitLead` body with EmailJS template send (then Supabase write per
  [[Patterns/Supabase Hybrid CRUD]]).
- Add license-state disclosure (carrier appointments per state).
- Append `https://cdn.emailjs.com` to CSP `script-src` and
  `https://api.emailjs.com` to `connect-src`. Both hosts are required —
  see `Lessons Learned/Lessons Learned.md` §"CSP needs two separate EmailJS entries".
- Decide whether the wizard's age floor (40) should be lowered for term/IUL
  product lines once those flows are added.
