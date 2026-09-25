import { ApiProperty } from '@nestjs/swagger';
import { QueryLog } from '../receipt-query';

/**
 * The queries are returned alongside the answer for the same reason the
 * insights aggregates are: every figure in the answer can be checked against
 * the tool results the model was given.
 */
export class AskResponseDto {
  @ApiProperty({
    description: 'The answer, in plain prose.',
    example:
      'Entre 25 de junho e 25 de setembro gastou 312.40 EUR em comida, em 21 recibos.',
  })
  answer: string;

  @ApiProperty({
    description:
      'Every query_receipts call the model made, in order: the arguments it chose, and either the totals it got back or the validation error that rejected them.',
    example: [
      {
        input: {
          from: '2026-06-25',
          to: '2026-09-25',
          categories: ['Food'],
          merchant: null,
          min_total: null,
          max_total: null,
        },
        result: [
          {
            currency: 'EUR',
            receipts: 21,
            total: 312.4,
            total_eur: 312.4,
            unconverted: 0,
          },
        ],
      },
    ],
  })
  queries: QueryLog[];
}
