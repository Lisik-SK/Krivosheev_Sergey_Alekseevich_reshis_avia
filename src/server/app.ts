import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { AuthService, ConflictError, ValidationError, type PublicUser } from './auth.js';
import { loadConfig, type AppConfig } from './config.js';
import { DataStore } from './dataStore.js';
import { openDatabase, type Db } from './db.js';
import { HttpError, SESSION_COOKIE, localizeFields } from './http.js';
import { msg, parseLang, render, type Lang } from '../shared/messages.js';
import { registerApiRoutes } from './routes.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: PublicUser | null;
    lang: Lang;
  }
  interface FastifyInstance {
    config: AppConfig;
    auth: AuthService;
    data: DataStore;
    db: Db;
  }
}

export interface BuildOptions {
  config?: Partial<AppConfig>;
  /** Позволяет тестам подменить хранилище данных. */
  dataStore?: DataStore;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config: AppConfig = { ...loadConfig(), ...opts.config };

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    // Для X-Forwarded-* Fastify проверяет адрес непосредственного прокси.
    trustProxy: config.trustProxy as boolean | string,
    bodyLimit: 16 * 1024,
  });

  const db = openDatabase(config.dbPath);
  const auth = new AuthService(db, config.sessionTtlHours * 3600 * 1000);
  const data =
    opts.dataStore ??
    new DataStore(config.forecastPath, config.routesPath, config.dataCheckIntervalMs, (msg, level = 'info') =>
      app.log[level](msg),
    );

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('auth', auth);
  app.decorate('data', data);
  app.decorateRequest('user', null);
  app.decorateRequest('lang', 'ru');

  const purgeTimer = setInterval(() => auth.purgeExpiredSessions(), 3600 * 1000);
  purgeTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
    db.close();
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.env === 'production' && config.cookieSecure === true ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    // HSTS включаем только когда точно работаем по HTTPS.
    strictTransportSecurity: config.cookieSecure === true ? { maxAge: 15552000 } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Язык ответа: заголовок X-Lang от клиента, иначе Accept-Language, иначе русский.
  app.addHook('onRequest', async (req) => {
    const header = req.headers['x-lang'];
    req.lang =
      parseLang(Array.isArray(header) ? header[0] : header) ??
      parseLang(String(req.headers['accept-language'] ?? '').split(',')[0]) ??
      'ru';
  });

  // Пользователь из cookie сессии.
  app.addHook('onRequest', async (req) => {
    if (!isApiRequest(req)) return;
    req.user = auth.getSessionUser(req.cookies[SESSION_COOKIE]);
  });

  // Пустое JSON-тело (например, у POST /api/auth/logout) считаем пустым объектом.
  // Принимаем только JSON: парсер text/plain убираем, чтобы «простые» запросы не проходили.
  app.removeContentTypeParser(['application/json', 'text/plain']);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body);
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('Bad JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Защита от CSRF: изменяющие запросы принимаем только как JSON и только со своего origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!isApiRequest(req) || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.toLowerCase().startsWith('application/json')) {
      return reply.code(415).send({ error: msg(req.lang, 'json_required') });
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost = '';
      try {
        originHost = origin === 'null' ? '' : new URL(origin).host;
      } catch {
        /* некорректный Origin */
      }
      if (!originHost || originHost !== req.host) {
        return reply.code(403).send({ error: msg(req.lang, 'foreign_origin') });
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const lang = req.lang ?? 'ru';
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({
        error: render(lang, err.body),
        fields: err.fields ? localizeFields(lang, err.fields) : undefined,
        ...err.extra,
      });
    }
    if (err instanceof ValidationError) {
      return reply.code(400).send({ error: msg(lang, 'check_fields'), fields: localizeFields(lang, err.fieldErrors) });
    }
    if (err instanceof ConflictError) {
      const text = msg(lang, 'email_taken');
      return reply.code(409).send({ error: text, fields: { email: text } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) {
      return reply.code(429).send({ error: msg(lang, 'too_many_attempts') });
    }
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: msg(lang, 'body_too_large') });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: msg(lang, 'bad_request') });
    }
    req.log.error(err);
    return reply.code(500).send({ error: msg(lang, 'internal_error') });
  });

  await registerApiRoutes(app);

  const hasClient = fs.existsSync(path.join(config.clientDir, 'index.html'));

  app.setNotFoundHandler((req, reply) => {
    if (isApiRequest(req)) return reply.code(404).send({ error: msg(req.lang, 'api_not_found') });
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send({ error: msg(req.lang, 'not_found') });
    // Отсутствующий файл сборки — честный 404, а не index.html под видом скрипта.
    const pathname = req.url.split('?')[0] ?? '';
    if (pathname.startsWith('/assets/') || /\.[a-z0-9]{2,5}$/i.test(pathname)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    }
    // SPA: все прочие GET отдаём index.html
    if (hasClient) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    return reply.code(404).type('text/plain; charset=utf-8').send('Клиент не собран. Выполните npm run build.');
  });

  if (hasClient) {
    await app.register(fastifyStatic, {
      root: config.clientDir,
      index: ['index.html'],
      setHeaders(reply, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('Cache-Control', 'no-cache');
        }
      },
    });
  }

  return app;
}

/**
 * Запрос к API? Проверяем и шаблон найденного маршрута, и декодированный путь:
 * роутер понимает /%61pi/... как /api/..., а простая проверка req.url — нет.
 */
export function isApiRequest(req: FastifyRequest): boolean {
  const routeUrl = req.routeOptions?.url;
  if (routeUrl && routeUrl.startsWith('/api/')) return true;
  let pathname = req.url.split('?')[0] ?? '';
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* некорректная кодировка — оставляем как есть */
  }
  return pathname.toLowerCase().replace(/\/{2,}/g, '/').startsWith('/api/');
}
