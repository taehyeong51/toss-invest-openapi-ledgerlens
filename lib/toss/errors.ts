import type { TossApiErrorBody, TossOAuthErrorBody } from "./types";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function safeString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

export function sanitizeRequestId(value: unknown): string | undefined {
  const requestId = safeString(value, 128);
  return requestId && SAFE_REQUEST_ID.test(requestId) ? requestId : undefined;
}

export class TossApiError extends Error {
  readonly code: string;
  readonly upstreamStatus: number | null;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(options: {
    code: string;
    message: string;
    upstreamStatus?: number | null;
    requestId?: string;
    retryAfterSeconds?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "TossApiError";
    this.code = options.code;
    this.upstreamStatus = options.upstreamStatus ?? null;
    this.requestId = sanitizeRequestId(options.requestId);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export async function tossErrorFromResponse(response: Response): Promise<TossApiError> {
  let body: TossApiErrorBody | TossOAuthErrorBody | undefined;
  try {
    body = (await response.json()) as TossApiErrorBody | TossOAuthErrorBody;
  } catch {
    body = undefined;
  }

  const apiError = body && "error" in body && typeof body.error === "object"
    ? (body as TossApiErrorBody).error
    : undefined;
  const oauthCode = body && "error" in body && typeof body.error === "string"
    ? safeString(body.error, 100)
    : undefined;
  const code = safeString(apiError?.code, 100) ?? oauthCode ?? `http-${response.status}`;
  const requestId = sanitizeRequestId(apiError?.requestId);
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterValue = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
  const retryAfterSeconds = Number.isSafeInteger(retryAfterValue) && retryAfterValue >= 0
    ? Math.min(retryAfterValue, 3_600)
    : undefined;

  // Deliberately do not surface the upstream message or data: they are not
  // required by callers and may contain implementation details.
  return new TossApiError({
    code,
    message: `Toss API request failed with status ${response.status}.`,
    upstreamStatus: response.status,
    requestId,
    retryAfterSeconds,
  });
}
