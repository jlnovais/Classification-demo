import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ParsedReceiptResponseDto {
  @ApiProperty({
    example: 'e2b1c1d0-1234-4a56-9abc-1234567890ab',
    description: 'Internal receipt identifier.',
  })
  id: string;

  @ApiPropertyOptional({
    example: 'Fresh Grocer',
    nullable: true,
    description: 'Store or business name.',
  })
  merchant: string | null;

  @ApiPropertyOptional({
    example: 'Downtown',
    nullable: true,
    description: 'City or place mentioned in the receipt.',
  })
  location: string | null;

  @ApiPropertyOptional({
    example: '2026-08-12',
    nullable: true,
    description: 'ISO 8601 date (YYYY-MM-DD) of the receipt.',
  })
  date: string | null;

  @ApiPropertyOptional({
    example: 4.5,
    nullable: true,
    description: 'Final total paid.',
  })
  total_amount: number | null;

  @ApiPropertyOptional({
    example: 'EUR',
    nullable: true,
    description: 'ISO 4217 currency code.',
  })
  currency: string | null;

  @ApiProperty({
    example: ['Food'],
    type: [String],
    description: 'One or more expense categories associated with this receipt.',
  })
  categories: string[];

  @ApiPropertyOptional({
    example: 'Card',
    nullable: true,
    description: 'Normalized payment method.',
  })
  payment_method: string | null;

  @ApiPropertyOptional({
    example: 0.95,
    nullable: true,
    description: 'Model confidence in the extraction, between 0 and 1.',
  })
  confidence_score: number | null;

  @ApiProperty({
    example: false,
    description:
      'True when at least one anomaly check fired: an atypical amount for the ' +
      'categories present, items that do not fit the merchant, a total that ' +
      'does not reconcile with the item lines, a missing total or date, or a ' +
      'receipt issued at the weekend.',
  })
  is_suspicious: boolean;

  @ApiPropertyOptional({
    example:
      'A single cut of meat at 450.00 EUR is far above a normal butcher price.',
    nullable: true,
    description:
      'Why the receipt was flagged. Null when is_suspicious is false.',
  })
  flag_reason: string | null;

  @ApiProperty({
    example: 'completed',
    enum: ['pending', 'completed', 'failed'],
  })
  status: string;

  @ApiProperty({ example: '2026-08-12T10:00:00.000Z' })
  created_at: Date;
}
