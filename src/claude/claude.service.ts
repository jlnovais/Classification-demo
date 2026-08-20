import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import {
  describeClaudeError,
  formatClaudeError,
  toHttpException,
} from './claude-error';

/**
 * The closed category taxonomy. It is both the `enum` in the JSON schema (so
 * Claude cannot invent or misspell a label) and the list rendered into the
 * system prompt, which keeps prompt and schema from drifting apart.
 *
 * Adding a bucket here is the fix for receipts that currently land in "Other" -
 * pets, gifts and donations are the obvious next candidates.
 */
const CATEGORIES = [
  'Food',
  'Home & Kitchen',
  'Household Supplies',
  'Personal Care',
  'Health',
  'Clothing',
  'Transportation',
  'Travel & Accommodation',
  'Housing',
  'Electronics',
  'Leisure',
  'Education',
  'Services & Fees',
  'Prepared food or drinks',
  'Other',
] as const;

/**
 * One definition per category. Definitions classify far more reliably than bare
 * labels, and the `Record` type makes a missing or stale definition a compile
 * error rather than a silent gap in the prompt.
 */
const CATEGORY_DEFINITIONS: Record<(typeof CATEGORIES)[number], string> = {
  Food: 'anything meant to be eaten or drunk: restaurant, cafe and bar bills, takeaway, groceries, drinks.',
  'Home & Kitchen':
    'durable goods for the home: cutlery, kitchen utensils, cookware, tableware, home textiles, furniture, decor, and small kitchen appliances such as kettles, toasters and blenders.',
  'Household Supplies':
    'consumable non-food supplies for the home: cleaning products, detergent, paper towels, bin bags, batteries, light bulbs.',
  'Personal Care':
    'hairdressing, beauty treatments, cosmetics, and toiletries such as shampoo, toothpaste and razors.',
  Health:
    'medication and medical care: pharmacy prescriptions, doctors, dentists, opticians, physiotherapy, medical exams.',
  Clothing: 'clothes, footwear, and accessories such as bags and belts.',
  Transportation:
    'fuel, public transport, tolls, parking, taxis and rideshare, vehicle repair, maintenance and parts.',
  'Travel & Accommodation':
    'hotels, guesthouses, flights, long-distance rail, and car rental.',
  Housing:
    'rent, mortgage payments, condominium fees, and home utilities: electricity, water, gas, internet, phone.',
  Electronics:
    'computers, phones, TVs, audio, cameras, their accessories, and software. Small kitchen appliances belong to Home & Kitchen instead.',
  Leisure:
    'cinema, concerts, museums, sport and gym, hobbies, games, toys, recreational reading, streaming subscriptions.',
  Education:
    'tuition, courses, exam fees, textbooks, and school or study supplies.',
  'Services & Fees':
    'bank charges, insurance premiums of any kind including vehicle and home insurance, postage, legal, accounting and other professional services.',
  'Prepared food or drinks':
    'Prepared food or drinks for immediate consumption, including restaurant, cafe and bar bills, takeaway and drinks.',
  Other:
    'only when nothing above applies, for example veterinary care, pet supplies, gifts and donations.',
};

const CATEGORY_BLOCK = CATEGORIES.map(
  (category) => `- ${category} - ${CATEGORY_DEFINITIONS[category]}`,
).join('\n');

