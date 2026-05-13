# Data Sources

Where each table in `index.html` comes from. Update this when you refresh a table.

| Table (line) | Source | Last verified |
|---|---|---|
| `COMP` (852) | Official FFL comp guide images | unknown — verify |
| `FE_RATES.americo_eagle` (910) | "Industry standard approximation" per code comment | unknown — needs replacement with published rates |
| `CARRIER_MULTS` (931) | Derived multipliers vs Americo Eagle baseline | unknown |
| `UW_CLASS` (1087) | Hand-curated from carrier UW guides | unknown |
| `UW_DATA` (1792) | Hand-curated from carrier UW guides | unknown |
| `BUILD_CHART` (1886) | Universal life build chart | unknown |
| `BUILD_LIMITS` (1933) | Build chart cutoffs | unknown |
| `EAPP_URLS` (1226) | Carrier agent portals | live as of file creation |
| `AM_MS` (1687) | Americo UFirst Rewards Dec 2025–May 2026 schedule | confirmed in code comment |

## TODO when refreshing a rate / comp table

1. Save the source PDF/screenshot to `assets/rate-sheets/<carrier>-<YYYY-MM-DD>.pdf`.
2. Update the table in `index.html`.
3. Update the matching JSON in `data/` (if extracted).
4. Bump the "Last verified" column above with today's date and the source filename.
5. If rates moved noticeably, snapshot the previous `index.html` to
   `archive/index-<YYYY-MM-DD>.html` first.
