/**
 * Регистрация, вход и сессии.
 *
 * Пароли хранятся как scrypt-хеш с солью (node:crypto). Сессия — случайный
 * 256-битный токен в cookie с флагом HttpOnly; в базе лежит только его SHA-256,
 * поэтому утечка базы не даёт войти под чужой сессией. Отдельный секрет для
 * подписи cookie не нужен.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.js';
import { msg, render, type Localizable } from '../shared/messages.js';

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Хеш-заглушка, чтобы вход с несуществующим email занимал столько же времени. */
let dummyHash: Promise<string> | null = null;
function getDummyHash() {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Role = 'admin' | 'user';

export interface PublicUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  created_at: string;
}

export type FieldErrors = Record<string, Localizable>;

export class ValidationError extends Error {
  constructor(public readonly fieldErrors: FieldErrors) {
    super(msg('ru', 'check_fields'));
  }
  /** Тексты ошибок по полям на русском (для логов и тестов). */
  get fields(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.fieldErrors).map(([k, v]) => [k, render('ru', v)]));
  }
}

export class ConflictError extends Error {}

function toPublic(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, name: row.name, role: row.role === 'admin' ? 'admin' : 'user', createdAt: row.created_at };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly sessionTtlMs: number,
  ) {}

  validateRegistration(input: { email?: unknown; password?: unknown; name?: unknown }): {
    email: string;
    password: string;
    name: string;
  } {
    const errors: FieldErrors = {};
    const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
    const password = typeof input.password === 'string' ? input.password : '';
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';

    if (!email) errors.email = { key: 'email_required' };
    else if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) errors.email = { key: 'email_invalid' };

    if (!name) errors.name = { key: 'name_required' };
    else if (name.length > NAME_MAX) errors.name = { key: 'name_too_long', params: { max: NAME_MAX } };
    // eslint-disable-next-line no-control-regex
    else if (/[\u0000-\u001f<>]/.test(name)) errors.name = { key: 'name_invalid' };

    if (password.length < PASSWORD_MIN) errors.password = { key: 'password_short', params: { min: PASSWORD_MIN } };
    else if (password.length > PASSWORD_MAX) errors.password = { key: 'password_long', params: { max: PASSWORD_MAX } };
    else if (!/\p{L}/u.test(password) || !/\d/.test(password)) errors.password = { key: 'password_weak' };
    else if (email && password.toLowerCase().includes(email.split('@')[0]!) && email.split('@')[0]!.length >= 4)
      errors.password = { key: 'password_has_email' };

    if (Object.keys(errors).length) throw new ValidationError(errors);
    return { email, password, name };
  }

  async register(input: { email?: unknown; password?: unknown; name?: unknown }): Promise<PublicUser> {
    const { email, password, name } = this.validateRegistration(input);
    const exists = this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
    if (exists) throw new ConflictError(msg('ru', 'email_taken'));
    const passwordHash = await hashPassword(password);
    try {
      const res = this.db
        .prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'user')")
        .run(email, name, passwordHash);
      const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(res.lastInsertRowid)) as unknown as UserRow;
      return toPublic(row);
    } catch (err) {
      // Гонка двух одновременных регистраций с одним email.
      if (String(err).includes('UNIQUE')) throw new ConflictError(msg('ru', 'email_taken'));
      throw err;
    }
  }

  async ensureInitialAdmin(emailInput: string, passwordInput: string): Promise<void> {
    if (this.db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return;
    const { email, name, password } = this.validateRegistration({
      email: emailInput, password: passwordInput, name: 'Администратор',
    });
    const passwordHash = await hashPassword(password);
    try {
      this.db.prepare(
        `INSERT INTO users (email, name, password_hash, role)
         SELECT ?, ?, ?, 'admin'
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
      ).run(email, name, passwordHash);
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new ConflictError('Email владельца занят. Укажите свободный INITIAL_ADMIN_EMAIL.');
      throw err;
    }
  }

  async authenticate(emailRaw: unknown, passwordRaw: unknown): Promise<PublicUser | null> {
    const email = typeof emailRaw === 'string' ? normalizeEmail(emailRaw) : '';
    const password = typeof passwordRaw === 'string' ? passwordRaw : '';
    if (!email || !password || password.length > PASSWORD_MAX || email.length > EMAIL_MAX) {
      await verifyPassword('x', await getDummyHash());
      return null;
    }
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as unknown as UserRow | undefined;
    if (!row) {
      await verifyPassword(password, await getDummyHash());
      return null;
    }
    if (!(await verifyPassword(password, row.password_hash))) return null;
    return toPublic(row);
  }

  createSession(userId: number): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), userId, now, expiresAt);
    return { token, expiresAt };
  }

  getSessionUser(token: string | undefined): PublicUser | null {
    if (!token || token.length > 100) return null;
    const row = this.db
      .prepare(
        `SELECT u.* , s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)) as unknown as (UserRow & { expires_at: number }) | undefined;
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.destroySession(token);
      return null;
    }
    return toPublic(row);
  }

  destroySession(token: string | undefined): void {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  purgeExpiredSessions(): number {
    const res = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    return Number(res.changes);
  }
}
