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
            extractReceipt: jest.fn(),
          },
        },
        {
          provide: ReceiptsRepository,
          useValue: {
            createPending: jest.fn(),
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
    claude.extractReceipt.mockResolvedValue({
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
      categories: ['Food'],
      confidence_score: 0.95,
    });
    repository.findById.mockResolvedValue({
      id: 'receipt-1',
      merchant: 'Fresh Grocer',
      location: 'Downtown',
      receipt_date: '2026-08-12',
      total_amount: '4.50',
      currency: 'EUR',
      payment_method: 'Card',
      confidence_score: '0.95',
      status: 'completed',
      created_at: new Date('2026-08-12T10:00:00Z'),
      categories: ['Food'],
    });

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
});
