import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, updatedAt } from './columns';

/**
 * Tables used by better-auth 1.7.6 (email + password, admin plugin; ADR 0001/0002).
 *
 * Property names are the better-auth field names so its Drizzle adapter can map them directly;
 * P1-03 passes these tables to the adapter with `usePlural: true`. Columns follow the snake_case
 * convention of the rest of the schema.
 */

/**
 * Global role values are checked in the app, not by the database (PRD §4: no enums or CHECK).
 * P1-03 configures the admin plugin with `defaultRole: 'member'` and `adminRoles: ['admin']` to match.
 */
export const GLOBAL_ROLES = ['admin', 'member'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // admin plugin
  role: text('role').$type<GlobalRole>().notNull().default('member'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamptz('ban_expires'),
  // Set when an admin creates the account with a temporary password; every page and action except
  // changing the password is refused until the user picks their own (ADR 0002).
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    // admin plugin: set while an admin impersonates this session's user
    impersonatedBy: text('impersonated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

/** Sign-in methods. For email + password, `providerId` is `credential` and `password` holds the hash. */
export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('accounts_user_id_idx').on(t.userId),
    uniqueIndex('accounts_provider_account_unique').on(t.providerId, t.accountId),
  ],
);

/** Short-lived tokens owned by better-auth (for example password reset). */
export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);
