# Carrier email test fixtures

Real carrier emails captured from the production Gmail inbox on **2026-07-08**, for testing the
email classifier and field-extraction logic of the carrier email parsing feature.

Each `*.json` fixture contains:

- `gmail_message_id` — the original Gmail message ID
- `carrier` — carrier key matching `docs/carrier_sender_map.json`
- `expected` — ground-truth classification (`email_type` / `content_type` / `route`) per
  `docs/carrier_sender_map.json`; use these as assertions in classifier tests
- `from`, `subject`, `date`, `has_attachments` — copied exactly from the message
- `plaintext_body` / `html_body` — the full message bodies, verbatim and untruncated
  (`null` when the message did not include that body variant)

## PII warning

These files contain **real client PII** (names, policy numbers, phone numbers, addresses,
premium amounts, and health-related underwriting details). This folder must **not** be
committed to a public repository. If this repo is ever shared, add the fixtures to
`.gitignore` first, e.g.:

```
test/fixtures/*.json
```
