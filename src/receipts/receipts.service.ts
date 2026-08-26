import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ClaudeService, ExtractedReceipt } from '../claude/claude.service';
import { ParsedReceiptResponseDto } from './dto/parsed-receipt-response.dto';
import { ParseReceiptDto } from './dto/parse-receipt.dto';
import { assessHistory } from './history-anomalies';
import { ReceiptRecord, ReceiptsRepository } from './receipts.repository';

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
    const receiptId = await this.repository.createPendingPdf(
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
