import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { accounts, newId, sessions, users, verifications, type Database } from '@pod-studio/db';
import { writeAudit } from '../audit/log';
import { changePassword } from './accounts';
import { AUTH_ERROR_MESSAGES, isAuthError, type AuthErrorCode } from './errors';
import { AUTH_BASE_PATH, PASSWORD_CHANGE_AUTH_PATHS } from './gate';
import { acceptInvite, type StoreAccess } from './invites';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './secrets';

export interface AuthConfig {
  db: Database;
  /** At least 32 random characters; never the better-auth default. */
  secret: string;
  /** Public origin of the web app, e.g. `http://localhost:3100`. */
  baseURL: string;
  /** Extra origins allowed to call the auth endpoints with cookies. */
  trustedOrigins?: string[];
  /** Store membership writer for store-scoped invites (P1-04). Without it those invites are refused. */
  storeAccess?: StoreAccess;
}

export const PASSWORD_CHANGE_REQUIRED = {
  code: 'PASSWORD_CHANGE_REQUIRED',
  message: 'Change your temporary password to continue.',
} as const;

/**
 * Built-in routes P1-03 does not offer. Public sign-up stays closed (accounts come from an admin or an
 * invite), and every route that writes a password, email or profile goes through `@pod-studio/core`
 * so validation, the temporary-password flag and the audit log cannot be skipped. Social and reset
 * callbacks need a provider or a reset token, and neither can exist while these stay closed.
 */
const DISABLED_PATHS = [
  '/sign-up/email',
  '/sign-in/social',
  '/link-social',
  '/unlink-account',
  '/list-accounts',
  '/account-info',
  '/get-access-token',
  '/refresh-token',
  '/change-password',
  '/update-user',
  '/change-email',
  '/delete-user',
  '/delete-user/callback',
  '/request-password-reset',
  '/reset-password',
  '/send-verification-email',
  '/verify-email',
  '/verify-password',
  '/update-session',
];

type ErrorStatus = 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'GONE' | 'CONFLICT' | 'NOT_IMPLEMENTED';

const ERROR_STATUS: Record<AuthErrorCode, ErrorStatus> = {
  INVALID_INPUT: 'BAD_REQUEST',
  WEAK_PASSWORD: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  NOT_SUPPORTED: 'NOT_IMPLEMENTED',
  ACCOUNT_EXISTS: 'CONFLICT',
  INVITE_NOT_FOUND: 'NOT_FOUND',
  INVITE_EXPIRED: 'GONE',
  INVITE_USED: 'GONE',
  INVITE_REVOKED: 'GONE',
};

/** Runs a core operation and turns its `AuthError` into a JSON API error with the same code and message. */
async function core<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isAuthError(error)) throw new APIError(ERROR_STATUS[error.code], { code: error.code, message: error.message });
    throw error;
  }
}

function text(body: unknown, key: string): string {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string') {
    throw new APIError('BAD_REQUEST', { code: 'INVALID_INPUT', message: AUTH_ERROR_MESSAGES.INVALID_INPUT });
  }
  return value;
}

const UNGATED_PATHS = new Set(PASSWORD_CHANGE_AUTH_PATHS);

function podStudioAccess(config: AuthConfig) {
  const deps = { db: config.db, storeAccess: config.storeAccess };
  return {
    id: 'pod-studio-access',
    hooks: {
      before: [
        {
          // Second line of the temporary-password gate (the first is apps/web/src/proxy.ts). It also
          // covers server-side `auth.api.*` calls that never pass through the web proxy.
          matcher: (ctx) => !UNGATED_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if ((session?.user as { mustChangePassword?: boolean } | undefined)?.mustChangePassword) {
              throw new APIError('FORBIDDEN', PASSWORD_CHANGE_REQUIRED);
            }
          }),
        },
      ],
    },
    endpoints: {
      acceptInvite: createAuthEndpoint('/invite/accept', { method: 'POST' }, async (ctx) => {
        const accepted = await core(() =>
          acceptInvite(deps, {
            token: text(ctx.body, 'token'),
            name: text(ctx.body, 'name'),
            password: text(ctx.body, 'password'),
          }),
        );
        const user = await ctx.context.internalAdapter.findUserById(accepted.userId);
        if (!user) throw new APIError('INTERNAL_SERVER_ERROR');
        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ user: { id: user.id, email: user.email, name: user.name } });
      }),
      changePassword: createAuthEndpoint('/password/change', { method: 'POST', requireHeaders: true }, async (ctx) => {
        const session = await getSessionFromCtx(ctx);
        if (!session) throw new APIError('UNAUTHORIZED', { code: 'UNAUTHORIZED', message: 'Please sign in again.' });
        await core(() =>
          changePassword(config.db, {
            userId: session.user.id,
            currentPassword: text(ctx.body, 'currentPassword'),
            newPassword: text(ctx.body, 'newPassword'),
            keepSessionId: session.session.id,
          }),
        );
        return ctx.json({ status: true });
      }),
    },
  } satisfies BetterAuthPlugin;
}

interface SessionRow {
  id: string;
  userId: string;
  ipAddress?: string | null;
}

export function authOptions(config: AuthConfig) {
  if (config.secret.length < 32) throw new Error('Auth secret must be at least 32 characters.');
  const audit = (action: string, session: SessionRow, via: string | undefined) =>
    writeAudit(config.db, {
      actorUserId: session.userId,
      action,
      targetType: 'session',
      targetId: session.id,
      data: { via: via ?? null, ip: session.ipAddress ?? null },
    });

  return {
    appName: 'POD Studio',
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: config.trustedOrigins ?? [],
    telemetry: { enabled: false },
    database: drizzleAdapter(config.db, {
      provider: 'pg',
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    advanced: { database: { generateId: () => newId() } },
    disabledPaths: DISABLED_PATHS,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },
    user: {
      additionalFields: {
        role: { type: 'string', input: false, returned: true },
        mustChangePassword: { type: 'boolean', input: false, returned: true },
      },
    },
    // Every request re-reads the session row, so a revoked session or a cleared flag applies at once.
    session: { cookieCache: { enabled: false } },
    databaseHooks: {
      session: {
        create: { after: (session, ctx) => audit('auth.sign-in', session, ctx?.path) },
        delete: {
          after: (session, ctx) =>
            audit(ctx?.path === '/sign-out' ? 'auth.sign-out' : 'auth.session.revoke', session, ctx?.path),
        },
      },
    },
    plugins: [podStudioAccess(config)],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: AuthConfig) {
  return betterAuth(authOptions(config));
}

export type Auth = ReturnType<typeof createAuth>;
