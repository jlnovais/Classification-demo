import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ParseReceiptDto {
  @ApiProperty({
    description:
      'Raw free-text content of a receipt, invoice, or expense note.',
    example:
      'Fresh Grocer Downtown - 12/08/2026. Milk 1.20, Bread 0.80, Coffee 2.50. Total: 4.50 EUR. Visa Card.',
    maxLength: 10000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  raw_text: string;
}
