# assets/

Static reference materials. Not served — these are project artifacts kept
alongside the code so the source of every rate / comp number is in version
control.

## Suggested layout

```
assets/
├── comp-guides/        ← FFL compensation guide PDFs (latest + historical)
├── rate-sheets/        ← carrier rate sheets, named <carrier>-<YYYY-MM-DD>.pdf
├── uw-guides/          ← carrier underwriting guides
├── logos/              ← carrier logos for future use in carrier cards
└── screenshots/        ← UI screenshots for docs / changelog
```

## Naming

`<carrier>-<artifact>-<YYYY-MM-DD>.<ext>` — e.g. `americo-eagle-rates-2026-04-01.pdf`.
The date is the **effective** date of the rates / guide, not the download date.
