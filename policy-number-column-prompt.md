# Claude Code prompt — add a "Policy #" column to the Policy Tracker table

Copy everything in the code block below and paste it into Claude Code from the repo root.

---

```
Add a "Policy #" column to the Policy Tracker ledger table in app.html.

IMPORTANT CONTEXT — READ FIRST:
The policyNumber DATA LAYER already exists and works. Do NOT re-add it. Specifically, these already exist and must be left alone:
- Add Policy modal input `p-policyNum` (~line 5530) and its save logic in addPolicy (`policy.policyNumber = policyNumber`, ~line 10650-10655).
- Edit Policy modal input `ep-policyNum` (~line 5616), its populate logic (`polNumEl.value = p.policyNumber || ''`, ~line 10717) and save logic (~line 10756-10760).
- The Supabase `match-events` function already backfills `p.policyNumber` from carrier emails and matches on it.

The ONLY thing missing is that the tracker TABLE does not display the policy number. Your job: surface `p.policyNumber` as a new column labeled "Policy #", positioned BETWEEN the Client column and the Carrier column. Edit ONLY app.html. Do NOT edit anything in the archive/ folder or the "Jace- Life Insurance/" folder — those are old snapshots.

Make exactly these four edits in app.html:

1) TABLE HEADER (~line 4013-4025, the `.pt-grid.pt-thead` block).
   Currently the header cells in order are: Client, Carrier, Product, Monthly, Ann. Premium, Date Submitted, Draft Date, Est. Adv. Commission, Class, Status, (empty actions).
   Insert a new header cell RIGHT AFTER the Client `<div>` and BEFORE the Carrier `<div>`:
       <div>Policy #</div>
   (Plain, non-sortable — matches the "Product" / "Monthly" header cells, which are also plain divs.)

2) ROW BUILDER — function `_ptRowHTML(p)` (~line 10920-10958).
   The row cells are built in the SAME order as the header. Insert a new cell RIGHT AFTER the client cell (`'<div class="pt-ell" ...>'+escHTML(p.client)+'</div>'+`) and BEFORE the carrier cell. Use this exact cell so empty values show a clean em-dash and long numbers truncate:
       '<div class="pt-ell lgm" style="font-size:12px;color:#6B6459">'+(p.policyNumber ? escHTML(p.policyNumber) : '—')+'</div>'+
   Rationale: `lgm` is the monospace ledger font (good for alphanumeric policy numbers like "BU6691749"), `pt-ell` truncates with an ellipsis, and the muted color #6B6459 keeps it secondary to the client name.

3) GRID COLUMN WIDTHS — `.ledger .pt-grid` (~line 3033).
   The current definition has 11 column tracks:
       grid-template-columns:minmax(108px,1.4fr) minmax(92px,1fr) minmax(66px,.75fr) minmax(78px,.8fr) minmax(84px,.8fr) minmax(88px,.8fr) minmax(88px,.8fr) minmax(92px,.85fr) minmax(108px,.9fr) minmax(116px,1fr) 92px;
   Add a 12th track by inserting a Policy # width as the SECOND track (right after the Client track, before the Carrier track). Change it to:
       grid-template-columns:minmax(108px,1.4fr) minmax(96px,.95fr) minmax(92px,1fr) minmax(66px,.75fr) minmax(78px,.8fr) minmax(84px,.8fr) minmax(88px,.8fr) minmax(88px,.8fr) minmax(92px,.85fr) minmax(108px,.9fr) minmax(116px,1fr) 92px;
   The order of tracks must exactly match the header/row cell order (Client, Policy #, Carrier, Product, ...).

4) TABLE MIN-WIDTH — `.ledger .pt-tmin` (~line 3032).
   It is currently `min-width:1124px`. Bump it to fit the new column so the layout doesn't crowd:
       .ledger .pt-tmin{min-width:1228px}

VERIFY before finishing:
- The number of grid tracks (12) equals the number of header cells (12) equals the number of row cells per policy (12). Count them.
- The Policy # column sits between Client and Carrier in all three places (header, row, grid tracks).
- A policy with no policyNumber renders "—" (not "undefined" or blank).
- Search app.html to confirm you did NOT duplicate or alter the existing `p-policyNum` / `ep-policyNum` modal inputs or their save/load logic.
- Open app.html in a browser (or describe how the grid renders) and confirm columns still align — the table scrolls horizontally inside `.lg-tscroll`, so the wider min-width is expected.
```

---

## What this does

It adds the visible **Policy #** column (between Client and Carrier) that you asked for, wired to the `policyNumber` field your Add/Edit forms and email pipeline already populate. Once it's in, a policy number you type when adding a policy — or one the carrier-email matcher backfills — shows right in the ledger, and the auto-match/auto-status logic (which already keys off client name **and** policy number) has a visible home in the table.

The prompt is deliberately narrow: it tells Claude Code exactly which four spots to touch, gives before/after CSS so column resizing is unambiguous, and explicitly fences off the data-layer and backend code that's already done so nothing gets duplicated.
