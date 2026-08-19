# Receipt / Expense Extractor API

Turns free-text receipts, invoices, or expense notes into structured JSON, using the Claude API for extraction and classification.

## Stack

- Node.js 20 + TypeScript + NestJS
- PostgreSQL (accessed via `pg`, no ORM — plain SQL, with tables created automatically on startup)
- Claude API (`claude-opus-4-8`, set via `ANTHROPIC_MODEL`) via structured output (`output_config.format`)

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

## Endpoint

`POST /api/parse-receipt`

```json
{
  "raw_text": "Fresh Grocer Downtown - 12/08/2026. Milk 1.20, Bread 0.80, Coffee 2.50. Total: 4.50 EUR. Visa Card."
}
```

Response:

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
  "status": "completed",
  "created_at": "…"
}
```

Each receipt can be associated with more than one category — the relationship is many-to-many (`receipts` ↔ `categories` via `receipt_categories`).

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
