# Asking questions about your receipts — `POST /api/ask`

Ask a question about your spending in plain language, in Portuguese or English, and get a short answer back in the same language.

```
Quanto gastei em comida nos últimos 3 meses?
→ Entre 25 de junho e 25 de setembro de 2026 gastou 312,40 EUR em comida, em 21 recibos.
```

## How it works

The model does not see your receipts and does not write SQL. It has one tool, `query_receipts`, that returns **totals** for the receipts matching a fixed set of filters:

| Filter | Meaning |
|---|---|
| `from`, `to` | Period, inclusive (receipt date, not upload date) |
| `categories` | One or more of the app's categories, e.g. `Food`, `Transportation` |
| `merchant` | Part of the merchant name, case-insensitive |
| `min_total`, `max_total` | Range of the receipt total |

It gets back, for each currency: the number of receipts, the total, the same spending converted to EUR (`total_eur`), and how many receipts had no EUR conversion (`unconverted`).

The model reads your question, picks the filters, calls the tool (more than once for comparisons), and writes the answer from what comes back. The server checks every set of filters before running the query. If the model gets one wrong, it is told why and can try again.

Only `completed` receipts that have a date and a total are counted.

The categories are: Food, Home & Kitchen, Household Supplies, Personal Care, Health, Clothing, Transportation, Travel & Accommodation, Housing, Electronics, Leisure, Education, Services & Fees, Prepared food or drinks, Other.

## Calling the endpoint

- **URL:** `http://localhost:3000/api/ask` (the port is `PORT` in `.env`, default 3000)
- **Method:** `POST`
- **Header:** `Content-Type: application/json`
- **Body:** `{ "question": "..." }`, a string from 1 to 500 characters

The server must be running (`npm run start:dev`), with a reachable database and `ANTHROPIC_API_KEY` set. Each question costs real Claude tokens, usually one to three model calls.

### Postman

1. Click **New → HTTP Request**, or the **+** tab.
2. Set the method to **POST** and the URL to `http://localhost:3000/api/ask`.
3. Open the **Body** tab, choose **raw**, then choose **JSON** in the dropdown on the right. Postman adds the `Content-Type: application/json` header for you.
4. Paste:
   ```json
   {
     "question": "Quanto gastei em comida nos últimos 3 meses?"
   }
   ```
5. Click **Send**. Expect **200 OK** with the JSON shown in [The response](#the-response).

To reuse it, click **Save** and add it to a collection. If you set a collection variable `baseUrl = http://localhost:3000`, the URL becomes `{{baseUrl}}/api/ask`.

### Swagger

Open `http://localhost:3000/docs`, expand **POST /api/ask**, click **Try it out**, edit the question and click **Execute**.

### curl (Git Bash, macOS, Linux)

```bash
curl -X POST http://localhost:3000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "How much did I spend on transportation in August 2026?"}'
```

### PowerShell

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/ask `
  -ContentType 'application/json; charset=utf-8' `
  -Body '{"question": "Quanto gastei no Pingo Doce este ano?"}' | ConvertTo-Json -Depth 6
```

## The response

```json
{
  "answer": "Entre 25 de junho e 25 de setembro de 2026 gastou 312,40 EUR em comida, em 21 recibos.",
  "queries": [
    {
      "input": {
        "from": "2026-06-25",
        "to": "2026-09-25",
        "categories": ["Food"],
        "merchant": null,
        "min_total": null,
        "max_total": null
      },
      "result": [
        { "currency": "EUR", "receipts": 21, "total": 312.4, "total_eur": 312.4, "unconverted": 0 }
      ]
    }
  ]
}
```

`queries` lists every tool call the model made, in order. **Read it to check the answer:** every number in `answer` should appear in some `result`, and `input` shows how the question was interpreted. For example, it shows which dates "last 3 months" became.

A call the server rejected has `error` instead of `result`:

```json
{ "input": { "from": "2026-09-01", "to": "2026-06-01", "...": "..." }, "error": "\"from\" must not be later than \"to\"." }
```

An empty `queries` array means the model answered without looking anything up, usually because the question was not about spending.

## Questions that work

Anything that comes down to **a total or a count, for a period, optionally narrowed by category, merchant or amount**:

| Question | Filters the model should pick |
|---|---|
| Quanto gastei em comida nos últimos 3 meses? | period of the last 3 months, `categories: ["Food"]` |
| How much did I spend in August 2026? | `2026-08-01` to `2026-08-31`, no other filters |
| Quanto gastei no Pingo Doce este ano? | this year so far, `merchant: "Pingo Doce"` |
| How many receipts over 100 EUR did I have last month? | last month, `min_total: 100` |
| How much did I spend on transport and travel in July? | July, `categories: ["Transportation", "Travel & Accommodation"]` |
| Compara o que gastei em restaurantes em julho e em agosto. | two calls, one per month, `categories: ["Prepared food or drinks"]` |
| Did I spend more on health or on leisure this year? | two calls, one per category |
| How much did I spend in USD on my trip in March? | March. The answer reports USD separately, plus the EUR conversion |
| Quantos recibos tenho de 2026? | the whole year, the answer gives the count |

Relative dates ("last month", "este ano", "nos últimos 3 meses") are worked out from today's date on the server.

## Questions that don't work, or not well

These are limits of the tool, not bugs. The model can only see totals.

| Question | What happens | Why |
|---|---|---|
| What was my most expensive purchase? | Can't name it. At best it narrows with `min_total` | The tool returns totals, never individual receipts |
| List my receipts from Continente. | Gives a count and a total, not a list | Same reason |
| How much did I spend on coffee? | Answers for a whole category such as `Prepared food or drinks` or `Food`, which covers much more than coffee | Line items are not searchable; the smallest unit is a category |
| How much did I pay by MB WAY? | Can't filter; it may say so, or answer for all payment methods | Payment method is not a filter |
| How much did I spend in Lisbon? | Can't filter by location | Location is not a filter |
| Which receipts were flagged as suspicious or duplicates? | Can't answer | Anomaly flags are not exposed to the tool |
| Month by month for the whole year? | Unreliable. It needs one call per month and may run out of calls (4 model calls per question) | Results are totals per currency, not per month. Use `GET /api/insights` for a period report |
| What's my average receipt? | May or may not do the division; the rules say every figure must come from a tool result | No average is returned |
| How much will I spend next month? | Declines to predict | Forecasting is forbidden by the prompt |
| What's my total across all currencies? | Reports each currency, plus `total_eur` as the converted figure. Never adds EUR to USD | Deliberate |
| Receipts with no date, or still pending/failed | Never counted | They can't be placed in a period |
| What's the weather in Porto? | Says it only answers questions about your receipts, without a tool call | Out of scope |

When an answer looks off, check `queries[].input` first. The usual cause is the model picking a broader category or a different period than you meant. Asking again with the category name or exact dates ("em julho de 2026", "category Transportation") fixes most of these.

## Errors

| Status | When |
|---|---|
| 400 | `question` missing, empty, not a string, or over 500 characters. The body lists the reason in `message` |
| 429 / 503 | Claude API rate limit or overload. Safe to retry |
| 500 | The model refused, kept calling tools without settling on an answer, or the service is misconfigured (bad API key or model id) |

Example 400:

```json
{
  "message": ["question should not be empty"],
  "error": "Bad Request",
  "statusCode": 400
}
```
