export const AUTH_ERROR_MESSAGES = {
  INVALID_INPUT: 'The submitted details are invalid.',
  WEAK_PASSWORD: 'Password must be 10 to 128 characters.',
  FORBIDDEN: 'You do not have permission to do this.',
  NOT_SUPPORTED: 'This feature is not available yet.',
  ACCOUNT_EXISTS: 'An account with this email already exists.',
  INVITE_NOT_FOUND: 'This invite link does not exist.',
  INVITE_EXPIRED: 'This invite link has expired.',
  INVITE_USED: 'This invite link has already been used.',
  INVITE_REVOKED: 'This invite link has been revoked.',
  NOT_FOUND: 'That store or member does not exist.',
  ALREADY_MEMBER: 'This person is already a member of the store.',
  LAST_OWNER: 'A store must keep exactly one owner. Transfer ownership first.',
  STORE_EXISTS: 'A store with this Shopify domain already exists.',
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES;

/** Expected, user-facing failure of an auth operation. `message` is safe to show to the user. */
export class AuthError extends Error {
  override readonly name = 'AuthError';

  constructor(
    readonly code: AuthErrorCode,
    message: string = AUTH_ERROR_MESSAGES[code],
  ) {
    super(message);
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}
