# Underwriting Copilot — continuous chat in the Quote + Underwriting tab

**Date:** 2026-06-17
**Branch:** `feature/uw-copilot-chat` (off `feature/phone-book-tab`)
**Status:** Design approved (free reign granted by user) → implementing

## Goal

Turn the single "Health conditions & medications" textarea in the **Quote +
Underwriting** tab (`#sec-api-quoter`) into a **continuous chat** — an
"Underwriting Copilot." The agent describes the client's health/meds
conversationally; the bot replies, asks follow-ups, and on every turn extracts
the canonical condition list. The quoter "reads off" the chat: those conditions
drive the existing per-carrier approval badges **and** a new "Best for approval"
recommendation that is pinned to the top of the quote results.

This is exactly the user's ask: *"same text box… linked so the quoter is reading
off the chat bot for what the best carrier to go with would be for approval."*

## Why this approach

The tab already has a one-shot parse pipeline:
`aq-health-text` → `anthropic-parse` edge fn → `conditions[]` →
`UW_CLASS` matrix → `worstClass()` per carrier → `_aqHealthCw` →
`reapplyApiHealthBadges()` paints badges on results.

We **reuse that entire downstream**. The only thing that changes is the *source*
of `conditions[]`: instead of a one-shot parse of a textarea, it comes from a
**multi-turn conversation**. Because the carrier ranking stays grounded in the
deterministic `UW_CLASS` matrix (not free-styled by the LLM), the chat's prose
and the badges/recommendation can never contradict each other.

## Scope

- **In scope:** the standalone **tab** (`#sec-api-quoter`). The Leads-tab quote
  **modal** (`laq-*`) keeps its existing textarea + one-shot parse, untouched.
  Both still funnel through the same `_aqHealthCw` → badge machinery.
- **Carriers with UW data:** Americo (`am`), Aetna (`at`), American-Amicable
  (`aa`), Transamerica (`tr`), Corebridge (`co`) — the five already in
  `UW_CLASS` / `LAQ_HEALTH_CARRIER_KEYS`. The recommendation is chosen among the
  agent's **licensed** carriers (`getContractedCarriers()`) intersected with
  these five.

## Components

### 1. Chat UI (replaces the tab textarea)
- `#uw-chat` container with:
  - `#uw-chat-thread` — scrolling message list (user right, assistant left).
  - `#uw-chat-reco` — compact "Recommended: <carrier> — <approval>" chip,
    visible as soon as conditions exist (even before a quote is run).
  - input row: `#uw-chat-text` (auto-growing textarea, Enter to send,
    Shift+Enter newline) + `#uw-chat-send` button.
- `#aq-health-tags` (the red condition chips) is **kept** below the thread and
  re-rendered from the live condition list each turn.
- Note text updated to mention the copilot; still clarifies health is **not**
  sent to the carrier rate API.

### 2. Front-end state & logic (in `index.html`)
- `_uwChat = { messages: [], conditions: [], busy: false }` — session state for
  the tab conversation.
- `uwChatSend()` — push user msg, render, set busy, call edge fn with the full
  `messages` + quote context, append assistant `reply`, store cumulative
  `conditions`, then refresh the overlay (badges + reco + tags).
- `uwChatReset()` — clears state + thread; called by `clearApiQuoterForm()`.
- `setHealthCwFromConditions(conds)` — factored out of `applyApiHealthOverlay()`;
  computes `_aqHealthCw` (worst class per `am/at/aa/tr/co`) or `null` when empty.
- `bestApprovalCarrier()` — from `_aqHealthCw` ∩ licensed-five, returns
  `{ key, label, approval }` with the best approval rank (reusing the rank order
  inside `worstClass`). Ties broken by carrier order am→at→aa→tr→co.
- `renderUwReco()` — paints the chip in `#uw-chat-reco` and a `.aq-uw-reco`
  banner pinned at the top of the results root.
- `applyApiHealthOverlay()` — for `source === 'tab'`, sources conditions from
  `_uwChat.conditions` (no textarea read, no extra parse call); the modal path is
  unchanged.
- `reapplyApiHealthBadges()` — extended to also (re)render the `.aq-uw-reco`
  banner so it survives result re-sorts, same as the per-row badges.

### 3. New edge function `supabase/functions/anthropic-uw-chat/index.ts`
- Mirrors `anthropic-parse` (CORS, JWT-verified, `ANTHROPIC_API_KEY`,
  model `claude-sonnet-4-20250514` for consistency with the deployed parser).
- **Request:** `{ messages: [{role:'user'|'assistant', content:string}],
  context: { product, age, sex, state, face, tobacco, carriers: string[] } }`.
- **Output via forced tool-use** (`tool_choice` = the assessment tool) so we get
  clean structured JSON, not prose-wrapped:
  - tool `provide_assessment` with:
    - `reply` (string) — the conversational message shown in the thread. The
      bot is told to be warm, concise, ask one clarifying question when health
      is ambiguous, and name the best carrier for approval from the licensed set
      with a one-line reason.
    - `conditions` (array of enum strings) — the cumulative canonical condition
      list, same vocabulary + medication mapping as `anthropic-parse`.
- **Response (200):** `{ ok:true, reply, conditions }`. Errors mirror
  `anthropic-parse` (`{ ok:false, error }`).
- System prompt = the `anthropic-parse` underwriting guidance, re-framed for
  multi-turn conversation, plus the carrier-recommendation instruction.

## Data flow (per turn)

```
agent types ─▶ uwChatSend() ─▶ anthropic-uw-chat (messages+context)
   ─▶ { reply, conditions }
   ─▶ render reply in thread
   ─▶ _uwChat.conditions = conditions
   ─▶ setHealthCwFromConditions() ─▶ _aqHealthCw
   ─▶ renderHealthTags(#aq-health-tags)
   ─▶ reapplyApiHealthBadges()  (badges + .aq-uw-reco banner on results)
   ─▶ renderUwReco()            (chip under the thread)
```

When Run Quote completes, `applyApiHealthOverlay()` repaints from the same
`_uwChat.conditions`, so a conversation held *before* quoting is honored.

## Error handling
- Edge fn unreachable / non-OK → assistant bubble shows a friendly
  "couldn't reach the underwriting model — try again" line; conditions unchanged.
- Empty/short input is ignored (no send).
- No licensed carriers → reco chip shows "Set licensed carriers in Settings."
- Bot output that isn't valid against the enum → conditions filtered to known
  `UW_CLASS` keys (same defensive filter as `anthropic-parse`).

## Testing / verification
- Manual: open the tab, hold a multi-turn conversation (e.g. "diabetes on
  metformin" → "they also have controlled high blood pressure"), confirm
  condition chips accumulate, the reco chip names a licensed carrier, run a quote
  and confirm badges + the pinned reco banner match the chip.
- Clear resets the thread, chips, reco, and `_aqHealthCw`.
- Modal quote flow in Leads tab still parses via textarea (regression check).

## Deploy (manual — per project convention)
- `supabase functions deploy anthropic-uw-chat`
- `ANTHROPIC_API_KEY` secret already set for `anthropic-parse`; reused.
- No SQL changes.
