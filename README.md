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

## Tests

Tests live under `test/`, mirroring the `src/` structure.

```
npm test
```
