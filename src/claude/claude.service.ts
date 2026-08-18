import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  describeClaudeError,
  formatClaudeError,
  toHttpException,
} from './claude-error';

export interface ExtractedReceipt {
  merchant: string | null;
  location: string | null;
  /** ISO 8601 date (YYYY-MM-DD), or null if not present in the source text. */
  date: string | null;
  total_amount: number | null;
  /** ISO 4217 currency code, e.g. EUR. */
  currency: string | null;
  payment_method: string | null;
  /** A receipt can legitimately belong to more than one category. */
  categories: string[];
  confidence_score: number;
}

const SYSTEM_PROMPT = `You are an expert financial data extraction assistant. Given the raw text of a receipt, invoice, or expense note, extract structured information from it.

Rules:
- "merchant" is the name of the store or business only, without the location (e.g. "Fresh Grocer Downtown" -> merchant "Fresh Grocer", location "Downtown").
- "location" is the city or place mentioned, if any. Use null if none is present.
- "date" must be normalized to ISO 8601 (YYYY-MM-DD). Use null if no date is present.
- "total_amount" is the final total paid, as a plain number with no currency symbols or thousands separators.
- "currency" is the ISO 4217 currency code. Infer it from symbols or context (e.g. "EUR" or the euro symbol map to "EUR") when it is not written explicitly.
- "payment_method" should be normalized (e.g. "Card", "Cash", "MBWay", "Bank Transfer"). Use null if not mentioned.
- "categories" must contain one or more relevant expense categories (e.g. Food, Transportation, Health, Leisure, Housing, Clothing, Other). Assign more than one when the receipt legitimately spans multiple categories.
- "confidence_score" is your confidence in the overall extraction, between 0 and 1.

Only use information present in the text or safely inferable from it. Do not fabricate data.`;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] };

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
    categories: {
      type: 'array',
      items: { type: 'string' },
      description: 'One or more expense categories that apply to this receipt',
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
    'categories',
    'confidence_score',
  ],
  additionalProperties: false,
};

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
    this.model = this.config.get<string>('ANTHROPIC_MODEL') ?? 'claude-opus-5';
  }

  get systemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  async extractReceipt(rawText: string): Promise<ExtractedReceipt> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: rawText }],
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: RECEIPT_JSON_SCHEMA },
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

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude did not return a text response for this receipt');
    }

    return JSON.parse(textBlock.text) as ExtractedReceipt;
  }
}
