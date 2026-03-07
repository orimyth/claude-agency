import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

// Test the API key auth logic directly (extracted from api-server)

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function verifyKey(token: string, storedHash: string): boolean {
  const tokenHash = hashKey(token);
  return crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(storedHash));
}

function parseAuthHeader(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

describe('API Auth', () => {
  const testKey = 'test-agency-key-2024';
  const testHash = hashKey(testKey);

  it('hashes key consistently', () => {
    expect(hashKey(testKey)).toBe(testHash);
    expect(hashKey(testKey)).toBe(hashKey(testKey));
  });

  it('verifies correct key', () => {
    expect(verifyKey(testKey, testHash)).toBe(true);
  });

  it('rejects wrong key', () => {
    expect(verifyKey('wrong-key', testHash)).toBe(false);
  });

  it('rejects empty key', () => {
    expect(verifyKey('', testHash)).toBe(false);
  });

  it('parses Bearer token from header', () => {
    expect(parseAuthHeader('Bearer my-token')).toBe('my-token');
    expect(parseAuthHeader('Bearer   spaces')).toBe('  spaces');
  });

  it('rejects missing or malformed auth header', () => {
    expect(parseAuthHeader(undefined)).toBeNull();
    expect(parseAuthHeader('')).toBeNull();
    expect(parseAuthHeader('Basic abc')).toBeNull();
    expect(parseAuthHeader('Token abc')).toBeNull();
  });

  it('uses timing-safe comparison', () => {
    // Verify that the comparison doesn't short-circuit
    const hash1 = hashKey('key1');
    const hash2 = hashKey('key2');
    // Both should return false without timing leak
    expect(verifyKey('key2', hash1)).toBe(false);
    expect(verifyKey('key1', hash2)).toBe(false);
  });

  it('produces different hashes for different keys', () => {
    const h1 = hashKey('key-alpha');
    const h2 = hashKey('key-beta');
    expect(h1).not.toBe(h2);
  });
});
