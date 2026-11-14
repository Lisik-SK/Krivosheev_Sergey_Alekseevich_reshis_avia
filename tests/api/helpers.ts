import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/server/app';
import type { AppConfig } from '../../src/server/config';
import { SESSION_COOKIE } from '../../src/server/http';

export const ROOT = path.resolve(__dirname, '..', '..');
export const DATA_FORECAST = path.join(ROOT, 'data', 'seasonal_forecast.csv');
export const DATA_ROUTES = path.join(ROOT, 'data', 'routes.csv');
/** Directory that never exists, so the app runs without the built client. */
export const NO_CLIENT_DIR = path.join(ROOT, 'tests', '__no_client_build__');

export async function makeApp(config: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  return buildApp({
    config: {
      dbPath: ':memory:',
      logLevel: 'silent',
      env: 'test',
      clientDir: NO_CLIENT_DIR,
      forecastPath: DATA_FORECAST,
      routesPath: DATA_ROUTES,
      authRateLimitPerMinute: 1000,
      dataCheckIntervalMs: 0,
      cookieSecure: 'auto',
      trustProxy: false,
      allowRegistration: true,
      ...config,
    },
  });
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ra-${prefix}-`));
}

export function sessionFrom(res: LightMyRequestResponse): string | undefined {
  return res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter++;
  return `${prefix}${counter}.${Date.now()}@example.com`;
}

export const GOOD_PASSWORD = 'Skyline2026!';

export async function registerUser(
  app: FastifyInstance,
  over: { email?: string; name?: string; password?: string } = {},
): Promise<{ token: string; email: string; password: string; res: LightMyRequestResponse }> {
  const email = over.email ?? uniqueEmail();
  const password = over.password ?? GOOD_PASSWORD;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, name: over.name ?? 'Тестовый Пользователь', password },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const token = sessionFrom(res);
  if (!token) throw new Error('no session cookie');
  return { token, email, password, res };
}

export function forecast(
  app: FastifyInstance,
  token: string | undefined,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return api(app, 'POST', '/api/forecast', token, payload, headers);
}

/**
 * Generic JSON API call with an optional session cookie and extra headers.
 * Like the real client (src/client/api.ts), non-GET calls always send a JSON body ({} by default).
 */
export function api(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token: string | undefined,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers,
    ...(payload === undefined && method === 'GET' ? {} : { payload: (payload ?? {}) as Record<string, unknown> }),
    cookies: token ? { [SESSION_COOKIE]: token } : {},
  });
}

export function me(app: FastifyInstance, token: string | undefined) {
  return api(app, 'GET', '/api/auth/me', token);
}

export function meta(app: FastifyInstance, token: string | undefined, headers: Record<string, string> = {}) {
  return api(app, 'GET', '/api/meta', token, undefined, headers);
}

/** Changes the file and moves its mtime forward so the store notices even within the fs timestamp resolution. */
export function writeAndBump(file: string, content: string, bumpSeconds: number) {
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() + bumpSeconds * 1000);
  fs.utimesSync(file, t, t);
}