const SYSTEM_PROMPT = `You are an expert financial data extraction assistant. Given the raw text of a receipt, invoice, or expense note, extract structured information from it.

Field rules:
- "merchant" is the name of the store or business only, without the location (e.g. "Fresh Grocer Downtown" -> merchant "Fresh Grocer", location "Downtown").
- "location" is the city or place mentioned, if any. Use null if none is present.
- "date" must be normalized to ISO 8601 (YYYY-MM-DD). Use null if no date is present.
- "total_amount" is the final total paid, as a plain number with no currency symbols or thousands separators.
- "currency" is the ISO 4217 currency code. Infer it from symbols or context (e.g. "EUR" or the euro symbol map to "EUR") when it is not written explicitly.
- "payment_method" should be normalized (e.g. "Card", "Cash", "MBWay", "Bank Transfer"). Use null if not mentioned.
- "line_items" holds one entry per distinct product or service listed on the receipt, with the category of that single item. Use an empty array when the receipt lists no items.
- "category_evidence" is one short sentence naming the evidence you used to choose the categories.
- "categories" holds every category that applies to the receipt as a whole.
- "confidence_score" is your confidence in the overall extraction, between 0 and 1.

Categories - use only these names, spelled exactly as written:
${CATEGORY_BLOCK}

How to categorize:
1. Categorize what was actually bought. The item lines are the primary evidence, so work through "line_items" first and let them drive "categories".
2. The merchant name or type is weaker evidence. Rely on it only when the receipt lists no items, or the item names are unrecognizable. A tavern that sells spoons is Home & Kitchen, not Food; a bookshop that sells a novel is Leisure, not Education.
3. Assign every category that applies. A supermarket receipt with milk, dishwashing detergent and a frying pan is Food, Household Supplies and Home & Kitchen at once.
4. Use "Other" only when nothing else fits.

Language:
Receipts may be written in Portuguese, English, or a mix of both. Work out what each item actually is before categorizing it. Portuguese terms that are easy to misread: "colheres" = spoons, "garfos" = forks, "facas" = knives, "talheres" = cutlery, "tachos" and "panelas" = pots and pans, "frigideira" = frying pan, "caneca" = mug, "louca" = crockery (so "detergente da louca" is dishwashing detergent, a supply), "toalhas" = towels, "lixivia" = bleach, "tasco" = a small tavern, "padaria" = bakery, "farmacia" = pharmacy, "papelaria" = stationery shop, "coiso" = a slang filler word carrying no meaning.

Only use information present in the text or safely inferable from it. Do not fabricate data.`;

// `as const` throughout: the schema is the single source of truth for
// `ExtractedReceipt`, and deriving a type from it needs the literal types
// (`type: 'string'`, not `type: string`) that widening would throw away.
const nullableString = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
} as const;
const nullableNumber = {
  anyOf: [{ type: 'number' }, { type: 'null' }],
} as const;

const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    merchant: nullableString,
    location: nullableString,
    date: {
      ...nullableString,
      description: 'ISO 8601 date (YYYY-MM-DD), or null if not present',
    },
    total_amount: nullableNumber,
    currency: {
      ...nullableString,
      description: 'ISO 4217 currency code (e.g. EUR, USD)',
    },
    payment_method: nullableString,
    // Property order is generation order, so the items and the evidence
    // sentence are both filled in before the receipt-level categories.
    line_items: {
      type: 'array',
      description:
        'One entry per distinct product or service on the receipt; empty if none are listed',
      items: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'The item as written on the receipt',
          },
          quantity: nullableNumber,
          category: {
            type: 'string',
            enum: CATEGORIES,
            description: 'The single category this item belongs to',
          },
        },
        required: ['description', 'quantity', 'category'],
        additionalProperties: false,
      },
    },
    category_evidence: {
      type: 'string',
      description:
        'One short sentence naming the evidence behind the chosen categories',
    },
    categories: {
      type: 'array',
      items: { type: 'string', enum: CATEGORIES },
      description: 'Every category that applies to the receipt as a whole',
    },
    confidence_score: {
      type: 'number',
      description: 'Confidence in the extraction, between 0 and 1',
    },
  },
  required: [
    'merchant',
    'location',
    'date',
    'total_amount',
    'currency',
    'payment_method',
    'line_items',
    'category_evidence',
    'categories',
    'confidence_score',
  ],
  additionalProperties: false,
} as const;

/**
 * Wraps the schema so `messages.parse()` validates the response for us instead
 * of us asserting the shape with a cast.
 */
const RECEIPT_OUTPUT_FORMAT = jsonSchemaOutputFormat(RECEIPT_JSON_SCHEMA);

/**
 * Derived from `RECEIPT_JSON_SCHEMA` rather than declared alongside it, so the
 * shape Claude is constrained to emit and the shape the rest of the app reads
 * cannot drift apart.
 */
