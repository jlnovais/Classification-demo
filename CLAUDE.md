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

Nest app with three modules under `src/`: `database` (raw `pg`), `claude` (the model call), `receipts` (HTTP + persistence). Two endpoints, `POST /api/parse-receipt` (JSON `raw_text`) and `POST /api/parse-receipt-pdf` (multipart `file`), both returning the same `ParsedReceiptResponseDto`. Swagger at `/docs`.

Request flow for both endpoints: `ReceiptsRepository` inserts a `pending` row (recording the exact system prompt in `prompt_used`) → `ClaudeService` extracts → the row is completed and categories linked, or marked `failed`. `ReceiptsService.extractInto` is the shared tail of both paths, so the two endpoints cannot diverge on persistence or failure bookkeeping.

**No ORM and no migration tool.** `DatabaseService.migrate()` runs raw SQL on `onModuleInit`: a `CREATE TABLE IF NOT EXISTS` block for the original schema, then a second block of idempotent `ALTER`s for everything added since. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so **any new column or constraint must go in the ALTER block as an idempotent statement**, not into the CREATE block. All queries are parameterized SQL in `receipts.repository.ts`.

**Env validation** is hand-rolled: `src/config/validate-env.ts` is a generic factory (coerce by key list, then enforce required keys), and `src/config/env.validation.ts` is this app's key lists. `ConfigModule` runs it with `skipProcessEnv: true`, so a var not listed in `env.validation.ts` is invisible to `ConfigService` — adding an env var means adding it there.

### `src/claude/claude.service.ts`

The interesting file. Things to preserve when editing:

- `CATEGORIES` is the single source of truth for the taxonomy, used twice: as the schema `enum` (so the model cannot invent a label) and rendered into the system prompt via `CATEGORY_DEFINITIONS`. The `Record<(typeof CATEGORIES)[number], string>` type makes a missing definition a compile error. Adding a category needs no DB change — `categories` rows are created on demand.
- `RECEIPT_JSON_SCHEMA` is `as const` on purpose: `ExtractedReceipt` is *derived* from it via `jsonSchemaOutputFormat(...).parse`. Never declare that type by hand.
- Schema property order is generation order. `line_items` and `category_evidence` sit before `categories` so the model reasons over items first; `mergeCategories` then unions item categories into the receipt categories, ordered by the taxonomy for stable output.
- The two prompts are composed from a shared `PROMPT_BODY` plus a per-source `PROMPT_INTRO`, and the text prompt is byte-identical to the pre-PDF version so eval baselines and stored `prompt_used` values stay comparable. Keep it that way when editing shared prompt text.
- `output_config.effort` is only sent for models that accept it — see `MODELS_WITHOUT_EFFORT`; Haiku and Sonnet 4.5 reject it with a 400.
- Refusals and `max_tokens` truncation arrive as HTTP 200, so they are checked explicitly in `toExtraction` rather than caught as errors.

`claude-error.ts` normalizes Anthropic SDK errors and maps them to our HTTP status: transient upstream trouble (429/5xx/network) → 429/502/503/504 so callers know to retry; unretryable causes (bad credentials, wrong model id, a malformed request we built) → 500, because those are this service's misconfiguration.

PDF uploads are validated twice by design (`receipts.controller.ts` + `pdf-file.validation.ts`): the multer `fileSize` limit caps what is buffered, and `validatePdfUpload` re-checks size because multer *truncates* rather than failing, plus checks the `%PDF-` signature since client-supplied `mimetype` is not trustworthy. No PDF library is involved — the file goes to Claude as a `document` block.

## Eval harness

`eval/run-eval.ts` builds a Nest context with `ClaudeModule` only (no `DatabaseModule`, so no PostgreSQL needed) and scores `eval/receipts.eval.json` cases for per-category precision/recall/F1 and exact-set match. Any prompt or taxonomy change should be measured with a before/after report rather than eyeballed.

## Tests

`test/` mirrors `src/`. Services are tested through `Test.createTestingModule` with hand-written `jest.fn()` doubles for `ClaudeService` and `ReceiptsRepository` — nothing hits PostgreSQL or the Claude API.
