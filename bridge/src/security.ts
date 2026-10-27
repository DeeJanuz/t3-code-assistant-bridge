import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function secretMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  return timingSafeEqual(digest(actual), digest(expected));
}

const DISABLED_PAIRING_SECRET = "disabled-pairing-secret-comparison";

export function pairingPassphraseMatches(
  actual: string | undefined,
  configured: string | null,
): boolean {
  const matches = secretMatches(actual, configured ?? DISABLED_PAIRING_SECRET);
  return configured !== null && matches;
}

export function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length);
  return token.length > 0 ? token : undefined;
}

export function websocketToken(request: IncomingMessage): string | undefined {
  const authorization = bearerToken(request);
  if (authorization !== undefined) return authorization;
  const protocols = request.headers["sec-websocket-protocol"];
  if (typeof protocols !== "string") return undefined;
  for (const protocol of protocols.split(",")) {
    const value = protocol.trim();
    if (value.startsWith("auth.")) return value.slice("auth.".length);
  }
  return undefined;
}

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function safeRequestId(): string {
  return randomUUID();
}

export function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function parsePathId(value: string | undefined): string {
  if (value === undefined) throw new ApiError(404, "not_found", "Route not found");
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid identifier");
  }
  if (!isSafeId(decoded)) throw new ApiError(400, "invalid_request", "Invalid identifier");
  return decoded;
}

export async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.byteLength;
    if (size > maximumBytes) {
      request.destroy();
      throw new ApiError(413, "request_too_large", "Request body is too large");
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new ApiError(400, "invalid_request", "JSON body is required");
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object");
  }
}

export function parseText(body: Record<string, unknown>, maximumChars: number): string {
  if (typeof body.text !== "string") {
    throw new ApiError(400, "invalid_request", "text must be a string");
  }
  const text = body.text.trim();
  if (text.length === 0) throw new ApiError(400, "invalid_request", "text cannot be empty");
  if (text.length > maximumChars) {
    throw new ApiError(413, "text_too_large", `text cannot exceed ${maximumChars} characters`);
  }
  if (/\u0000/.test(text)) throw new ApiError(400, "invalid_request", "text contains invalid data");
  return text;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const current = this.entries.get(key);
    if (current === undefined || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.entries.size > 10_000) this.prune(now);
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, value] of this.entries) {
      if (value.resetAt <= now) this.entries.delete(key);
    }
  }
}
