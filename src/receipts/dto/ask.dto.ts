import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AskDto {
  @ApiProperty({
    description: 'A question about the receipt history, in plain language.',
    example: 'Quanto gastei em comida nos últimos 3 meses?',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  question: string;
}
