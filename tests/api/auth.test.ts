import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app';
import { SESSION_COOKIE } from '../../src/server/http';
import { msg, type MessageKey } from '../../src/shared/messages';
import {
  GOOD_PASSWORD,
  makeApp,
  makeTempDir,
  me,
  NO_CLIENT_DIR,
  registerUser,
  sessionFrom,
  uniqueEmail,
} from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
});
afterAll(async () => {
  await app.close();
});

const register = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/auth/register', payload: payload as Record<string, unknown> });
const login = (payload: unknown, cookies: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: payload as Record<string, unknown>, cookies });

describe('GET /api/health', () => {
  it('is public and reports loaded data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.data).toMatchObject({ ok: true, error: null, flights: 155, routes: 5 });
    expect(typeof body.data.loadedAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });
});

describe('GET /api/auth/config', () => {
  it('reports registration availability', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(res.json()).toEqual({ allowRegistration: true });
  });
});

describe('POST /api/auth/register', () => {
  it('creates the user, returns 201 and sets an HttpOnly SameSite=Lax session cookie', async () => {
    const email = uniqueEmail('reg');
    const res = await register({ email: `  ${email.toUpperCase()} `, name: '  Анна   Иванова ', password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(201);
    const { user } = res.json();
    expect(user).toEqual({
      id: expect.any(Number),
      email,
      name: 'Анна Иванова',
      role: 'user',
      createdAt: expect.any(String),
    });
    expect(user).not.toHaveProperty('password_hash');
    expect(user).not.toHaveProperty('passwordHash');

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Expires=/);
    expect(setCookie).not.toMatch(/Secure/); // plain http + cookieSecure 'auto'

    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie.value.length).toBeGreaterThanOrEqual(40);
    // Default TTL = 168 h.
    const ttl = new Date(cookie.expires!).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(167 * 3600 * 1000);
    expect(ttl).toBeLessThanOrEqual(168 * 3600 * 1000);

    const who = await me(app, cookie.value);
    expect(who.json()).toEqual({ user });
    expect(who.headers['cache-control']).toBe('no-store');
  });

  it('stores only a scrypt hash of the password', async () => {
    const { email, password } = await registerUser(app);
    const row = app.db.prepare('SELECT password_hash FROM users WHERE email = ?').get(email) as { password_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(row.password_hash).not.toContain(password);
  });

  it('reports all invalid fields at once for an empty body', async () => {
    const res = await register({});
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe(msg('ru', 'check_fields'));
    expect(body.fields).toEqual({
      email: msg('ru', 'email_required'),
      name: msg('ru', 'name_required'),
      password: msg('ru', 'password_short', { min: 8 }),
    });
  });

  it('field errors are in English with X-Lang: en', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'x-lang': 'en' }, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: msg('en', 'check_fields'),
      fields: {
        email: msg('en', 'email_required'),
        name: msg('en', 'name_required'),
        password: msg('en', 'password_short', { min: 8 }),
      },
    });
  });

  it.each<[string, MessageKey]>([
    ['', 'email_required'],
    ['not-an-email', 'email_invalid'],
    ['a@b', 'email_invalid'],
    ['a b@example.com', 'email_invalid'],
    [`${'a'.repeat(250)}@example.com`, 'email_invalid'],
  ])('email %j is rejected', async (email, key) => {
    const res = await register({ email, name: 'Иван', password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ email: msg('ru', key) });
  });

  it('non-string email is treated as missing', async () => {
    const res = await register({ email: 42, name: 'Иван', password: GOOD_PASSWORD });
    expect(res.json().fields.email).toBe(msg('ru', 'email_required'));
  });

  it.each<[string, MessageKey, Record<string, number>?]>([
    ['', 'name_required'],
    ['    ', 'name_required'],
    ['x'.repeat(81), 'name_too_long', { max: 80 }],
    ['<script>', 'name_invalid'],
    ['Иван\u0007', 'name_invalid'],
  ])('name %j is rejected', async (name, key, params) => {
    const res = await register({ email: uniqueEmail(), name, password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ name: msg('ru', key, params) });
  });

  it('name of exactly 80 characters is accepted', async () => {
    const res = await register({ email: uniqueEmail(), name: 'Я'.repeat(80), password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(201);
  });

  it.each<[string, MessageKey, Record<string, number>?]>([
    ['short1', 'password_short', { min: 8 }],
    ['', 'password_short', { min: 8 }],
    ['a1'.repeat(65), 'password_long', { max: 128 }],
    ['onlyletters', 'password_weak'],
    ['12345678', 'password_weak'],
  ])('weak password %j is rejected', async (password, key, params) => {
    const res = await register({ email: uniqueEmail(), name: 'Иван', password });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ password: msg('ru', key, params) });
  });

  it('accepts Cyrillic letters + digits as a password', async () => {
    const res = await register({ email: uniqueEmail(), name: 'Иван', password: 'пароль2026' });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a password containing the email local part (case-insensitive)', async () => {
    const res = await register({ email: 'ivan.petrov@example.com', name: 'Иван', password: 'XIvan.Petrov99' });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ password: msg('ru', 'password_has_email') });
  });

  it('allows short local parts (< 4 chars) inside the password', async () => {
    const res = await register({ email: 'ivy@example.com', name: 'Ivy', password: 'ivyLeague42' });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a duplicate email case-insensitively with 409', async () => {
    const email = uniqueEmail('dup');
    expect((await register({ email, name: 'Первый', password: GOOD_PASSWORD })).statusCode).toBe(201);
    const res = await register({ email: email.toUpperCase(), name: 'Второй', password: 'Another2026' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: msg('ru', 'email_taken'), fields: { email: msg('ru', 'email_taken') } });
    expect(res.headers['set-cookie']).toBeUndefined();
    const count = app.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ? COLLATE NOCASE').get(email) as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});

describe('POST /api/auth/login', () => {
  let email: string;
  beforeAll(async () => {
    ({ email } = await registerUser(app, { email: uniqueEmail('login') }));
  });

  it('logs in with the right password (email case/whitespace-insensitive)', async () => {
    const res = await login({ email: `  ${email.toUpperCase()}  `, password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);
    const token = sessionFrom(res);
    expect(token).toBeDefined();
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect((await me(app, token)).json().user.email).toBe(email);
  });

  it('wrong password and unknown email give the same 401 response', async () => {
    const wrong = await login({ email, password: 'WrongPass123' });
    const unknown = await login({ email: 'nobody-here@example.com', password: 'WrongPass123' });
    const empty = await login({});
    for (const r of [wrong, unknown, empty]) {
      expect(r.statusCode).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect(wrong.json()).toEqual({ error: msg('ru', 'invalid_credentials') });
    expect(unknown.json()).toEqual(wrong.json());
    expect(empty.json()).toEqual(wrong.json());
  });

  it('password is case-sensitive', async () => {
    expect((await login({ email, password: GOOD_PASSWORD.toLowerCase() })).statusCode).toBe(401);
  });

  it('logging in again invalidates the session cookie the browser had (session fixation)', async () => {
    const first = sessionFrom(await login({ email, password: GOOD_PASSWORD }))!;
    const second = await login({ email, password: GOOD_PASSWORD }, { [SESSION_COOKIE]: first });
    const secondToken = sessionFrom(second)!;
    expect(secondToken).not.toBe(first);
    expect((await me(app, first)).json()).toEqual({ user: null });
    expect((await me(app, secondToken)).json().user.email).toBe(email);
  });
});

describe('sessions', () => {
  it('logout destroys the session and clears the cookie', async () => {
    const { token } = await registerUser(app);
    expect((await me(app, token)).json().user).not.toBeNull();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {},
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cleared.value).toBe('');
    expect(new Date(cleared.expires!).getTime()).toBeLessThan(Date.now());
    expect((await me(app, token)).json()).toEqual({ user: null });
    const left = app.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?')
      .get(crypto.createHash('sha256').update(token).digest('hex')) as { n: number };
    expect(left.n).toBe(0);
  });

  // Regression: an empty JSON body used to be rejected with 400, leaving the session alive.
  it('logout works with a JSON content type and no body', async () => {
    const { token } = await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'content-type': 'application/json' },
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    expect((await me(app, token)).json()).toEqual({ user: null });
  });

  it('logout without a session is harmless', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('the session token is not stored in plain text (only its SHA-256)', async () => {
    const { token, email } = await registerUser(app);
    const rows = app.db
      .prepare('SELECT s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?')
      .all(email) as Array<{ token_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).not.toContain(token);
    expect(rows[0]!.token_hash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    // Nothing anywhere in the sessions table contains the raw token.
    const all = app.db.prepare('SELECT * FROM sessions').all();
    expect(JSON.stringify(all)).not.toContain(token);
  });

  it('expired sessions are rejected and deleted', async () => {
    const { token } = await registerUser(app);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    app.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1000, hash);
    expect((await me(app, token)).json()).toEqual({ user: null });
    const left = app.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(hash) as { n: number };
    expect(left.n).toBe(0);
  });

  it('purgeExpiredSessions removes only expired rows', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const hashA = crypto.createHash('sha256').update(a.token).digest('hex');
    app.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, hashA);
    expect(app.auth.purgeExpiredSessions()).toBeGreaterThanOrEqual(1);
    expect((await me(app, a.token)).json().user).toBeNull();
    expect((await me(app, b.token)).json().user).not.toBeNull();
  });

  it('forged / oversized / missing tokens give no user', async () => {
    expect((await me(app, undefined)).json()).toEqual({ user: null });
    expect((await me(app, 'forged-token')).json()).toEqual({ user: null });
    expect((await me(app, 'x'.repeat(5000))).json()).toEqual({ user: null });
  });

  it('respects sessionTtlHours', async () => {
    const short = await makeApp({ sessionTtlHours: 1 });
    try {
      const res = await short.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: uniqueEmail(), name: 'Ttl', password: GOOD_PASSWORD },
      });
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
      const ttl = new Date(cookie.expires!).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(59 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(3600 * 1000);
    } finally {
      await short.close();
    }
  });
});

