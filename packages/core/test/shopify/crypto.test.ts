import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret, parseEncryptionKeys } from '../../src/shopify/crypto';

const secret = 'shpat_sensitive_test_value';
const key = randomBytes(32).toString('base64');
const nextKey = randomBytes(32).toString('base64');
const keys = parseEncryptionKeys(`v1:${key},v2:${nextKey}`, 'v1');

describe('Shopify credential encryption', () => {
  it('round-trips with random nonces and authenticates ciphertext, tag and context', () => {
    const encrypted = encryptSecret(secret, 'store:token', keys);
    expect(encrypted).not.toContain(secret);
    expect(encrypted).toMatch(/^v1\./);
    expect(encryptSecret(secret, 'store:token', keys)).not.toBe(encrypted);
    expect(decryptSecret(encrypted, 'store:token', keys)).toBe(secret);
    const parts = encrypted.split('.');
    for (const index of [1, 2, 3]) {
      const bytes = Buffer.from(parts[index]!, 'base64url');
      bytes[0] = bytes[0]! ^ 1;
      const changed = [...parts];
      changed[index] = bytes.toString('base64url');
      expect(() => decryptSecret(changed.join('.'), 'store:token', keys)).toThrow('Unable to decrypt Shopify credential.');
    }
    expect(() => decryptSecret(encrypted, 'other:token', keys)).toThrow();
  });

  it('reads old versions while new writes use the selected key', () => {
    const old = encryptSecret(secret, 'store:token', keys);
    const rotated = parseEncryptionKeys(`v1:${key},v2:${nextKey}`, 'v2');
    expect(decryptSecret(old, 'store:token', rotated)).toBe(secret);
    expect(encryptSecret(secret, 'store:token', rotated)).toMatch(/^v2\./);
    expect(() => decryptSecret(old, 'store:token', parseEncryptionKeys(`v2:${nextKey}`, 'v2'))).toThrow();
  });

  it('fails closed on absent, malformed, duplicate or wrong-length keys without leaking them', () => {
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')];
    const messages: string[] = [];
    for (const [value, active] of [['', 'v1'], [`v1:${secret}`, 'v1'], [`v1:${key},v1:${key}`, 'v1'], [`v1:${key}`, 'v2']]) {
      try { parseEncryptionKeys(value, active); } catch (error) { messages.push(String(error)); }
    }
    try { decryptSecret(secret, 'store:token', keys); } catch (error) { messages.push(String(error)); }
    expect(messages).toHaveLength(5);
    expect(JSON.stringify({ messages, logs: logs.flatMap((log) => log.mock.calls) })).not.toContain(secret);
    expect(JSON.stringify(messages)).not.toContain(key);
    for (const log of logs) log.mockRestore();
  });
});
