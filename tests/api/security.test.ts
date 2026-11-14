import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/server/http';
import { msg } from '../../src/shared/messages';
import { GOOD_PASSWORD, makeApp, makeTempDir, registerUser } from './helpers';

let app: FastifyInstance;
let email: string;
let token: string;

beforeAll(async () => {
  app = await makeApp();
  ({ email, token } = await registerUser(app));
});
afterAll(async () => {
  await app.close();
});

describe('CSRF protection', () => {
  it('text/plain POST → 415 (a cross-site <form> cannot send JSON)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ email, password: GOOD_PASSWORD }),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe(msg('ru', 'json_required'));
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    '/%61pi/auth/logout',
    '/%61%70%69/auth/logout',
    '/api/auth/%6cogout',
    '//api/auth/logout',
    '/API/auth/logout',
  ])('URL-encoded / odd path %s with text/plain is still treated as API → 415 or 404, never 200', async (url) => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect([415, 404]).toContain(res.statusCode);
    // The session must survive a forged cross-site logout.
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: token } })).json().user).not.toBeNull();
  });

  it('POST /%61pi/auth/logout with text/plain → exactly 415', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/%61pi/auth/logout',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe(msg('ru', 'json_required'));
  });

  it('a foreign Origin on an encoded path is rejected too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/%61pi/auth/logout',
      headers: { host: 'avia.example.com', origin: 'https://evil.example.net', 'content-type': 'application/json' },
      payload: '{}',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(403);
  });

  it.each(['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined])(
    'content-type %j → 415 on /api/forecast too',
    async (ct) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/forecast',
        headers: ct ? { 'content-type': ct } : {},
        payload: 'from=MOW&to=AER',
        cookies: { [SESSION_COOKIE]: token },
      });
      expect(res.statusCode).toBe(415);
    },
  );

  it('accepts application/json with charset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ email, password: GOOD_PASSWORD }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('foreign Origin → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/forecast',
      headers: { host: 'avia.example.com', origin: 'https://evil.example.net' },
      payload: { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9500 },
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(msg('ru', 'foreign_origin'));
  });

  it.each(['null', 'not a url', 'https://avia.example.com.evil.net', 'https://avia.example.com:8443'])(
    'Origin %j → 403',
    async (origin) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: 'avia.example.com', origin },
        payload: { email, password: GOOD_PASSWORD },
      });
      expect(res.statusCode).toBe(403);
    },
  );

  it('same Origin is accepted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/forecast',
      headers: { host: 'avia.example.com', origin: 'https://avia.example.com' },
      payload: { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9500 },
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().median.wants).toBe(704.5);
  });

  it('same Origin with a non-default port is accepted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
      payload: { email, password: GOOD_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });

  it('no Origin header (same-origin fetch in some browsers, curl) is accepted', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: GOOD_PASSWORD } });
    expect(res.statusCode).toBe(200);
  });

  it('GET requests are not subject to the check', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { origin: 'https://evil.example.net' },
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('rate limiting of auth endpoints', () => {
  let limited: FastifyInstance;
  beforeAll(async () => {
    limited = await makeApp({ authRateLimitPerMinute: 3 });
  });
  afterAll(async () => {
    await limited.close();
  });

  it('login → 429 after N attempts in a minute, even with correct credentials', async () => {
    await limited.auth.register({ email: 'rl@example.com', name: 'RL', password: GOOD_PASSWORD });
    const attempt = (password: string) =>
      limited.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'rl@example.com', password } });
    for (let i = 0; i < 3; i++) expect((await attempt('Wrong12345')).statusCode).toBe(401);
    const blocked = await attempt(GOOD_PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe(msg('ru', 'too_many_attempts'));
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('register has its own limit', async () => {
    const reg = (i: number) =>
      limited.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: `rl-reg-${i}@example.com`, name: 'RL', password: GOOD_PASSWORD },
      });
    for (let i = 0; i < 3; i++) expect((await reg(i)).statusCode).toBe(201);
    expect((await reg(99)).statusCode).toBe(429);
  });

  it('other endpoints are not affected by the auth limit', async () => {
    const { id } = limited.db.prepare('SELECT id FROM users WHERE email = ?').get('rl@example.com') as { id: number };
    const t = limited.auth.createSession(id).token;
    for (let i = 0; i < 6; i++) {
      const res = await limited.inject({
        method: 'POST',
        url: '/api/forecast',
        payload: { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9500 },
        cookies: { [SESSION_COOKIE]: t },
      });
      expect(res.statusCode).toBe(200);
    }
    for (let i = 0; i < 6; i++) expect((await limited.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});

describe('security headers', () => {
  it.each(['/api/health', '/api/nope', '/'])('are present on %s', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('no HSTS unless cookieSecure is true', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('routing and error handling', () => {
  it('unknown /api path → 404 JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ error: msg('ru', 'api_not_found') });
  });

  it('unknown /api path with POST → 404 JSON', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nope', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeDefined();
  });

  it('wrong method on a known path → 404 JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/forecast' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeDefined();
  });

  it('non-API GET without a built client → 404 text hint', async () => {
    const res = await app.inject({ method: 'GET', url: '/some/page' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toMatch(/npm run build/);
  });

  it('malformed JSON → 400 with a generic message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: msg('ru', 'bad_request') });
  });

  it('body over 16 KB → 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'x'.repeat(20 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: msg('ru', 'body_too_large') });
  });

  it('prototype pollution payload is rejected or ignored', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"__proto__":{"polluted":true},"email":"x@example.com","password":"Abcdefg1"}',
    });
    expect([400, 401]).toContain(res.statusCode);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('error responses do not leak stack traces', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.body).not.toMatch(/at .*\.(ts|js):\d+/);
    expect(res.body).not.toMatch(/SyntaxError/);
  });
});