describe('Secure cookie', () => {
  it('cookieSecure "auto" sets Secure behind an HTTPS proxy when trustProxy is on', async () => {
    const proxied = await makeApp({ trustProxy: true });
    try {
      const res = await proxied.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'x-forwarded-proto': 'https' },
        payload: { email: uniqueEmail(), name: 'Proxy', password: GOOD_PASSWORD },
      });
      expect(res.statusCode).toBe(201);
      expect(String(res.headers['set-cookie'])).toMatch(/; Secure/);
    } finally {
      await proxied.close();
    }
  });

  it('cookieSecure true always sets Secure and enables HSTS', async () => {
    const secure = await makeApp({ cookieSecure: true });
    try {
      const res = await secure.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: uniqueEmail(), name: 'Secure', password: GOOD_PASSWORD },
      });
      expect(String(res.headers['set-cookie'])).toMatch(/; Secure/);
      expect(res.headers['strict-transport-security']).toMatch(/max-age=15552000/);
    } finally {
      await secure.close();
    }
  });
});

describe('roles', () => {
  it('public registration and login cannot grant admin rights on an empty database', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'first@example.com');
    const fresh = await makeApp();
    try {
      const account = { email: 'first@example.com', password: GOOD_PASSWORD };
      const res = await fresh.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { ...account, name: 'First', role: 'admin' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().user.role).toBe('user');
      const login = await fresh.inject({ method: 'POST', url: '/api/auth/login', payload: account });
      expect(login.statusCode).toBe(200);
      expect((await me(fresh, sessionFrom(login))).json().user.role).toBe('user');
    } finally {
      vi.unstubAllEnvs();
      await fresh.close();
    }
  });

  it('initial admin setup cannot promote an existing public account', async () => {
    const fresh = await makeApp();
    try {
      const { email, token } = await registerUser(fresh);
      await expect(fresh.auth.ensureInitialAdmin(email.toUpperCase(), GOOD_PASSWORD)).rejects.toThrow(/INITIAL_ADMIN_EMAIL/);
      expect((await me(fresh, token)).json().user.role).toBe('user');
      await fresh.auth.ensureInitialAdmin('owner@example.test', GOOD_PASSWORD);
      expect(await fresh.auth.authenticate('owner@example.test', GOOD_PASSWORD)).toMatchObject({ role: 'admin' });
    } finally {
      await fresh.close();
    }
  });

  it('admin setup creates only one owner and preserves that account across restarts', async () => {
    const dbDir = makeTempDir('roles');
    const dbPath = path.join(dbDir, 'app.db');
    try {
      const before = await makeApp({ dbPath });
      try {
        await Promise.all([
          before.auth.ensureInitialAdmin('owner@example.test', GOOD_PASSWORD),
          before.auth.ensureInitialAdmin('owner@example.test', GOOD_PASSWORD),
        ]);
      } finally {
        await before.close();
      }
      const after = await makeApp({ dbPath });
      try {
        await after.auth.ensureInitialAdmin('second@example.test', 'Changed12345');
        await after.auth.ensureInitialAdmin('owner@example.test', 'Changed12345');
        expect(await after.auth.authenticate('owner@example.test', GOOD_PASSWORD)).toMatchObject({ role: 'admin' });
        expect(await after.auth.authenticate('owner@example.test', 'Changed12345')).toBeNull();
        expect(after.db.prepare("SELECT email FROM users WHERE role = 'admin'").all()).toEqual([{ email: 'owner@example.test' }]);
      } finally {
        await after.close();
      }
    } finally {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe('language', () => {
  it.each<[Record<string, string>, 'ru' | 'en']>([
    [{}, 'ru'],
    [{ 'x-lang': 'en' }, 'en'],
    [{ 'x-lang': 'EN' }, 'en'],
    [{ 'accept-language': 'en-US,en;q=0.9' }, 'en'],
    [{ 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' }, 'ru'],
    [{ 'accept-language': 'de-DE' }, 'ru'],
    [{ 'x-lang': 'ru', 'accept-language': 'en-US' }, 'ru'],
    [{ 'x-lang': 'fr', 'accept-language': 'en-US' }, 'en'],
  ])('headers %j → %s', async (headers, lang) => {
    const res = await app.inject({ method: 'GET', url: '/api/meta', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(msg(lang, 'login_required'));
  });

  it('login error, 404 and CSRF errors are localized too', async () => {
    const en = { 'x-lang': 'en' };
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: en, payload: {} })).json().error).toBe(
      msg('en', 'invalid_credentials'),
    );
    expect((await app.inject({ method: 'GET', url: '/api/nope', headers: en })).json().error).toBe(msg('en', 'api_not_found'));
    const csrf = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...en, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(csrf.json().error).toBe(msg('en', 'json_required'));
  });
});

describe('registration disabled', () => {
  it('allowRegistration:false via config override → 403, login still works', async () => {
    const closed = await makeApp({ allowRegistration: false });
    try {
      expect((await closed.inject({ method: 'GET', url: '/api/auth/config' })).json()).toEqual({
        allowRegistration: false,
      });
      const res = await closed.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: uniqueEmail(), name: 'Нельзя', password: GOOD_PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe(msg('ru', 'registration_disabled'));
      expect(res.headers['set-cookie']).toBeUndefined();
      const n = closed.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      expect(n.n).toBe(0);
      await closed.auth.ensureInitialAdmin('admin@example.com', 'Sky2026pass');
      const ok = await closed.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@example.com', password: 'Sky2026pass' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().user.role).toBe('admin');
    } finally {
      await closed.close();
    }
  });

  it('ALLOW_REGISTRATION=false environment variable → 403', async () => {
    vi.stubEnv('ALLOW_REGISTRATION', 'false');
    let closed: FastifyInstance | undefined;
    try {
      // No allowRegistration override: the value must come from the environment.
      closed = await buildApp({ config: { dbPath: ':memory:', logLevel: 'silent', env: 'test', clientDir: NO_CLIENT_DIR } });
      expect(closed.config.allowRegistration).toBe(false);
      const res = await closed.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: uniqueEmail(), name: 'Нельзя', password: GOOD_PASSWORD },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      vi.unstubAllEnvs();
      await closed?.close();
    }
  });
});
