import { Test } from '@nestjs/testing';
import { ClaudeService } from '../../src/claude/claude.service';
import { ReceiptsRepository } from '../../src/receipts/receipts.repository';
import { ReceiptsService } from '../../src/receipts/receipts.service';

describe('ReceiptsService', () => {
  let service: ReceiptsService;
  let claude: jest.Mocked<ClaudeService>;
  let repository: jest.Mocked<ReceiptsRepository>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReceiptsService,
        {
          provide: ClaudeService,
          useValue: {
            systemPrompt: 'system-prompt',
            pdfSystemPrompt: 'pdf-system-prompt',
            extractReceipt: jest.fn(),
            extractReceiptFromPdf: jest.fn(),
          },
        },
        {
          provide: ReceiptsRepository,
          useValue: {
            createPending: jest.fn(),
            createPendingPdf: jest.fn(),
            completeWithExtraction: jest.fn(),
            markFailed: jest.fn(),
            findById: jest.fn(),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(ReceiptsService);
    claude = moduleRef.get(ClaudeService);
    repository = moduleRef.get(ReceiptsRepository);
  });

  it('saves the extraction and returns the formatted receipt', async () => {
    repository.createPending.mockResolvedValue('receipt-1');
    claude.extractReceipt.mockResolvedValue(extraction());
    repository.findById.mockResolvedValue(record('receipt-1'));

    const result = await service.parseReceipt({
      raw_text:
        'Fresh Grocer Downtown - 12/08/2026. Milk 1.20, Bread 0.80, Coffee 2.50. Total: 4.50 EUR. Visa Card.',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.completeWithExtraction).toHaveBeenCalledWith(
      'receipt-1',
      expect.objectContaining({ merchant: 'Fresh Grocer' }),
      expect.anything(),
    );
    expect(result.total_amount).toBe(4.5);
    expect(result.confidence_score).toBe(0.95);
    expect(result.categories).toEqual(['Food']);
    expect(result.is_suspicious).toBe(false);
    expect(result.flag_reason).toBeNull();
  });

  it('persists the anomaly verdict and returns it', async () => {
    const flagged = {
      ...extraction(),
      is_suspicious: true,
      flag_reason: 'A single steak at 450.00 EUR is implausible.',
    };
    repository.createPending.mockResolvedValue('receipt-5');
    claude.extractReceipt.mockResolvedValue(flagged);
    repository.findById.mockResolvedValue({
      ...record('receipt-5'),
      is_suspicious: true,
      flag_reason: 'A single steak at 450.00 EUR is implausible.',
    });

    const result = await service.parseReceipt({
      raw_text: 'Talho do Bairro - 10/06/2026. Bife 1. Total: 450.00 EUR.',
    });

    // The verdict has to reach the row, not just the response - a flag that is
    // not persisted cannot be reported on later.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.completeWithExtraction).toHaveBeenCalledWith(
      'receipt-5',
      expect.objectContaining({
        is_suspicious: true,
        flag_reason: 'A single steak at 450.00 EUR is implausible.',
      }),
      expect.anything(),
    );
    expect(result.is_suspicious).toBe(true);
    expect(result.flag_reason).toBe(
      'A single steak at 450.00 EUR is implausible.',
    );
  });

  it('marks the receipt as failed when extraction throws', async () => {
    repository.createPending.mockResolvedValue('receipt-2');
    claude.extractReceipt.mockRejectedValue(new Error('boom'));

    await expect(service.parseReceipt({ raw_text: 'broken' })).rejects.toThrow(
      'boom',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.markFailed).toHaveBeenCalledWith('receipt-2');
  });

  it('sends an uploaded PDF to Claude and returns the same response shape', async () => {
    repository.createPendingPdf.mockResolvedValue('receipt-3');
    claude.extractReceiptFromPdf.mockResolvedValue(extraction());
    repository.findById.mockResolvedValue(record('receipt-3'));

    const result = await service.parseReceiptPdf(
      upload('grocer.pdf', '%PDF-1.7 fake receipt'),
    );

    // The file name and size are recorded so a failed row stays traceable, and
    // the PDF prompt is the one stored against it.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.createPendingPdf).toHaveBeenCalledWith(
      'grocer.pdf',
      Buffer.byteLength('%PDF-1.7 fake receipt'),
      'pdf-system-prompt',
    );
    // The buffer must reach Claude base64-encoded, not as raw bytes or a path.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(claude.extractReceiptFromPdf).toHaveBeenCalledWith(
      Buffer.from('%PDF-1.7 fake receipt').toString('base64'),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(claude.extractReceipt).not.toHaveBeenCalled();
    expect(result.total_amount).toBe(4.5);
    expect(result.confidence_score).toBe(0.95);
    expect(result.categories).toEqual(['Food']);
    expect(result.is_suspicious).toBe(false);
    expect(result.flag_reason).toBeNull();
  });

  it('marks the receipt as failed when PDF extraction throws', async () => {
    repository.createPendingPdf.mockResolvedValue('receipt-4');
    claude.extractReceiptFromPdf.mockRejectedValue(new Error('pdf boom'));

    await expect(
      service.parseReceiptPdf(upload('broken.pdf', '%PDF-1.7 truncated')),
    ).rejects.toThrow('pdf boom');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.markFailed).toHaveBeenCalledWith('receipt-4');
  });
});

/** A successful extraction, shared by the text and PDF cases. */
function extraction() {
  return {
    merchant: 'Fresh Grocer',
    location: 'Downtown',
    date: '2026-08-12',
    total_amount: 4.5,
    currency: 'EUR',
    payment_method: 'Card',
    line_items: [
      { description: 'Bananas', quantity: 1, category: 'Food' as const },
    ],
    category_evidence: 'The receipt lists groceries.',
    categories: ['Food' as const],
    confidence_score: 0.95,
    anomaly_evidence: 'A weekday grocery run at 4.50 EUR; nothing is odd.',
    is_suspicious: false,
    flag_reason: null,
  };
}

/** The row `findById` returns once that extraction has been saved. */
function record(id: string) {
  return {
    id,
    merchant: 'Fresh Grocer',
    location: 'Downtown',
    receipt_date: '2026-08-12',
    total_amount: '4.50',
    currency: 'EUR',
    payment_method: 'Card',
    confidence_score: '0.95',
    is_suspicious: false,
    flag_reason: null,
    status: 'completed',
    created_at: new Date('2026-08-12T10:00:00Z'),
    categories: ['Food'],
  };
}

/**
 * A multer upload carrying only the fields the service reads. Validation of the
 * upload itself happens in the controller, so it is covered separately.
 */
function upload(originalname: string, contents: string): Express.Multer.File {
  const buffer = Buffer.from(contents);
  return {
    originalname,
    buffer,
    size: buffer.byteLength,
    mimetype: 'application/pdf',
  } as Express.Multer.File;
}
