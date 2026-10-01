import { afterEach, describe, expect, it } from 'vitest';
import { auditLog, createDatabase, eq, migrateDatabase, sessions, users, type Database } from '@pod-studio/db';
import { createTestDatabase } from '../../../../tests/support/db';
import {
  PASSWORD_CHANGE_PATH,
  createAuth,
  createInvite,
  createUserWithTemporaryPassword,
  loginLocation,
  resolveRequestAccess,
  safeNextPath,
  type Auth,
  type Principal,
} from '../../src/auth';

const BASE_URL = 'http://localhost:3100';
const SECRET = 'test-only-secret-0123456789abcdefghijklmnop';
const admin: Principal = { userId: 'user_admin_01', role: 'admin' };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(): Promise<{ db: Database; auth: Auth }> {
  const test = await createTestDatabase();
  cleanup.push(() => test.drop());
  await migrateDatabase(test.connection);
  const handle = createDatabase(test.connection, { max: 4 });
  cleanup.push(() => handle.close());
  await handle.db.insert(users).values({ id: admin.userId, name: 'Admin', email: 'admin@example.test', role: 'admin' });
  return { db: handle.db, auth: createAuth({ db: handle.db, secret: SECRET, baseURL: BASE_URL }) };
}

interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  cookie?: string;
}

function call(auth: Auth, path: string, { method = 'POST', body, cookie }: CallOptions = {}) {
  const headers = new Headers({ origin: BASE_URL });
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function cookieOf(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0]!)
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
  expect(cookie).toContain('session_token=');
  return cookie;
}

async function signIn(auth: Auth, email: string, password: string) {
  const response = await call(auth, '/sign-in/email', { body: { email, password } });
  expect(response.status).toBe(200);
  return { cookie: cookieOf(response), body: (await response.json()) as { user: Record<string, unknown> } };
}

async function temporaryAccount(db: Database, auth: Auth) {
  const created = await createUserWithTemporaryPassword(db, admin, { email: 'staff@example.test', name: 'Staff Member' });
  const { cookie, body } = await signIn(auth, created.email, created.temporaryPassword);
  return { ...created, cookie, user: body.user };
}

