import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ClaudeService } from '../claude/claude.service';
import { ParsedReceiptResponseDto } from './dto/parsed-receipt-response.dto';
import { ParseReceiptDto } from './dto/parse-receipt.dto';
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

    try {
      const extracted = await this.claude.extractReceipt(dto.raw_text);
      await this.repository.completeWithExtraction(
        receiptId,
        extracted,
        extracted,
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
      status: record.status,
      created_at: record.created_at,
    };
  }
}
