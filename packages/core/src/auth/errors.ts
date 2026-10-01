export const AUTH_ERROR_MESSAGES = {
  INVALID_INPUT: 'Thông tin chưa hợp lệ.',
  WEAK_PASSWORD: 'Mật khẩu cần từ 10 đến 128 ký tự.',
  FORBIDDEN: 'Bạn không có quyền làm việc này.',
  NOT_SUPPORTED: 'Chức năng này chưa được mở.',
  ACCOUNT_EXISTS: 'Email này đã có tài khoản.',
  INVITE_NOT_FOUND: 'Link mời không tồn tại.',
  INVITE_EXPIRED: 'Link mời đã hết hạn.',
  INVITE_USED: 'Link mời đã được dùng.',
  INVITE_REVOKED: 'Link mời đã bị thu hồi.',
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES;

/** Expected, user-facing failure of an auth operation. `message` is Vietnamese and safe to show. */
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
