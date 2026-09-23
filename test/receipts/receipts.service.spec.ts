import { Test } from '@nestjs/testing';
import { ClaudeService } from '../../src/claude/claude.service';
import { FxService } from '../../src/receipts/fx.service';
import { ReceiptsRepository } from '../../src/receipts/receipts.repository';
import { ReceiptsService } from '../../src/receipts/receipts.service';

describe('ReceiptsService', () => {
  let service: ReceiptsService;
  let claude: jest.Mocked<ClaudeService>;
  let repository: jest.Mocked<ReceiptsRepository>;
  let fx: jest.Mocked<FxService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReceiptsService,
        {
          provide: ClaudeService,
          useValue: {
            systemPrompt: 'system-prompt',
            pdfSystemPrompt: 'pdf-system-prompt',
            imageSystemPrompt: 'image-system-prompt',
            extractReceipt: jest.fn(),
            extractReceiptFromPdf: jest.fn(),
            extractReceiptFromImage: jest.fn(),
            summarizeSpending: jest.fn(),
          },
        },
        {
          provide: ReceiptsRepository,
          useValue: {
            createPending: jest.fn(),
            createPendingUpload: jest.fn(),
            completeWithExtraction: jest.fn(),
            markFailed: jest.fn(),
            findById: jest.fn(),
            // Defaulted to an empty history so the cases that are not about the
            // history checks read as if the database were empty.
            findHistory: jest
              .fn()
              .mockResolvedValue({ duplicate: null, spreads: [] }),
            spendingSummary: jest.fn(),
          },
        },
        {
          provide: FxService,
          // The fixtures are EUR receipts, so the identity rate is the default.
          useValue: {
            rateToEur: jest
              .fn()
              .mockResolvedValue({ rate: 1, date: '2026-08-12' }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(ReceiptsService);
    claude = moduleRef.get(ClaudeService);
    repository = moduleRef.get(ReceiptsRepository);
    fx = moduleRef.get(FxService);
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
      { is_suspicious: false, flag_reason: null, duplicate_of: null },
      { rate: 1, date: '2026-08-12' },
    );
    expect(result.total_amount).toBe(4.5);
    expect(result.total_eur).toBe(4.5);
    expect(result.fx_rate).toBe(1);
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
      expect.anything(),
      expect.anything(),
      {
        is_suspicious: true,
        flag_reason: 'A single steak at 450.00 EUR is implausible.',
        duplicate_of: null,
      },
      expect.anything(),
    );
    expect(result.is_suspicious).toBe(true);
    expect(result.flag_reason).toBe(
      'A single steak at 450.00 EUR is implausible.',
    );
  });

  it('flags a receipt that repeats an earlier submission and records which one', async () => {
    repository.createPending.mockResolvedValue('receipt-6');
    claude.extractReceipt.mockResolvedValue(extraction());
    repository.findHistory.mockResolvedValue({
      duplicate: {
        id: 'receipt-1',
        created_at: new Date('2026-08-12T10:00:00Z'),
      },
      spreads: [],
    });
    repository.findById.mockResolvedValue(record('receipt-6'));

    await service.parseReceipt({ raw_text: 'Fresh Grocer Downtown 4.50 EUR' });

    // The history is looked up for the row being written, so the receipt cannot
    // match itself, and the matched id is persisted alongside the sentence.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.findHistory).toHaveBeenCalledWith(
      'receipt-6',
      expect.objectContaining({ merchant: 'Fresh Grocer' }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.completeWithExtraction).toHaveBeenCalledWith(
      'receipt-6',
      expect.anything(),
      expect.anything(),
      {
        is_suspicious: true,
        flag_reason:
          'Same merchant, date and total as receipt receipt-1, submitted on ' +
          '2026-08-12; possible duplicate submission.',
        duplicate_of: 'receipt-1',
      },
      expect.anything(),
    );
  });

  it('keeps the model verdict and the duplicate reason when both fire', async () => {
    repository.createPending.mockResolvedValue('receipt-7');
    claude.extractReceipt.mockResolvedValue({
      ...extraction(),
      is_suspicious: true,
      flag_reason: 'The total does not reconcile with the item lines',
    });
    repository.findHistory.mockResolvedValue({
      duplicate: {
        id: 'receipt-1',
        created_at: new Date('2026-08-12T10:00:00Z'),
      },
      spreads: [],
    });
    repository.findById.mockResolvedValue(record('receipt-7'));

    await service.parseReceipt({ raw_text: 'Fresh Grocer Downtown 4.50 EUR' });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.completeWithExtraction).toHaveBeenCalledWith(
      'receipt-7',
      expect.anything(),
      expect.anything(),
      {
        is_suspicious: true,
        flag_reason:
          'The total does not reconcile with the item lines. Same merchant, ' +
          'date and total as receipt receipt-1, submitted on 2026-08-12; ' +
          'possible duplicate submission.',
        duplicate_of: 'receipt-1',
      },
      expect.anything(),
    );
  });

  it('completes the receipt without a conversion when the rate lookup fails', async () => {
    repository.createPending.mockResolvedValue('receipt-10');
    claude.extractReceipt.mockResolvedValue({
      ...extraction(),
      currency: 'USD',
    });
    fx.rateToEur.mockResolvedValue(null);
    repository.findById.mockResolvedValue(record('receipt-10'));

    await service.parseReceipt({ raw_text: 'Fresh Grocer 4.50 USD' });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(fx.rateToEur).toHaveBeenCalledWith('USD', '2026-08-12');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.completeWithExtraction).toHaveBeenCalledWith(
      'receipt-10',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      null,
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it('skips the rate lookup when there is no currency to convert from', async () => {
    repository.createPending.mockResolvedValue('receipt-11');
    claude.extractReceipt.mockResolvedValue({
      ...extraction(),
      currency: null,
    });
    repository.findById.mockResolvedValue(record('receipt-11'));

    await service.parseReceipt({ raw_text: 'Fresh Grocer 4.50' });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(fx.rateToEur).not.toHaveBeenCalled();
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
    repository.createPendingUpload.mockResolvedValue('receipt-3');
    claude.extractReceiptFromPdf.mockResolvedValue(extraction());
    repository.findById.mockResolvedValue(record('receipt-3'));

    const result = await service.parseReceiptPdf(
      upload('grocer.pdf', '%PDF-1.7 fake receipt'),
    );

    // The file name and size are recorded so a failed row stays traceable, and
    // the PDF prompt is the one stored against it.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.createPendingUpload).toHaveBeenCalledWith(
      'pdf',
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
    repository.createPendingUpload.mockResolvedValue('receipt-4');
    claude.extractReceiptFromPdf.mockRejectedValue(new Error('pdf boom'));

    await expect(
      service.parseReceiptPdf(upload('broken.pdf', '%PDF-1.7 truncated')),
    ).rejects.toThrow('pdf boom');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.markFailed).toHaveBeenCalledWith('receipt-4');
  });

  it('sends an uploaded photo to Claude with its media type', async () => {
    repository.createPendingUpload.mockResolvedValue('receipt-8');
    claude.extractReceiptFromImage.mockResolvedValue(extraction());
    repository.findById.mockResolvedValue(record('receipt-8'));

    const result = await service.parseReceiptImage(
      upload('grocer.jpg', 'fake jpeg bytes', 'image/jpeg'),
      'image/jpeg',
    );

    // The row records the source as an image and stores the image prompt, so a
    // failed photo is distinguishable from a failed PDF after the fact.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.createPendingUpload).toHaveBeenCalledWith(
      'image',
      'grocer.jpg',
      Buffer.byteLength('fake jpeg bytes'),
      'image-system-prompt',
    );
    // The media type travels with the image block; the buffer is base64.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(claude.extractReceiptFromImage).toHaveBeenCalledWith(
      Buffer.from('fake jpeg bytes').toString('base64'),
      'image/jpeg',
    );
    // Everything after the extraction is the shared tail, so a photo comes back
    // in exactly the shape the other two endpoints return.
    expect(result.total_amount).toBe(4.5);
    expect(result.categories).toEqual(['Food']);
    expect(result.is_suspicious).toBe(false);
  });

  it('marks the receipt as failed when photo extraction throws', async () => {
    repository.createPendingUpload.mockResolvedValue('receipt-9');
    claude.extractReceiptFromImage.mockRejectedValue(new Error('photo boom'));

    await expect(
      service.parseReceiptImage(
        upload('blurred.jpg', 'unreadable', 'image/jpeg'),
        'image/jpeg',
      ),
    ).rejects.toThrow('photo boom');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.markFailed).toHaveBeenCalledWith('receipt-9');
  });

  it('writes the report from the aggregates and returns both', async () => {
    repository.spendingSummary.mockResolvedValue({
      from: '2026-01-01',
      to: '2026-03-31',
      months: [
        { month: '2026-01', currency: 'EUR', receipts: 9, total: 133.2 },
      ],
      categories: [
        { category: 'Food', currency: 'EUR', receipts: 14, total: 210.4 },
      ],
      months_eur: [],
    });
    claude.summarizeSpending.mockResolvedValue('You spent 133.20 EUR.');

    const result = await service.insights({
      from: '2026-01-01',
      to: '2026-03-31',
    });

    // The model is handed the rendered aggregates, never the receipts.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(claude.summarizeSpending).toHaveBeenCalledWith(
      expect.stringContaining('- 2026-01: 133.20 EUR over 9 receipts'),
    );
    expect(result.summary).toBe('You spent 133.20 EUR.');
    expect(result.months).toHaveLength(1);
  });

  it('answers an empty period without spending a token', async () => {
    repository.spendingSummary.mockResolvedValue({
      from: '2026-01-01',
      to: '2026-03-31',
      months: [],
      categories: [],
      months_eur: [],
    });

    const result = await service.insights({
      from: '2026-01-01',
      to: '2026-03-31',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(claude.summarizeSpending).not.toHaveBeenCalled();
    expect(result.summary).toContain('nothing to report');
  });

  it('rejects a reversed period before querying anything', async () => {
    await expect(
      service.insights({ from: '2026-03-31', to: '2026-01-01' }),
    ).rejects.toThrow('"from" must not be later than "to"');

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.Mocked property, not a real unbound method
    expect(repository.spendingSummary).not.toHaveBeenCalled();
  });
});

