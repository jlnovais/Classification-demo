import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  ClaudeService,
  ExtractedReceipt,
  ImageMediaType,
} from '../claude/claude.service';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { InsightsResponseDto } from './dto/insights-response.dto';
import { ParsedReceiptResponseDto } from './dto/parsed-receipt-response.dto';
import { ParseReceiptDto } from './dto/parse-receipt.dto';
import { assessHistory } from './history-anomalies';
import { ReceiptRecord, ReceiptsRepository } from './receipts.repository';
import { isEmpty, renderSummary } from './spending-summary';

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly claude: ClaudeService,
    private readonly repository: ReceiptsRepository,
  ) {}

  async parseReceipt(dto: ParseReceiptDto): Promise<ParsedReceiptResponseDto> {
    const receiptId = await this.repository.createPending(
      dto.raw_text,
      this.claude.systemPrompt,
    );

    return this.extractInto(receiptId, () =>
      this.claude.extractReceipt(dto.raw_text),
    );
  }

  /**
   * The PDF counterpart of `parseReceipt`. The file is handed to Claude as-is,
   * so there is no text-extraction step here; everything after the extraction
   * call - persistence, category linking, failure bookkeeping, the response
   * shape - is the same code path as the text endpoint.
   */
  async parseReceiptPdf(
    file: Express.Multer.File,
  ): Promise<ParsedReceiptResponseDto> {
    const receiptId = await this.repository.createPendingUpload(
      'pdf',
      file.originalname,
      file.size,
      this.claude.pdfSystemPrompt,
    );

    const pdfBase64 = file.buffer.toString('base64');
    return this.extractInto(receiptId, () =>
      this.claude.extractReceiptFromPdf(pdfBase64),
    );
  }

  /**
   * The photo counterpart. Structurally identical to the PDF path - the only
   * difference that reaches this layer is the media type, which the validator
   * read out of the file's own bytes and which travels with the image block.
   */
  async parseReceiptImage(
    file: Express.Multer.File,
    mediaType: ImageMediaType,
  ): Promise<ParsedReceiptResponseDto> {
    const receiptId = await this.repository.createPendingUpload(
      'image',
      file.originalname,
      file.size,
      this.claude.imageSystemPrompt,
    );

    const imageBase64 = file.buffer.toString('base64');
    return this.extractInto(receiptId, () =>
      this.claude.extractReceiptFromImage(imageBase64, mediaType),
    );
  }

  /**
   * The insights report. The model never sees a receipt here - SQL aggregates
   * the period first and the model writes about the totals, which is what keeps
   * it from inventing figures it would otherwise have to add up itself.
   */
  async insights(query: InsightsQueryDto): Promise<InsightsResponseDto> {
    const from = isoDay(query.from);
    const to = isoDay(query.to);
    if (from > to) {
      throw new BadRequestException('"from" must not be later than "to"');
    }

    const summary = await this.repository.spendingSummary(from, to);

    // An empty period is answered without an API call: there is nothing for the
    // model to write about, and asking it anyway spends tokens to be told so.
    const report = isEmpty(summary)
      ? 'No completed receipts fall in this period, so there is nothing to report on.'
      : await this.claude.summarizeSpending(renderSummary(summary));

    return { ...summary, summary: report };
  }

  /**
   * Runs an extraction against an already-pending receipt row and saves the
   * result. Shared by both endpoints so a failure is recorded the same way
   * whatever the input was.
   */
  private async extractInto(
    receiptId: string,
    extract: () => Promise<ExtractedReceipt>,
  ): Promise<ParsedReceiptResponseDto> {
    try {
      const extracted = await extract();

      // The history checks run between extraction and persistence, which is the
      // only point where both are available: they need the finished extraction
      // to build a deduplication key from, and their verdict has to be part of
      // the row rather than an update after it.
      const verdict = assessHistory(
        extracted,
        await this.repository.findHistory(receiptId, extracted),
      );

      await this.repository.completeWithExtraction(
        receiptId,
        extracted,
        extracted,
        verdict,
      );

      const record = await this.repository.findById(receiptId);
      if (!record) {
        throw new InternalServerErrorException(
          'Receipt was saved but could not be reloaded',
        );
      }

      return this.toResponse(record);
    } catch (error) {
      await this.repository.markFailed(receiptId);
      throw error;
    }
  }

  private toResponse(record: ReceiptRecord): ParsedReceiptResponseDto {
    return {
      id: record.id,
      merchant: record.merchant,
      location: record.location,
      date: record.receipt_date,
      total_amount:
        record.total_amount !== null ? Number(record.total_amount) : null,
      currency: record.currency,
      categories: record.categories,
      payment_method: record.payment_method,
      confidence_score:
        record.confidence_score !== null
          ? Number(record.confidence_score)
          : null,
      is_suspicious: record.is_suspicious,
      flag_reason: record.flag_reason,
      duplicate_of: record.duplicate_of,
      status: record.status,
      created_at: record.created_at,
    };
  }
}

/**
 * `IsDateString` also accepts a full timestamp, so the date part is taken
 * explicitly rather than passed on: the queries compare against `::date`, and a
 * time component would otherwise reach the report's heading unchanged.
 */
function isoDay(date: string): string {
  return date.slice(0, 10);
}
