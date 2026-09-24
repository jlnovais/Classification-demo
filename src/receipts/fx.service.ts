import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FxRate {
  /** Multiply an amount in the source currency by this to get EUR. */
  rate: number;
  /** The day the rate applies to - the provider's nearest business day. */
  date: string;
}

// ECB reference rates, free and keyless. Historical by date, which is what a
// receipt needs: a March trip converts at March's rate, not today's.

@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);

  private readonly fxUrl: string;
  private readonly fxTimeout: number;

  constructor(config: ConfigService) {
    this.fxUrl = config.get<string>(
      'FX_API_URL_TEMPLATE',
      'https://api.frankfurter.dev/v1/{date}?base={base}&symbols={symbols}&amount={amount}',
    );
    this.fxTimeout = config.get<number>('FX_API_TIMEOUT_MS', 5000);
  }

  /**
   * The rate from `currency` to EUR on `date` (or the latest rate when the
   * receipt is undated). Returns null rather than throwing on any failure - an
   * unknown currency, a timeout, the provider being down - because a missing
   * conversion must not fail an otherwise good extraction.
   */
  async rateToEur(
    currency: string,
    date: string | null,
  ): Promise<FxRate | null> {
    const base = currency.trim().toUpperCase();
    if (base === 'EUR') {
      this.logger.debug(`No need to FX lookup for EUR`);
      return {
        rate: 1,
        date: date ?? today(),
      };
    }

    const url = this.fxUrl
      .replace('{date}', date ?? 'latest')
      .replace('{base}', encodeURIComponent(base))
      .replace('{symbols}', 'EUR')
      .replace('{amount}', '1');

    this.logger.debug(`FX lookup: ${url}`);

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this.fxTimeout),
      });
      if (!response.ok) {
        this.logger.warn(
          `FX lookup ${base} ${date} -> HTTP ${response.status}`,
        );
        return null;
      }

      const body = (await response.json()) as {
        date?: string;
        rates?: { EUR?: number };
      };
      const rate = body.rates?.EUR;
      if (typeof rate !== 'number' || !body.date) return null;

      return { rate, date: body.date };
    } catch (error) {
      this.logger.warn(`FX lookup ${base} ${date} failed: ${String(error)}`);
      return null;
    }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
