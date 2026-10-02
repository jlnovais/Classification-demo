import { ApiProperty } from '@nestjs/swagger';
import { CategoryTotal, MonthEurTotal, MonthTotal } from '../spending-summary';
import { AiUsage } from '../usage-cost';

/**
 * The aggregates are returned alongside the prose on purpose: they are what the
 * report was written from, so a reader who doubts a sentence can check it
 * against the same numbers the model saw.
 */
export class InsightsResponseDto {
  @ApiProperty({ example: '2026-01-01' })
  from: string;

  @ApiProperty({ example: '2026-03-31' })
  to: string;

  @ApiProperty({
    description:
      'The report, in plain prose. A fixed sentence when the period holds no completed receipts.',
    example:
      'You spent 412.30 EUR across 27 receipts between January and March...',
  })
  summary: string;

  @ApiProperty({
    description:
      'Spend per category and currency. A receipt with several categories is counted in full under each, so these totals overlap and do not sum to the period total.',
    example: [
      { category: 'Food', currency: 'EUR', receipts: 14, total: 210.4 },
    ],
  })
  categories: CategoryTotal[];

  @ApiProperty({
    description:
      'Spend per calendar month and currency, counting each receipt exactly once.',
    example: [{ month: '2026-01', currency: 'EUR', receipts: 9, total: 133.2 }],
  })
  months: MonthTotal[];

  @ApiProperty({
    description:
      'Spend per calendar month with every currency converted to EUR, counting each receipt once. The same spending as `months`, not in addition to it. `unconverted` counts receipts left out for lack of a rate.',
    example: [
      { month: '2026-01', receipts: 11, total_eur: 170.1, unconverted: 0 },
    ],
  })
  months_eur: MonthEurTotal[];

  @ApiProperty({
    description:
      'What the model calls made in the period cost, per endpoint and model, from the claude_calls ledger. The period is when each call was made, not the receipt date. Priced in USD when read, each call at the model_prices rate in effect when it was made; calls with no price are left out of cost_usd and counted in unpriced_calls (cost_usd is null when no call on the line had a price). Not shown to the model and not part of the report.',
    example: {
      lines: [
        {
          endpoint: 'text',
          model: 'claude-haiku-4-5',
          calls: 27,
          input_tokens: 48600,
          output_tokens: 21400,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cost_usd: 0.1556,
          unpriced_calls: 0,
        },
      ],
      total_cost_usd: 0.1556,
      unpriced_calls: 0,
    },
  })
  ai_usage: AiUsage;
}
