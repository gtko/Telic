import { createHmac, timingSafeEqual } from 'node:crypto';

// Whether `hex` is the HMAC-SHA256 digest of `rawBody` under `secret`. The digest is
// compared in constant time.
export function hmacSha256Valid(secret: string, rawBody: string, hex: string): boolean {
  const given = Buffer.from(hex, 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
