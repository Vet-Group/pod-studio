import { createHash, randomBytes } from 'node:crypto';
import { hashPassword as hashWithScrypt } from 'better-auth/crypto';
import { AuthError } from './errors';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_NAME_LENGTH = 100;

/** 32 random bytes as base64url (43 characters). Shown once, never stored. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored, so a database leak does not leak usable invite links. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 16 characters from 12 random bytes; long enough for the one sign-in before it must be changed. */
export function generateTemporaryPassword(): string {
  return randomBytes(12).toString('base64url');
}

export function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError('WEAK_PASSWORD');
  }
}

/** Same scrypt format better-auth verifies at sign-in. */
export function hashPassword(password: string): Promise<string> {
  return hashWithScrypt(password);
}

export function normalizeEmail(email: unknown): string {
  const value = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AuthError('INVALID_INPUT', 'Email không hợp lệ.');
  }
  return value;
}

export function normalizeName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!value || value.length > MAX_NAME_LENGTH) throw new AuthError('INVALID_INPUT', 'Tên cần từ 1 đến 100 ký tự.');
  return value;
}
