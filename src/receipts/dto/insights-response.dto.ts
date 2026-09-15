import { ApiProperty } from '@nestjs/swagger';
import { CategoryTotal, MonthTotal } from '../spending-summary';

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
}
