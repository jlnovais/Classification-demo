import { ConfigService } from '@nestjs/config';
import { FxService } from '../../src/receipts/fx.service';

describe('FxService', () => {
  const fx = new FxService(new ConfigService({}));
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('answers EUR without a network call', async () => {
    await expect(fx.rateToEur('eur', '2026-08-12')).resolves.toEqual({
      rate: 1,
      date: '2026-08-12',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for the rate on the receipt date and returns the provider date', async () => {
    // A Saturday receipt: the ECB has no weekend rate, so the provider answers
    // with Friday's, and that is the date that has to be kept.
    fetchMock.mockResolvedValue(
      Response.json({
        amount: 1,
        base: 'USD',
        date: '2024-03-15',
        rates: { EUR: 0.91811 },
      }),
    );

    await expect(fx.rateToEur('usd', '2024-03-16')).resolves.toEqual({
      rate: 0.91811,
      date: '2024-03-15',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.frankfurter.dev/v1/2024-03-16?base=USD&symbols=EUR&amount=1',
      expect.anything(),
    );
  });

  it('uses the latest rate for an undated receipt', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ date: '2026-09-22', rates: { EUR: 0.85 } }),
    );

    await fx.rateToEur('USD', null);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/latest?base=USD'),
      expect.anything(),
    );
  });

  it('returns null for a currency the provider does not know', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(fx.rateToEur('XXX', '2026-08-12')).resolves.toBeNull();
  });

  it('returns null instead of throwing when the provider is unreachable', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(fx.rateToEur('USD', '2026-08-12')).resolves.toBeNull();
  });
});
