import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  ClaudeService,
  ClaudeUsage,
  ExtractedReceipt,
  ImageMediaType,
  ReceiptSource,
} from '../claude/claude.service';
import { AskDto } from './dto/ask.dto';
import { AskResponseDto } from './dto/ask-response.dto';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { InsightsResponseDto } from './dto/insights-response.dto';
import { ParsedReceiptResponseDto } from './dto/parsed-receipt-response.dto';
import { ParseReceiptDto } from './dto/parse-receipt.dto';
import { FxService } from './fx.service';
import { assessHistory } from './history-anomalies';
import { QueryLog, parseQueryArgs } from './receipt-query';
import {
  ClaudeEndpoint,
  ReceiptRecord,
  ReceiptsRepository,
} from './receipts.repository';
import { isEmpty, renderSummary } from './spending-summary';
import { summarizeUsage } from './usage-cost';

@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);

  constructor(
    private readonly claude: ClaudeService,
    private readonly repository: ReceiptsRepository,
    private readonly fx: FxService,
  ) {}

  async parseReceipt(dto: ParseReceiptDto): Promise<ParsedReceiptResponseDto> {
    const receiptId = await this.repository.createPending(
      dto.raw_text,
      this.claude.systemPrompt,
    );

    return this.extractInto(receiptId, 'text', (calls) =>
      this.claude.extractReceipt(dto.raw_text, calls),
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
    return this.extractInto(receiptId, 'pdf', (calls) =>
      this.claude.extractReceiptFromPdf(pdfBase64, calls),
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
    return this.extractInto(receiptId, 'image', (calls) =>
      this.claude.extractReceiptFromImage(imageBase64, mediaType, calls),
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

    // The AI's own cost rides along with the aggregates but is never rendered
    // into the model's block: the report is about the user's spending, and a
    // USD figure next to the EUR lines is one more thing to add up wrongly.
    // This request's own call is not in it - it is recorded after it returns.
    const [summary, usageRows] = await Promise.all([
      this.repository.spendingSummary(from, to),
      this.repository.usageSummary(from, to),
    ]);
    const ai_usage = summarizeUsage(usageRows);

    // An empty period is answered without an API call: there is nothing for the
    // model to write about, and asking it anyway spends tokens to be told so.
    if (isEmpty(summary)) {
      return {
        ...summary,
        ai_usage,
        summary:
          'No completed receipts fall in this period, so there is nothing to report on.',
      };
    }

    const calls: ClaudeUsage[] = [];
    try {
      const report = await this.claude.summarizeSpending(
        renderSummary(summary),
        calls,
      );
      return { ...summary, ai_usage, summary: report };
    } finally {
      await this.recordCalls('insights', null, calls);
    }
  }

  /**
   * Answers a question about the history. The model decides which queries to
   * run; this is the side that runs them - validated first, so an argument the
   * model got wrong goes back to it as an error rather than into the database.
   * Every call is recorded, rejected ones included, and returned with the answer.
   */
  async ask(dto: AskDto): Promise<AskResponseDto> {
    const queries: QueryLog[] = [];
    const calls: ClaudeUsage[] = [];
    const today = new Date().toISOString().slice(0, 10);

    try {
      const answer = await this.claude.answerQuestion(
        dto.question,
        today,
        async (input) => {
          const parsed = parseQueryArgs(input);
          if (!parsed.ok) {
            queries.push({ input, error: parsed.error });
            return { content: parsed.error, is_error: true };
          }

          const result = await this.repository.queryReceipts(parsed.args);
          queries.push({ input, result });
          return { content: JSON.stringify(result), is_error: false };
        },
        calls,
      );

      return { answer, queries };
    } finally {
      // One row per round of the loop - a question that needed two tool calls
      // and a final answer was billed three times.
      await this.recordCalls('ask', null, calls);
    }
  }

  /**
   * Writes the usage ledger. A failure here is logged, not thrown: the ledger
   * is observability, and losing a row of it must not fail a receipt that was
   * extracted and saved, nor mask the error a `finally` is already carrying.
   */
  private async recordCalls(
    endpoint: ClaudeEndpoint,
    receiptId: string | null,
    calls: ClaudeUsage[],
  ): Promise<void> {
    try {
      await this.repository.recordCalls(endpoint, receiptId, calls);
    } catch (error) {
      this.logger.error(
        `Could not record ${calls.length} Claude call(s) for ${endpoint}` +
          `${receiptId ? ` (receipt ${receiptId})` : ''}: ${String(error)}`,
      );
    }
  }

  /**
   * Runs an extraction against an already-pending receipt row and saves the
   * result. Shared by all three endpoints so a failure is recorded the same way
   * whatever the input was.
   *
   * The call's usage is written in `finally`, linked to the receipt either way:
   * a truncated or refused extraction still cost tokens, and its failed row is
   * where they belong.
   */
  private async extractInto(
    receiptId: string,
    source: ReceiptSource,
    extract: (calls: ClaudeUsage[]) => Promise<ExtractedReceipt>,
  ): Promise<ParsedReceiptResponseDto> {
    const calls: ClaudeUsage[] = [];
    try {
      const extracted = await extract(calls);

      // The history checks run between extraction and persistence, which is the
      // only point where both are available: they need the finished extraction
      // to build a deduplication key from, and their verdict has to be part of
      // the row rather than an update after it.
      // The FX lookup is independent of the history, so the two run together.
      // No total or no currency means nothing to convert - no lookup at all.
      const [history, rate] = await Promise.all([
        this.repository.findHistory(receiptId, extracted),
        extracted.total_amount !== null && extracted.currency
          ? this.fx.rateToEur(extracted.currency, extracted.date)
          : null,
      ]);
      const verdict = assessHistory(extracted, history);

      const totalEur =
        extracted.total_amount !== null && rate !== null
          ? extracted.total_amount * rate.rate
          : null;

      await this.repository.completeWithExtraction(
        receiptId,
        extracted,
        extracted,
        verdict,
        rate,
        totalEur,
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
    } finally {
      await this.recordCalls(source, receiptId, calls);
    }
  }

  private toResponse(record: ReceiptRecord): ParsedReceiptResponseDto {
    return {
      id: record.id,
      merchant: record.merchant,
      merchant_details: record.merchant_details,
      merchant_vatNumber: record.merchant_vatNumber,
      merchant_phone: record.merchant_phone,
      invoice_number: record.invoice_number,
      location: record.location,
      date: record.receipt_date,
      total_amount:
        record.total_amount !== null ? Number(record.total_amount) : null,
      currency: record.currency,
      total_eur: record.total_eur !== null ? Number(record.total_eur) : null,
      fx_rate: record.fx_rate !== null ? Number(record.fx_rate) : null,
      fx_date: record.fx_date,
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
