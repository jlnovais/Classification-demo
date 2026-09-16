import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class InsightsQueryDto {
  @ApiProperty({
    description: 'Start of the period, inclusive. ISO 8601 date (YYYY-MM-DD).',
    example: '2026-01-01',
  })
  // `strict: true` rejects '2026-13-40' and the looser datetime shapes; the
  // dates go straight into a `::date` cast, so an impossible one is a 400 here
  // rather than a 500 from PostgreSQL.
  @IsDateString({ strict: true })
  from: string;

  @ApiProperty({
    description: 'End of the period, inclusive. ISO 8601 date (YYYY-MM-DD).',
    example: '2026-03-31',
  })
  @IsDateString({ strict: true })
  to: string;
}