describe('public sign-up is closed', () => {
  it('rejects the better-auth sign-up endpoint over HTTP and from server code, creating no user', async () => {
    const { db, auth } = await setup();
    const body = { email: 'outsider@example.test', password: 'outsider-password-1', name: 'Outsider' };

    const response = await call(auth, '/sign-up/email', { body });
    expect(response.status).toBe(404);
    await expect(auth.api.signUpEmail({ body })).rejects.toMatchObject({ status: 'BAD_REQUEST' });

    expect(await db.$count(users)).toBe(1);
    expect(await db.$count(users, eq(users.email, body.email))).toBe(0);
  });

  it('disables every built-in route P1-03 does not offer', async () => {
    const { auth } = await setup();
    for (const path of [
      '/change-password',
      '/update-user',
      '/change-email',
      '/delete-user',
      '/request-password-reset',
      '/sign-in/social',
      '/link-social',
      '/send-verification-email',
    ]) {
      const response = await call(auth, path, { body: {} });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('temporary password gate', () => {
  it('signs in a temporary-password account but blocks every auth endpoint except session, sign-out and change-password', async () => {
    const { db, auth } = await setup();
    const account = await temporaryAccount(db, auth);
    expect(account.user).toMatchObject({ email: 'staff@example.test', mustChangePassword: true });

    const session = await call(auth, '/get-session', { method: 'GET', cookie: account.cookie });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { id: account.userId, mustChangePassword: true } });

    for (const [method, path] of [
      ['GET', '/list-sessions'],
      ['POST', '/revoke-other-sessions'],
      ['POST', '/revoke-sessions'],
    ] as const) {
      const response = await call(auth, path, { method, cookie: account.cookie, body: method === 'POST' ? {} : undefined });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    }
  });

  it('sends a temporary-password user from every page to change-password and refuses app APIs', () => {
    const flagged = { mustChangePassword: true };
    for (const pathname of ['/', '/orders', '/stores/abc', '/login', '/invite/some-token']) {
      expect(resolveRequestAccess(pathname, flagged), pathname).toEqual({ kind: 'redirect', location: PASSWORD_CHANGE_PATH });
    }
    expect(resolveRequestAccess('/api/stores', flagged)).toEqual({ kind: 'forbidden', code: 'PASSWORD_CHANGE_REQUIRED' });
    for (const pathname of [PASSWORD_CHANGE_PATH, '/api/auth/get-session', '/api/auth/sign-out', '/api/health']) {
      expect(resolveRequestAccess(pathname, flagged), pathname).toEqual({ kind: 'allow' });
    }
    expect(resolveRequestAccess('/orders', { mustChangePassword: false })).toEqual({ kind: 'allow' });
  });

  it('sends anonymous visitors to sign-in, returning them to the page they asked for', () => {
    expect(resolveRequestAccess('/orders', null)).toEqual({ kind: 'redirect', location: '/login?next=%2Forders' });
    expect(resolveRequestAccess('/review', null, '?id=7')).toEqual({ kind: 'redirect', location: '/login?next=%2Freview%3Fid%3D7' });
    expect(resolveRequestAccess('/', undefined)).toEqual({ kind: 'redirect', location: '/login' });
    expect(resolveRequestAccess('/api/stores', null)).toEqual({ kind: 'unauthorized', code: 'UNAUTHORIZED' });
    for (const pathname of ['/login', '/invite/some-token', '/api/auth/sign-in/email', '/api/health']) {
      expect(resolveRequestAccess(pathname, null), pathname).toEqual({ kind: 'allow' });
    }
    // A signed-in user never sees the sign-in form again.
    expect(resolveRequestAccess('/login', { mustChangePassword: false })).toEqual({ kind: 'redirect', location: '/' });
  });

  it('only returns to paths on this site after sign-in (no open redirect)', () => {
    for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', 'evil', '', null, '/a\nb']) {
      expect(safeNextPath(value), String(value)).toBe('/');
    }
    expect(safeNextPath('/review?id=7')).toBe('/review?id=7');
    expect(loginLocation('//evil.example')).toBe('/login');
  });

  it('lifts the gate once the password is changed, keeping only the current session', async () => {
    const { db, auth } = await setup();
    const account = await temporaryAccount(db, auth);
    const other = await signIn(auth, account.email, account.temporaryPassword);

    const wrong = await call(auth, '/password/change', {
      cookie: account.cookie,
      body: { currentPassword: 'not-the-password', newPassword: 'brand-new-password-1' },
    });
    expect(wrong.status).toBe(400);
    expect(await db.$count(users, eq(users.mustChangePassword, true))).toBe(1);

    const changed = await call(auth, '/password/change', {
      cookie: account.cookie,
      body: { currentPassword: account.temporaryPassword, newPassword: 'brand-new-password-1' },
    });
    expect(changed.status).toBe(200);

    const [row] = await db.select({ flag: users.mustChangePassword }).from(users).where(eq(users.id, account.userId));
    expect(row?.flag).toBe(false);
    expect((await call(auth, '/list-sessions', { method: 'GET', cookie: account.cookie })).status).toBe(200);
    const stale = await call(auth, '/get-session', { method: 'GET', cookie: other.cookie });
    expect(await stale.json()).toBeNull();
    expect(await db.$count(sessions, eq(sessions.userId, account.userId))).toBe(1);

    await signIn(auth, account.email, 'brand-new-password-1');
  });
});

describe('invite acceptance and sessions', () => {
  it('creates the invited account, signs it in, and refuses a replay', async () => {
    const { db, auth } = await setup();
    const invite = await createInvite({ db }, admin, { email: 'new@example.test' });
    const body = { token: invite.token, name: 'New Hire', password: 'invitee-password-1' };

    const accepted = await call(auth, '/invite/accept', { body });
    expect(accepted.status).toBe(200);
    const session = await call(auth, '/get-session', { method: 'GET', cookie: cookieOf(accepted) });
    expect(await session.json()).toMatchObject({
      user: { email: 'new@example.test', name: 'New Hire', mustChangePassword: false, role: 'member' },
    });

    const replay = await call(auth, '/invite/accept', { body });
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ code: 'INVITE_USED' });
    expect(await db.$count(users)).toBe(2);
  });

  it('revokes the session row on sign-out and audits sign-in and sign-out', async () => {
    const { db, auth } = await setup();
    const invite = await createInvite({ db }, admin, { email: 'new@example.test' });
    const accepted = await call(auth, '/invite/accept', {
      body: { token: invite.token, name: 'New Hire', password: 'invitee-password-1' },
    });
    const cookie = cookieOf(accepted);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'new@example.test'));
    expect(await db.$count(sessions, eq(sessions.userId, user!.id))).toBe(1);

    expect((await call(auth, '/sign-out', { cookie, body: {} })).status).toBe(200);
    expect(await db.$count(sessions, eq(sessions.userId, user!.id))).toBe(0);
    expect(await (await call(auth, '/get-session', { method: 'GET', cookie })).json()).toBeNull();

    const actions = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorUserId, user!.id))
      .orderBy(auditLog.createdAt);
    expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining(['auth.sign-in', 'auth.sign-out']));
  });
});
