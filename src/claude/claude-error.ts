import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * What the Claude API actually answered, normalized for logging and for the
 * `upstream` field of our own error responses.
 */
export interface ClaudeErrorDetails {
  /** How far the request got: a real HTTP response, a timeout, or no connection. */
  transport: 'http' | 'timeout' | 'connection';
  /** HTTP status Anthropic returned, or null when no response arrived. */
  status: number | null;
  /** The `error.type` from Anthropic's body, e.g. "overloaded_error". */
  type: string | null;
  message: string;
  request_id: string | null;
  /** Anthropic's `retry-after` header, in seconds. */
  retry_after: number | null;
  /** Anthropic's own `x-should-retry` hint, falling back to the status class. */
  retryable: boolean;
  /** The raw JSON body Anthropic sent back, when there was one. */
  anthropic_response: unknown;
}

/**
 * A guard rather than a bare `instanceof`: `instanceof` on a generic class
 * widens its type parameters to `any`, which loses the documented types of
 * `status`, `headers` and `error`.
 */
function isApiError(error: unknown): error is APIError {
  return error instanceof APIError;
}

/**
 * Normalizes an Anthropic SDK error. Returns null for anything that did not
 * come from the Claude API, so callers can rethrow those untouched.
 */
export function describeClaudeError(error: unknown): ClaudeErrorDetails | null {
  if (!isApiError(error)) {
    return null;
  }

  const retryAfter = error.headers?.get('retry-after');
  const status = error.status ?? null;

  return {
    transport:
      error instanceof APIConnectionTimeoutError
        ? 'timeout'
        : error instanceof APIConnectionError
          ? 'connection'
          : 'http',
    status,
    type: error.type ?? null,
    message: extractMessage(error),
    request_id: error.requestID ?? null,
    retry_after:
      retryAfter !== null && retryAfter !== undefined
        ? Number(retryAfter)
        : null,
    retryable:
      error.headers?.get('x-should-retry') === 'true' ||
      status === null ||
      status === 408 ||
      status === 429 ||
      status >= 500,
    anthropic_response: error.error ?? null,
  };
}

/**
 * Anthropic's own message, pulled out of the response body. The SDK's
 * `error.message` prefixes the status and inlines the whole JSON body, which is
 * too noisy to hand back to an API client.
 */
function extractMessage(apiError: APIError): string {
  const body: unknown = apiError.error;
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const inner: unknown = body.error;
    if (inner !== null && typeof inner === 'object' && 'message' in inner) {
      const message: unknown = inner.message;
      if (typeof message === 'string') {
        return message;
      }
    }
  }
  return apiError.message;
}

/** A single-line summary of the upstream failure, for the server log. */
export function formatClaudeError(details: ClaudeErrorDetails): string {
  const parts = [
    `transport=${details.transport}`,
    `status=${details.status ?? 'none'}`,
    `type=${details.type ?? 'none'}`,
    `request_id=${details.request_id ?? 'none'}`,
    `retryable=${details.retryable}`,
  ];
  if (details.retry_after !== null) {
    parts.push(`retry_after=${details.retry_after}s`);
  }
  return `Claude API error (${parts.join(', ')}): ${details.message}`;
}

/**
 * Maps a Claude API failure onto the HTTP status our own clients should see.
 *
 * Transient upstream problems (429, 5xx, network) become 429/502/503/504 so a
 * caller knows a retry is worthwhile; problems that a retry cannot fix (bad
 * credentials, wrong model id, a request we built incorrectly) become 500,
 * because they are this service's misconfiguration and not the caller's fault.
 */
export function toHttpException(details: ClaudeErrorDetails): HttpException {
  if (details.transport === 'timeout') {
    return build(
      HttpStatus.GATEWAY_TIMEOUT,
      'The Claude API did not respond in time. Please retry.',
      details,
    );
  }
  if (details.transport === 'connection') {
    return build(
      HttpStatus.BAD_GATEWAY,
      'Could not reach the Claude API. Please retry.',
      details,
    );
  }

  switch (details.status) {
    case 429:
      return build(
        HttpStatus.TOO_MANY_REQUESTS,
        'The Claude API rate limit was reached. Please retry after a short delay.',
        details,
      );
    case 413:
      return build(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'The receipt text is too large for the Claude API.',
        details,
      );
    case 401:
    case 403:
      return build(
        HttpStatus.INTERNAL_SERVER_ERROR,
        "The Claude API rejected this service's credentials.",
        details,
      );
    case 404:
      return build(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'The configured Claude model or endpoint does not exist.',
        details,
      );
    case 400:
    case 422:
      return build(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'The request this service sent to the Claude API was invalid.',
        details,
      );
  }

  // 500, 502, 503, 529 and anything else in the 5xx family: overloaded or down.
  if (details.status !== null && details.status >= 500) {
    return build(
      HttpStatus.SERVICE_UNAVAILABLE,
      details.type === 'overloaded_error'
        ? 'The Claude API is temporarily overloaded. Please retry shortly.'
        : 'The Claude API is temporarily unavailable. Please retry shortly.',
      details,
    );
  }

  return build(
    HttpStatus.BAD_GATEWAY,
    'The Claude API returned an unexpected error.',
    details,
  );
}

function build(
  status: HttpStatus,
  message: string,
  upstream: ClaudeErrorDetails,
): HttpException {
  return new HttpException({ statusCode: status, message, upstream }, status);
}
