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
  @ApiResponse({
    status: 429,
    description:
      'The Claude API rate limit was reached. The response body carries the upstream details.',
  })
  @ApiResponse({
    status: 503,
    description:
      'The Claude API is overloaded or unavailable. Safe to retry; the response body carries the upstream details.',
  })
  async parseReceipt(
    @Body() dto: ParseReceiptDto,
  ): Promise<ParsedReceiptResponseDto> {
    return this.receiptsService.parseReceipt(dto);
  }
}
