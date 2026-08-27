# Receipt / Expense Extractor API

Turns free-text receipts, invoices, or expense notes into structured JSON, using the Claude API for extraction and classification.

## Stack

- Node.js 20 + TypeScript + NestJS
- PostgreSQL (accessed via `pg`, no ORM — plain SQL, with tables created automatically on startup)
- Claude API (`claude-haiku-4-5`, set via `ANTHROPIC_MODEL`) via structured output (`output_config.format`)

## Setup

1. Copy `.env.template` to `.env` and fill in the values — point it at an existing PostgreSQL instance (13+) and add your `ANTHROPIC_API_KEY`.
2. `npm install`
3. `npm run start:dev`

The server automatically creates the required tables (`receipts`, `categories`, `receipt_categories`) on startup.

## API docs

Interactive Swagger UI is available at `http://localhost:3000/docs` once the server is running.

## Flow

```
Client --POST /api/parse-receipt--> API (Nest)
                                        │
                                        ├─ saves the pending request to the DB (raw_text + prompt)
                                        │
                                        ├─ calls the Claude API (structured output)
                                        │
                                        ├─ saves the extracted fields + categories (many-to-many)
                                        │
                                        └─ returns the formatted JSON
```

## Endpoints

### `POST /api/parse-receipt` — free text

```json
{
  "raw_text": "Fresh Grocer Downtown - 12/08/2026. Milk 1.20, Bread 0.80, Coffee 2.50. Total: 4.50 EUR. Visa Card."
}
```

### `POST /api/parse-receipt-pdf` — PDF file

Same extraction, categorization, storage and response as the text endpoint; the input is a PDF instead. The body is `multipart/form-data` with the file under the field name **`file`**:

```bash
curl -X POST http://localhost:3000/api/parse-receipt-pdf \
  -F "file=@receipt.pdf;type=application/pdf"
```

The PDF is handed to the Claude API as a `document` content block, so Claude reads the file itself — there is no text-extraction or OCR step in this service, and no PDF library among the dependencies. Scanned and photographed pages work for the same reason.

Limits and validation: 10 MB per file (the API caps a request at 32 MB and base64 adds about a third), `application/pdf` only, and the upload must begin with the `%PDF-` signature — `mimetype` comes from the client, so the signature check is what stops a renamed JPEG from reaching the API. Over-limit uploads get a 413, the rest a 400.

Two notes on the model side: Claude caps PDFs at 100 pages on 200K-context models such as the default `claude-haiku-4-5`, and a PDF page costs more than the equivalent text because the pages are billed as images as well as text. In Postgres these rows carry `source_type = 'pdf'` with `source_filename` and `source_bytes` set and `raw_text` null, so text and PDF receipts stay distinguishable.

Both endpoints return the same body:

```json
{
  "id": "…",
  "merchant": "Fresh Grocer",
  "location": "Downtown",
  "date": "2026-08-12",
  "total_amount": 4.5,
  "currency": "EUR",
  "categories": ["Food"],
  "payment_method": "Card",
  "confidence_score": 0.95,
  "is_suspicious": false,
  "flag_reason": null,
  "duplicate_of": null,
  "status": "completed",
  "created_at": "…"
}
```

Each receipt can be associated with more than one category — the relationship is many-to-many (`receipts` ↔ `categories` via `receipt_categories`).

## Anomaly, duplicate and outlier detection

Every parsed receipt carries a verdict: `is_suspicious`, a one-sentence `flag_reason`, and `duplicate_of` when it repeats an earlier submission. Three kinds of check feed it, and the split between them is deliberate — each check lives where it can actually be answered:

| Check | Where it runs | Why there |
| --- | --- | --- |
| Atypical price for the items, items that do not fit the merchant, a total that does not reconcile with the lines, a missing total or date | Claude, via the system prompt | Judgement about a single receipt: it needs to know that 450 EUR is absurd for a steak but ordinary for a hotel |
| Issued at the weekend | `src/claude/anomaly.ts`, from the extracted date | Calendar arithmetic, which models get wrong; the prompt tells the model explicitly not to attempt it |
| Exact duplicate, and a total far above what past receipts in the same categories cost | `src/receipts/history-anomalies.ts`, from two SQL queries | Neither is judgement: one is a key lookup, the other an aggregate, and the model has no view of the stored history at all |

The deduplication key is the trimmed, case-folded merchant plus the date, total and currency, matched against earlier `completed` rows. A match is reported as a *candidate*, not a verdict — two separate purchases can legitimately share that key, so the earlier receipt's id comes back in `duplicate_of` for a human to compare against.

The outlier check compares the total against the 90th percentile of earlier receipts in the same categories, and is deliberately blunt: it needs at least `MIN_CATEGORY_SAMPLE` earlier receipts in a category before that category counts at all, it measures against the *priciest* category on the receipt, and it only fires above `OUTLIER_MULTIPLE`× that percentile. It is there to catch the order of magnitude the model waved through, not to second-guess an expensive-but-ordinary receipt.

Checks are unioned rather than overwritten, so a receipt that is both a duplicate and a weekend submission reports both reasons in `flag_reason`.

## Categories

The taxonomy is a closed list defined by `CATEGORIES` in `src/claude/claude.service.ts`. It is used twice: as the `enum` in the JSON schema, so Claude cannot invent or misspell a label, and as the list of categories with their definitions rendered into the system prompt. Add a bucket there and both follow — the `categories` table stores whatever comes back, so it needs no migration.

Claude extracts `line_items` with a category per item before it fills in the receipt-level `categories`, and the two are merged. Items outrank the merchant name when they disagree: spoons bought at a tavern are `Home & Kitchen`, not `Food`.

## Evaluating classification

`eval/receipts.eval.json` holds labelled receipts; `npm run eval` runs each one through the real Claude API and reports per-category precision, recall and F1 plus an exact-set-match rate, so a prompt or taxonomy change can be measured rather than guessed at.

```
npm run eval
npm run eval -- --label before --out reports/before.json   # keep a report to diff against
npm run eval -- --limit 5                                  # quick smoke run
```

It needs `ANTHROPIC_API_KEY` but no database, and it spends real tokens — one request per case. The bundled cases are synthetic; replace and extend them with real receipts as you collect them, especially any that get miscategorized in production.

## Tests

Tests live under `test/`, mirroring the `src/` structure.

```
npm test
```
