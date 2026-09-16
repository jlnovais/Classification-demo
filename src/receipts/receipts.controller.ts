import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { InsightsResponseDto } from './dto/insights-response.dto';
import { ParsedReceiptResponseDto } from './dto/parsed-receipt-response.dto';
import { ParseReceiptPdfDto } from './dto/parse-receipt-pdf.dto';
import { ParseReceiptDto } from './dto/parse-receipt.dto';
import { MAX_PDF_BYTES, validatePdfUpload } from './pdf-file.validation';
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

  @Post('parse-receipt-pdf')
  // The multer limit is the first line of defence: without it the whole upload
  // is buffered into memory before any validator gets a say. `validatePdfUpload`
  // re-checks the size, because multer truncates at the limit instead of failing.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_PDF_BYTES } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: ParseReceiptPdfDto })
  @ApiOperation({
    summary:
      'Extract structured data from a receipt, invoice, or expense note supplied as a PDF.',
    description:
      'Same extraction and categorization as /api/parse-receipt, but the input is a PDF file. ' +
      'The document is sent to Claude directly, so scanned and photographed pages are read too.',
  })
  @ApiResponse({
    status: 201,
    description: 'The receipt was parsed and stored successfully.',
    type: ParsedReceiptResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'No file was uploaded, or the upload is not a PDF (wrong content type, or missing the PDF signature).',
  })
  @ApiResponse({
    status: 413,
    description: 'The PDF is larger than the 10 MB limit.',
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
  async parseReceiptPdf(
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ParsedReceiptResponseDto> {
    return this.receiptsService.parseReceiptPdf(validatePdfUpload(file));
  }

  @Get('insights')
  @ApiOperation({
    summary: 'Write a short report on spending over a period.',
    description:
      'Aggregates the completed receipts dated inside the period and has Claude write about the totals. ' +
      'The model is given the aggregates only, never the receipts, and the same aggregates are returned ' +
      'alongside the report so every figure in it can be checked.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The report, plus the aggregates it was written from. A period with no completed receipts returns a fixed sentence and costs no tokens.',
    type: InsightsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error: a missing or malformed date, or "from" later than "to".',
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
  async insights(
    @Query() query: InsightsQueryDto,
  ): Promise<InsightsResponseDto> {
    return this.receiptsService.insights(query);
  }
}
