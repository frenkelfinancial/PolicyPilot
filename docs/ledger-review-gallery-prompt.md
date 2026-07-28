# Claude Code prompt — build a review gallery so I can see it

> Paste into the same Claude Code session. No code changes — just assemble the screenshots
> you already captured into one file I can open and compare to my Design mockups.

---

Don't change any app code. Build me a simple visual review gallery from the screenshots you already captured in the session scratchpad (`…/scratchpad/shots/` — `st2-{dark,light}-*.png` for Summary/Tracker, `{dark,light}-*.png` for Leads).

Do this:
1. Copy the PNGs into the repo at `docs/ledger-review/shots/` so they persist in my folder.
2. Generate a single self-contained `docs/ledger-review/gallery.html` that shows the screenshots grouped by **page** (Leads, Summary, Policy Tracker), then by **theme** (Light / Dark) side by side, then by width — each image clearly labelled with page / theme / width. Light theme on the left, dark on the right, so I can compare the two at a glance. Include a short caption at the top noting that Leads was matched to my Design mockups (light + dark) and that the dark Summary/Tracker was auto-generated from the shared color tokens.
3. Make it open cleanly by double-clicking the file — plain HTML/CSS, images referenced by relative path, no server needed.

Then tell me the full path to `gallery.html` so I can open it.