/** A successful extraction, shared by the text and PDF cases. */
function extraction() {
  return {
    merchant: 'Fresh Grocer',
    merchant_details: 'Fresh Grocer Lda, Rua do Comercio 12, Lisboa',
    merchant_vatNumber: 'PT501234567',
    merchant_phone: '+351 210 000 000',
    invoice_number: 'FT 2026/1234',
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
    merchant_details: 'Fresh Grocer Lda, Rua do Comercio 12, Lisboa',
    merchant_vatNumber: 'PT501234567',
    merchant_phone: '+351 210 000 000',
    invoice_number: 'FT 2026/1234',
    location: 'Downtown',
    receipt_date: '2026-08-12',
    total_amount: '4.50',
    currency: 'EUR',
    total_eur: '4.50',
    fx_rate: '1.00000000',
    fx_date: '2026-08-12',
    payment_method: 'Card',
    confidence_score: '0.95',
    is_suspicious: false,
    flag_reason: null,
    duplicate_of: null,
    status: 'completed',
    created_at: new Date('2026-08-12T10:00:00Z'),
    categories: ['Food'],
  };
}

/**
 * A multer upload carrying only the fields the service reads. Validation of the
 * upload itself happens in the controller, so it is covered separately.
 */
function upload(
  originalname: string,
  contents: string,
  mimetype = 'application/pdf',
): Express.Multer.File {
  const buffer = Buffer.from(contents);
  return {
    originalname,
    buffer,
    size: buffer.byteLength,
    mimetype,
  } as Express.Multer.File;
}
