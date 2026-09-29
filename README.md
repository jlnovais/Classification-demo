# Receipt / Expense Extractor API

Turns free-text receipts, PDFs, or phone photos of receipts into structured JSON, using the Claude API for extraction and classification. Stored receipts can then be summarized over a period or queried in plain language.

## Stack

- Node.js 20 + TypeScript + NestJS
- PostgreSQL (accessed via `pg`, no ORM — plain SQL, with tables created automatically on startup)
- Claude API (`claude-haiku-4-5`, set via `ANTHROPIC_MODEL`) via structured output (`output_config.format`)

## Setup

1. Copy `.env.template` to `.env` and fill in the values — point it at an existing PostgreSQL instance (13+) and add your `ANTHROPIC_API_KEY`. The FX settings (`FX_API_URL_TEMPLATE`, `FX_API_TIMEOUT_MS`) are optional; the defaults point at Frankfurter with a 5 s timeout.
2. `npm install`
3. `npm run start:dev`

The server automatically creates the required tables (`receipts`, `categories`, `receipt_categories`) on startup.

## API docs

Interactive Swagger UI is available at `http://localhost:3000/docs` once the server is running.

## Flow

```
Client --POST /api/parse-receipt[-pdf|-image]--> API (Nest)
                                        │
                                        ├─ saves the pending request to the DB (raw_text or file metadata + prompt)
                                        │
                                        ├─ calls the Claude API (structured output)
                                        │
                                        ├─ in parallel: history checks (duplicate, outlier) + EUR rate lookup
                                        │
                                        ├─ saves the extracted fields, merged anomaly verdict, EUR total
                                        │  and categories (many-to-many) — or marks the row failed
                                        │
                                        └─ returns the formatted JSON
```

All three extraction endpoints share that tail, so they cannot diverge on persistence or failure handling.

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

### `POST /api/parse-receipt-image` — phone photo

Same extraction again, for a photograph of a paper receipt. `multipart/form-data`, field name **`file`**:

```bash
curl -X POST http://localhost:3000/api/parse-receipt-image \
  -F "file=@receipt.jpg;type=image/jpeg"
```

The photo goes to Claude as an `image` content block — no OCR step, no image library. JPEG, PNG, WebP and GIF are accepted, up to the same 10 MB. The media type forwarded to Claude is read from the file's magic bytes, never from the client's `mimetype`, so a mislabelled upload is rejected here with a 400 instead of failing upstream. Rows carry `source_type = 'image'`.

All three extraction endpoints return the same body:

```json
{
  "id": "…",
  "merchant": "Fresh Grocer",
  "merchant_details": "Fresh Grocer Lda, Rua do Comercio 12, 1200-100 Lisboa",
  "merchant_vatNumber": "PT501234567",
  "merchant_phone": "+351 210 000 000",
  "invoice_number": "FT 2026/1234",
  "location": "Downtown",
  "date": "2026-08-12",
  "total_amount": 4.5,
  "currency": "EUR",
  "total_eur": 4.5,
  "fx_rate": 1,
  "fx_date": "2026-08-12",
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

### `GET /api/insights?from=YYYY-MM-DD&to=YYYY-MM-DD` — spending report

Writes a short prose report on the `completed` receipts dated inside the period. SQL aggregates first — totals per category and per month, both split by currency — and the model only writes about those totals; it never sees a receipt, so it has nothing to add up wrongly. The response returns the aggregates (`categories`, `months`, `months_eur`) alongside the `summary`, so any sentence can be checked against the numbers the model saw. Category totals overlap (a two-category receipt counts under both) and must not be summed; month totals count each receipt once. An empty period returns a fixed sentence without calling the API.

### `POST /api/ask` — plain-language questions

```json
{ "question": "Quanto gastei em comida nos últimos 3 meses?" }
```

Claude gets one tool, `query_receipts`, with fixed filters (period, categories, merchant, total range). It picks the arguments; the SQL is ours and parameterized, and every argument is re-validated before it reaches the database. The response returns the `answer` plus every tool call made (`queries`), so every number can be checked. See [docs/ask-endpoint.md](docs/ask-endpoint.md) for what it can and cannot answer.

## EUR conversion

A receipt in another currency gets `total_eur`, `fx_rate` and `fx_date`, using the ECB reference rate from [Frankfurter](https://www.frankfurter.app/) **for the receipt's date** (latest rate if undated). The ECB publishes no weekend rates, so `fx_date` is the nearest earlier business day. Whether to convert is `currency !== 'EUR'` — a question code answers, so the model is never asked. Any FX failure leaves the three fields null; it never fails the receipt. Receipts stored before the conversion existed have null `total_eur`.

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

Cases with `expected_suspicious` also score the anomaly flag, in a separate section; cases without it are excluded from that metric. Cases can carry an `image` instead of `raw_text`, and an image case paired with a text case via `same_as` is compared against it in the `=== Photo vs text ===` section — the delta is what accepting photographs costs. The photos are not bundled; see [eval/images/README.md](eval/images/README.md). The history checks and EUR conversion are not covered by the eval (it runs without a database) — they are covered by unit tests.

## Tests

Tests live under `test/`, mirroring the `src/` structure.

```
npm test
```