describe('static client serving (temp clientDir with index.html)', () => {
  let web: FastifyInstance;
  let clientDir: string;
  const INDEX = '<!doctype html><html><body><div id="app">reshis-avia-test-index</div></body></html>';
  const JS = 'console.log("app");';

  beforeAll(async () => {
    clientDir = makeTempDir('client');
    fs.mkdirSync(path.join(clientDir, 'assets'));
    fs.writeFileSync(path.join(clientDir, 'index.html'), INDEX);
    fs.writeFileSync(path.join(clientDir, 'assets', 'app-abc123.js'), JS);
    fs.writeFileSync(path.join(clientDir, 'robots.txt'), 'User-agent: *');
    web = await makeApp({ clientDir });
  });
  afterAll(async () => {
    await web.close();
    fs.rmSync(clientDir, { recursive: true, force: true });
  });

  it('GET / serves index.html with no-cache and security headers', async () => {
    const res = await web.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it.each(['/board', '/admin', '/some/deep/route', '/?from=MOW&to=AER&date=2026-06-01&price=9500', '/board?date=2026-06-15&mode=base'])(
    'SPA route %s falls back to index.html',
    async (url) => {
      const res = await web.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX);
    },
  );

  it('existing assets are served with a long immutable cache', async () => {
    const res = await web.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(JS);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const robots = await web.inject({ method: 'GET', url: '/robots.txt' });
    expect(robots.statusCode).toBe(200);
    expect(robots.headers['cache-control']).toBe('no-cache');
  });

  it.each(['/assets/missing.js', '/assets/missing', '/assets/old-123.css', '/favicon.ico', '/docs/report.pdf', '/x.js?v=1'])(
    'missing static file %s → 404, not index.html',
    async (url) => {
      const res = await web.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('reshis-avia-test-index');
    },
  );

  it('API 404s stay JSON when a client is present; non-GET non-API → 404 JSON', async () => {
    const api = await web.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: msg('ru', 'api_not_found') });
    const post = await web.inject({ method: 'POST', url: '/board', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toEqual({ error: msg('ru', 'not_found') });
  });

  // The calculator keeps its state in the query of "/" (src/client/main.ts:29); a price with kopecks
  // ends the URL with ".55", which must not be mistaken for a file extension.
  it('calculator deep link with a fractional price in the query string is served index.html', async () => {
    const res = await web.inject({ method: 'GET', url: '/?from=MOW&to=AER&date=2026-06-01&price=9500.55' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
  });
});
