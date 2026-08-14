import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ParsedReceiptResponseDto } from './dto/parsed-receipt-response.dto';
import { ParseReceiptDto } from './dto/parse-receipt.dto';
import { ReceiptsService } from './receipts.service';

@ApiTags('receipts')
@Controller('api')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Post('parse-receipt')
  @ApiOperation({
    summary:
      'Extract structured data from a free-text receipt, invoice, or expense note.',
  })
  @ApiResponse({
    status: 201,
    description: 'The receipt was parsed and stored successfully.',
    type: ParsedReceiptResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error (e.g. missing or empty raw_text).',
  })
  async parseReceipt(
    @Body() dto: ParseReceiptDto,
  ): Promise<ParsedReceiptResponseDto> {
    return this.receiptsService.parseReceipt(dto);
  }
}
