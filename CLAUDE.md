# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run start:dev                    # watch-mode server (needs a reachable PostgreSQL 13+ and ANTHROPIC_API_KEY)
npm run build                        # nest build -> dist/
npm run lint                         # eslint over {src,test}/**/*.ts
npm test                             # jest; only test/ is a root, spec files are *.spec.ts
npx jest test/receipts/receipts.service.spec.ts    # single test file
npx jest -t 'marks the receipt failed'             # single test by name
npm run eval                         # classification eval; spends real Claude tokens
npm run eval -- --limit 5            # smoke run
npm run eval -- --label before --out reports/before.json
```

CI (`.github/workflows/ci.yml`) runs lint, build, and test on every branch push — all three must pass.

Setup: copy `.env.template` to `.env`. `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_DB`, `ANTHROPIC_API_KEY` are required and the app refuses to boot without them.

## Architecture

Nest app with three modules under `src/`: `database` (raw `pg`), `claude` (the model call), `receipts` (HTTP + persistence). Four endpoints: `POST /api/parse-receipt` (JSON `raw_text`), `POST /api/parse-receipt-pdf` (multipart `file`) and `POST /api/parse-receipt-image` (multipart `file`, a phone photo), all three returning the same `ParsedReceiptResponseDto`, plus `GET /api/insights` (see below). Swagger at `/docs`.

Request flow for all three extraction endpoints: `ReceiptsRepository` inserts a `pending` row (recording the exact system prompt in `prompt_used`) → `ClaudeService` extracts → the history checks and the EUR rate lookup run in parallel → the row is completed and categories linked, or marked `failed`. `ReceiptsService.extractInto` is the shared tail of every path, so the endpoints cannot diverge on persistence or failure bookkeeping.

**No ORM and no migration tool.** `DatabaseService.migrate()` runs raw SQL on `onModuleInit`: a `CREATE TABLE IF NOT EXISTS` block for the original schema, then a second block of idempotent `ALTER`s for everything added since. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so **any new column or constraint must go in the ALTER block as an idempotent statement**, not into the CREATE block. All queries are parameterized SQL in `receipts.repository.ts`.

### Anomaly checks

Three sources feed one verdict (`is_suspicious`, `flag_reason`, `duplicate_of`), and which source owns a check is the design:

- **Semantic, single-receipt** — the model, in `PROMPT_BODY`. Judgement it can make from the receipt alone.
- **Calendar** — `src/claude/anomaly.ts`, from the extracted date. The prompt tells the model *not* to consider the day of the week; drop that line and weekends get flagged twice.
- **History** — `src/receipts/history-anomalies.ts`, from `ReceiptsRepository.findHistory`. An exact duplicate (trimmed, case-folded merchant + date + total + currency, over `completed` rows) and a total above `OUTLIER_MULTIPLE`× the 90th percentile of the priciest category present. The model never sees the history, so neither check is asked of it.

`unionAnomalies` in `src/claude/anomaly.ts` is the single merge rule for all three: any check firing raises the flag and its sentence is appended, so a duplicate *and* a weekend receipt reports both. When nothing outside the model fires, the model's own sentence is stored verbatim — unionAnomalies does not normalize it.

The history checks are pure functions taking query results, not the pool, so the thresholds are testable without PostgreSQL. `ReceiptsRepository.completeWithExtraction` writes the *merged* verdict, passed as its fourth argument — not `extracted.is_suspicious`, which is only the model's half. An incomplete deduplication key (no merchant, date or total) means no lookup at all, otherwise every dateless receipt from one shop would match the last.

The eval harness cannot cover these: it builds a Nest context with `ClaudeModule` only, so there is no history to cross-check. They are covered by `test/receipts/history-anomalies.spec.ts` instead.

### EUR conversion

Deterministic, not function calling: whether a receipt needs converting is `currency !== 'EUR'`, which code can answer, so the model is never asked. `FxService.rateToEur` (`src/receipts/fx.service.ts`) fetches the ECB reference rate from Frankfurter (free, keyless, no dependency - Node's `fetch`) **for the receipt's date**, not today's; an undated receipt gets the latest rate. The ECB publishes no weekend rates, so the provider answers with the nearest earlier business day and that date is what `fx_date` stores.

Any FX failure - unknown currency, timeout (5 s), provider down - returns `null` and leaves `total_eur` / `fx_rate` / `fx_date` null. It never fails the receipt. `total_eur` is computed in SQL (`round(total_amount * fx_rate, 2)` inside `completeWithExtraction`) so the rounding happens once in NUMERIC. Rows from before the conversion existed have null `total_eur`; there is no backfill.

### Insights

`GET /api/insights?from=&to=` writes a prose report on a period. The rule is that **SQL aggregates first and the model only writes about the totals** - it never sees a receipt, so it has nothing to add up wrongly. `ReceiptsRepository.spendingSummary` runs two grouped queries (per category, per month), both grouped by currency as well so a EUR total is never added to a USD one, and `renderSummary` in `src/receipts/spending-summary.ts` turns them into the text block.

Two facts are stated inside that block rather than in the system prompt, because they are properties of those numbers rather than of the task: month totals count each receipt once and may be summed; category totals overlap (a two-category receipt counts in full under both) and must not be. Drop either line and the model reports a grand total no query produced. The prompt itself carries the general rules - no invented or extrapolated figures, no cross-currency addition.

A third query (`months_eur`) sums `total_eur` per month across all currencies - the only cross-currency figure, produced by SQL. Its block section states that it is *the same spending* as the month lines, not additional; drop that line and the model adds the converted total to the EUR line. Receipts without a conversion are counted as `unconverted`, not summed, and the section is omitted when nothing in the period was converted.

The response returns the aggregates alongside the prose so any sentence can be checked against what the model saw. An empty period short-circuits before the API call. `ClaudeService.summarizeSpending` is a plain `messages.create` with no output schema (the answer is prose), sharing the error mapping through `ClaudeService.request`; truncation is logged rather than thrown, since a report cut short is still readable. The pure rendering is covered by `test/receipts/spending-summary.spec.ts`.

**Env validation** is hand-rolled: `src/config/validate-env.ts` is a generic factory (coerce by key list, then enforce required keys), and `src/config/env.validation.ts` is this app's key lists. `ConfigModule` runs it with `skipProcessEnv: true`, so a var not listed in `env.validation.ts` is invisible to `ConfigService` — adding an env var means adding it there.

### `src/claude/claude.service.ts`

The interesting file. Things to preserve when editing:

- `CATEGORIES` is the single source of truth for the taxonomy, used twice: as the schema `enum` (so the model cannot invent a label) and rendered into the system prompt via `CATEGORY_DEFINITIONS`. The `Record<(typeof CATEGORIES)[number], string>` type makes a missing definition a compile error. Adding a category needs no DB change — `categories` rows are created on demand.
- `RECEIPT_JSON_SCHEMA` is `as const` on purpose: `ExtractedReceipt` is *derived* from it via `jsonSchemaOutputFormat(...).parse`. Never declare that type by hand.
- Schema property order is generation order. `line_items` and `category_evidence` sit before `categories` so the model reasons over items first; `mergeCategories` then unions item categories into the receipt categories, ordered by the taxonomy for stable output.
- The anomaly trio (`anomaly_evidence`, `is_suspicious`, `flag_reason`) sits **last** in the schema for the same reason: the model judges an extraction it can already see, with the evidence sentence generated before the boolean. Only semantic checks live in the prompt — the day-of-week check is computed from the extracted date in `src/claude/anomaly.ts` and unioned into the verdict in `toExtraction`, because models get calendar arithmetic wrong. The prompt therefore tells the model explicitly *not* to consider the day of the week; drop that line and weekends get flagged twice.
- The three prompts are composed from a shared `PROMPT_BODY` plus a per-source `PROMPT_INTRO` (`text`, `pdf`, `image`). Keep them composed that way when editing shared prompt text. The text prompt was byte-identical to the pre-PDF version until the anomaly checks were added, so eval reports and stored `prompt_used` values from before that change are not comparable with later ones.
- `output_config.effort` is only sent for models that accept it — see `MODELS_WITHOUT_EFFORT`; Haiku and Sonnet 4.5 reject it with a 400.
- Refusals and `max_tokens` truncation arrive as HTTP 200, so they are checked explicitly in `toExtraction` rather than caught as errors.

`claude-error.ts` normalizes Anthropic SDK errors and maps them to our HTTP status: transient upstream trouble (429/5xx/network) → 429/502/503/504 so callers know to retry; unretryable causes (bad credentials, wrong model id, a malformed request we built) → 500, because those are this service's misconfiguration.

### File uploads

Both file endpoints are validated twice by design (`receipts.controller.ts` + `upload.validation.ts`): the multer `fileSize` limit caps what is buffered, and the validator re-checks size because multer *truncates* rather than failing, plus checks the file's magic bytes since client-supplied `mimetype` is not trustworthy. `MAX_UPLOAD_BYTES` is shared — 10 MB, chosen against the API's 32 MB request cap and base64's ~⅓ inflation.

No PDF or image library is involved, and none is wanted: the PDF goes to Claude as a `document` block and the photo as an `image` block. A modern model needs no separate OCR step, so accepting photographs costs no extra code — only accuracy, which is what the eval measures.

`validateImageUpload` returns `{ file, mediaType }` rather than just the file, and that is the point: the media type is **derived from the magic bytes**, never taken from `file.mimetype`, because it is forwarded verbatim in the `image` block and a mislabelled upload would come back as an opaque upstream 400. `ImageMediaType` comes from the SDK (`Anthropic.Base64ImageSource['media_type']`), not from a hand-written union. `imageMediaType(buffer)` is exported as a pure function so `eval/run-eval.ts` sniffs its fixtures with the same code.

The image path needed **no migration**: `raw_text` was already nullable and `source_type` is `VARCHAR(10)`, so `'image'` fits. `createPendingUpload` takes the source type as a parameter, which is what keeps the PDF and photo inserts from being two near-identical statements.

## Eval harness

`eval/run-eval.ts` builds a Nest context with `ClaudeModule` only (no `DatabaseModule`, so no PostgreSQL needed) and scores `eval/receipts.eval.json` cases for per-category precision/recall/F1 and exact-set match. Any prompt or taxonomy change should be measured with a before/after report rather than eyeballed.

A case may also carry `expected_suspicious`, which scores the anomaly flag in a separate section of the report. It is optional by design: a case without it is **excluded** from that metric rather than assumed `false`, so the category fixtures need no anomaly verdict invented for them. When adding a weekend case, verify the weekday of the date — the calendar check is real arithmetic, not a label.

A case carries either `raw_text` or `image` (a path relative to `eval/`). An image case runs through `extractReceiptFromImage`, and when it names a `same_as` text case for the same receipt, the two are compared in the `=== Photo vs text ===` section — exact-set match and micro-F1 for each side and the delta between them. That delta is the whole point: it is what accepting photographs actually costs.

An image case whose file is missing or is not a recognized image format is **skipped**, not failed: excluded from every metric and reported as a count. `eval/images/` therefore ships empty (see its README) and the eval still runs green on a fresh clone. A pair with only one side run — `--limit` takes the first N cases and the image cases sit at the end of the fixture — is excluded from the comparison and listed as incomplete. Photos cannot be synthesized: a rendered image of receipt text would measure font rasterization, not what a camera does to thermal paper, and would flatter the score.

## Tests

`test/` mirrors `src/`. Services are tested through `Test.createTestingModule` with hand-written `jest.fn()` doubles for `ClaudeService` and `ReceiptsRepository` — nothing hits PostgreSQL or the Claude API.