export type ExtractedReceipt = ReturnType<typeof RECEIPT_OUTPUT_FORMAT.parse>;

/**
 * Thinking tokens count against `max_tokens`, so this has to leave room for
 * both the reasoning and the JSON object. The object itself is a few hundred
 * tokens; a ceiling too close to that truncates the output mid-JSON.
 */
const MAX_TOKENS = 4096;

/**
 * `output_config.effort` is rejected with a 400 on the Haiku tier and on
 * Sonnet 4.5, so it can only be sent for models that accept it — Opus 4.5,
 * Sonnet 5 and everything above them. Matched by prefix rather than by an
 * exhaustive list so a newly released model is assumed to support it.
 */
const MODELS_WITHOUT_EFFORT = [/^claude-haiku-/, /^claude-sonnet-4-5/];

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly client: Anthropic;
  /** Public so tooling such as the eval runner can report which model ran. */
  readonly model: string;
  private readonly supportsEffort: boolean;

  constructor(private readonly config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
    this.model =
      this.config.get<string>('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5';

    this.supportsEffort = !MODELS_WITHOUT_EFFORT.some((pattern) =>
      pattern.test(this.model),
    );
  }

  get systemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  async extractReceipt(rawText: string): Promise<ExtractedReceipt> {
    const response = await this.requestExtraction(rawText);

    // A refusal and a truncation both arrive as HTTP 200, so neither reaches
    // the error mapping in `requestExtraction`. Truncation matters particularly:
    // the output stops mid-JSON and would otherwise surface as an unmapped
    // SyntaxError from the parser.
    if (response.stop_reason === 'max_tokens') {
      this.logger.error(
        `Claude hit the ${MAX_TOKENS}-token ceiling before finishing the receipt JSON ` +
          `(request_id=${response._request_id ?? 'none'})`,
      );
      throw new Error(
        'Claude ran out of output tokens before finishing this receipt',
      );
    }

    if (response.stop_reason === 'refusal') {
      this.logger.error(
        `Claude declined to extract this receipt ` +
          `(category=${response.stop_details?.category ?? 'none'}, ` +
          `request_id=${response._request_id ?? 'none'})`,
      );
      throw new Error('Claude declined to extract this receipt');
    }

    if (!response.parsed_output) {
      this.logger.error(
        `Claude returned no parseable receipt JSON ` +
          `(stop_reason=${response.stop_reason ?? 'none'}, ` +
          `request_id=${response._request_id ?? 'none'})`,
      );
      throw new Error('Claude did not return a usable receipt extraction');
    }

    return {
      ...response.parsed_output,
      categories: mergeCategories(response.parsed_output),
    };
  }

  /**
   * Kept separate so the parsed response type is inferred from the request
   * rather than restated as an annotation on a pre-declared variable.
   */
  private async requestExtraction(rawText: string) {
    try {
      return await this.client.messages.parse({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: rawText }],
        output_config: {
          ...(this.supportsEffort ? { effort: 'low' as const } : {}),
          format: RECEIPT_OUTPUT_FORMAT,
        },
      });
    } catch (error) {
      const details = describeClaudeError(error);
      if (!details) {
        throw error;
      }
      this.logger.error(formatClaudeError(details));
      this.logger.error(
        `Claude API response body: ${JSON.stringify(details.anthropic_response)}`,
      );
      throw toHttpException(details);
    }
  }
}

/**
 * The receipt categories are the union of what Claude assigned to the receipt as
 * a whole and to each individual item, so a category it recognized on an item
 * but forgot to roll up is not lost. Ordered by the taxonomy so the output is
 * stable rather than dependent on the order Claude happened to emit.
 */
function mergeCategories(
  extracted: ExtractedReceipt,
): ExtractedReceipt['categories'] {
  const assigned = new Set<string>([
    ...extracted.categories,
    ...extracted.line_items.map((item) => item.category),
  ]);
  return CATEGORIES.filter((category) => assigned.has(category));
}
