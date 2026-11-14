import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { normalizeDate, type FlightForecast, type RouteInfo } from '../shared/dataset.js';
import {
  boardStatus,
  computeForecast,
  daySummary,
  optimalPrice,
  priceBounds,
  profitCurve,
  resolveCityCode,
} from '../shared/forecast.js';
import { render, type Lang, type Localizable } from '../shared/messages.js';
import { buildSnapshot, flightKey, toLoadError, type DatasetSnapshot } from './dataStore.js';
import { HttpError, L, SESSION_COOKIE, clearSessionCookie, setSessionCookie } from './http.js';

export const PRICE_LIMIT = 1_000_000;
const HISTORY_LIMIT = 30;

function requireUser(req: FastifyRequest) {
  if (!req.user) throw new HttpError(401, 'login_required');
  return req.user;
}

function requireAdmin(req: FastifyRequest) {
  const user = requireUser(req);
  if (user.role !== 'admin') throw new HttpError(403, 'admin_only');
  return user;
}

function requireData(app: FastifyInstance, lang: Lang): DatasetSnapshot {
  const snap = app.data.get();
  if (!snap) {
    const { error } = app.data.status();
    throw new HttpError(503, 'data_unavailable', { reason: error ? error.text(lang) : render(lang, L('data_not_loaded')) });
  }
  return snap;
}

/**
 * Собирает состояние и метаданные текущего набора CSV.
 * @param app Обязательный сервер с настроенным хранилищем.
 * @param lang Обязательный язык сообщений.
 * @param includeUploadedNames true для административных ответов, по умолчанию false.
 * @returns Метаданные с локализованными ошибками; source равен null без загруженного снимка.
 * @remarks Читает состояние хранилища, которое может перечитать CSV. Записей и сетевых запросов нет.
 */
function dataInfo(app: FastifyInstance, lang: Lang, includeUploadedNames = false) {
  const st = app.data.status();
  const s = st.snapshot;
  return {
    ok: st.ok,
    error: st.error ? st.error.text(lang) : null,
    version: s?.version ?? 0,
    loadedAt: s?.loadedAt ?? null,
    flights: s?.flights.size ?? 0,
    routes: s?.routes.length ?? 0,
    quantileLevels: s?.quantileLevels ?? [],
    warnings: (s?.warnings ?? []).map((w) => render(lang, w)),
    source: s ? (includeUploadedNames ? s.source : {
      forecast: { ...s.source.forecast, name: path.basename(app.data.forecastPath) },
      routes: { ...s.source.routes, name: path.basename(app.data.routesPath) },
    }) : null,
  };
}

/**
 * Собирает справочные данные маршрута для API метаданных.
 * @param route Обязательный маршрут из переданного снимка.
 * @param snap Обязательный снимок со строкой прогноза для каждой даты маршрута.
 * @returns Маршрут с датами, уникальными вместимостями и ценами 0.5_price по датам.
 * Пропускает отсутствующие цены и цены за пределами допустимых для расчёта.
 * @remarks Читает снимок без записи и запросов. Нарушение связности дат и рейсов приводит к ошибке чтения.
 */
function routeView(route: RouteInfo, snap: DatasetSnapshot) {
  const dates = snap.datesByRoute.get(route.code) ?? [];
  const seatsSet = new Set<number>();
  const modelPrices: Record<string, number> = {};
  for (const date of dates) {
    const flight = snap.flights.get(flightKey(route.code, date))!;
    seatsSet.add(flight.seats);
    const price = flight.quantiles.find((quantile) => quantile.q === 0.5)?.price;
    if (price != null && price >= 0 && price <= PRICE_LIMIT) modelPrices[date] = price;
  }
  return {
    code: route.code,
    name: route.name,
    origin: route.origin,
    destination: route.destination,
    basePrice: route.basePrice,
    priceSensitivity: route.priceSensitivity,
    costPerPassenger: route.costPerPassenger,
    priceMin: route.priceMin,
    priceMax: route.priceMax,
    dates,
    seats: [...seatsSet].sort((a, b) => a - b),
    modelPrices,
  };
}

function formatDate(iso: string, lang: Lang): string {
  const [y, m, d] = iso.split('-');
  return lang === 'en' ? `${y}-${m}-${d}` : `${d}.${m}.${y}`;
}

type Body = Record<string, unknown>;
type Fields = Record<string, Localizable>;

/** Разбирает «откуда» и «куда» и находит маршрут. */
function parseRoute(snap: DatasetSnapshot, body: Body, fields: Fields): RouteInfo | null {
  const fromRaw = typeof body.from === 'string' ? body.from : '';
  const toRaw = typeof body.to === 'string' ? body.to : '';
  const from = fromRaw ? resolveCityCode(fromRaw, snap.routes) : null;
  const to = toRaw ? resolveCityCode(toRaw, snap.routes) : null;
  if (!fromRaw.trim()) fields.from = L('from_required');
  else if (!from) fields.from = L('city_not_found', { city: fromRaw.slice(0, 40) });
  if (!toRaw.trim()) fields.to = L('to_required');
  else if (!to) fields.to = L('city_not_found', { city: toRaw.slice(0, 40) });
  else if (from && from === to) fields.to = L('same_city');
  if (!from || !to || from === to) return null;
  const route = snap.routeByCode.get(`${from}-${to}`);
  if (!route) {
    const available = snap.routes.filter((r) => r.origin.code === from).map((r) => r.destination.name);
    const hint = available.length ? L('route_hint_available', { list: available.join(', ') }) : L('route_hint_none');
    throw new HttpError(404, 'route_missing', { from, to, hint: render('ru', hint) }, { to: L('route_field') }, {
      hint,
    });
  }
  return route;
}

function parseDate(body: Body, fields: Fields): string | null {
  const raw = typeof body.date === 'string' ? body.date : '';
  const date = raw ? normalizeDate(raw) : null;
  if (!raw) fields.date = L('date_required');
  else if (!date) fields.date = L('date_format');
  return date;
}

function parsePrice(raw: unknown, fields: Fields, field = 'price'): number | null {
  let price: number | null = null;
  if (typeof raw === 'number') price = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') {
    const cleaned = raw.replace(/[\s ₽]/g, '').replace(',', '.');
    price = /^[+-]?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
  }
  if (price === null) fields[field] = L('price_required');
  else if (!Number.isFinite(price)) fields[field] = L('price_nan');
  else if (price < 0) fields[field] = L('price_negative');
  else if (price > PRICE_LIMIT) fields[field] = L('price_too_high', { max: PRICE_LIMIT });
  else return Math.round(price * 100) / 100;
  return null;
}

function findFlight(snap: DatasetSnapshot, route: RouteInfo, date: string, lang: Lang): FlightForecast {
  const flight = snap.flights.get(flightKey(route.code, date));
  if (flight) return flight;
  const dates = snap.datesByRoute.get(route.code) ?? [];
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) {
    const params = { route: route.code };
    throw new HttpError(404, 'route_no_forecast', params, { date: L('route_no_forecast', params) });
  }
  const range = render(lang, L('dates_range', { from: formatDate(first, lang), to: formatDate(last, lang) }));
  throw new HttpError(404, 'flight_missing', { date: formatDate(date, lang), route: route.code, range }, {
    date: L('dates_available', { range }),
  });
}

function failIfFields(fields: Fields) {
  if (Object.keys(fields).length) throw new HttpError(400, 'check_form', {}, fields);
}

/** Маршрут HTTP-ошибки «нет направления»: текст подсказки тоже переводим. */
function localizeRouteMissing(err: unknown, lang: Lang) {
  if (err instanceof HttpError && err.body.key === 'route_missing' && err.extra?.hint) {
    const hint = err.extra.hint as Localizable;
    return new HttpError(404, 'route_missing', { ...err.body.params, hint: render(lang, hint) }, err.fields);
  }
  return err;
}

interface HistoryRow {
  id: number;
  route: string;
  date: string;
  price: number;
  seats: number;
  sales: number;
  wants: number;
  pinned: number;
  created_at: number;
}

function historyView(row: HistoryRow, snap: DatasetSnapshot | null) {
  const route = snap?.routeByCode.get(row.route);
  const [from, to] = row.route.split('-');
  return {
    id: row.id,
    route: row.route,
    from: route?.origin ?? { code: from ?? '', name: from ?? '' },
    to: route?.destination ?? { code: to ?? '', name: to ?? '' },
    date: row.date,
    price: row.price,
    seats: row.seats,
    sales: row.sales,
    wants: row.wants,
    pinned: row.pinned === 1,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const authRateLimit = (app: FastifyInstance) => ({
  rateLimit: { max: app.config.authRateLimitPerMinute, timeWindow: '1 minute' },
});

export async function registerApiRoutes(app: FastifyInstance) {
  app.get('/api/health', async (req, reply) => {
    const info = dataInfo(app, req.lang);
    const status = info.ok && info.flights > 0 ? 'ok' : info.routes > 0 ? 'degraded' : 'error';
    // Если даже справочник недоступен, отдаём 503 для проверки хостинга.
    if (status === 'error') reply.code(503);
    return {
      status,
      time: new Date().toISOString(),
      data: { ok: info.ok, error: info.error, flights: info.flights, routes: info.routes, loadedAt: info.loadedAt },
    };
  });

  // ---------- Авторизация ----------

  app.get('/api/auth/config', async () => ({ allowRegistration: app.config.allowRegistration }));

  app.get('/api/auth/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { user: req.user };
  });

  app.post('/api/auth/register', { config: authRateLimit(app) }, async (req, reply) => {
    if (!app.config.allowRegistration) throw new HttpError(403, 'registration_disabled');
    const body = (req.body ?? {}) as Body;
    const user = await app.auth.register(body);
    const { token, expiresAt } = app.auth.createSession(user.id);
    setSessionCookie(app, req, reply, token, expiresAt);
    req.log.info({ userId: user.id, role: user.role }, 'Новый пользователь зарегистрирован');
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', { config: authRateLimit(app) }, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const user = await app.auth.authenticate(body.email, body.password);
    if (!user) throw new HttpError(401, 'invalid_credentials');
    // Старую сессию в этом браузере (если была) закрываем: защита от фиксации сессии.
    app.auth.destroySession(req.cookies[SESSION_COOKIE]);
    const { token, expiresAt } = app.auth.createSession(user.id);
    setSessionCookie(app, req, reply, token, expiresAt);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    app.auth.destroySession(req.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ---------- Справочные данные ----------

  app.get('/api/meta', async (req, reply) => {
    requireUser(req);
    const snap = requireData(app, req.lang);
    reply.header('Cache-Control', 'no-store');
    return { routes: snap.routes.map((r) => routeView(r, snap)), data: dataInfo(app, req.lang) };
  });

  // ---------- Прогноз по рейсу ----------

  app.post('/api/forecast', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
    requireUser(req);
    const snap = requireData(app, req.lang);
    const body = (req.body ?? {}) as Body;
    const fields: Fields = {};
    try {
      const route = parseRoute(snap, body, fields);
      const date = parseDate(body, fields);
      const price = parsePrice(body.price, fields);
      failIfFields(fields);
      const flight = findFlight(snap, route!, date!, req.lang);
      reply.header('Cache-Control', 'no-store');
      return { ...computeForecast(flight, route!, price!), dataVersion: snap.version };
    } catch (err) {
      throw localizeRouteMissing(err, req.lang);
    }
  });

  // Кривая выручки и дохода по цене (дополнение 1).
  app.post('/api/forecast/curve', async (req) => {
    requireUser(req);
    const snap = requireData(app, req.lang);
    const body = (req.body ?? {}) as Body;
    const fields: Fields = {};
    try {
      const route = parseRoute(snap, body, fields);
      const date = parseDate(body, fields);
      failIfFields(fields);
      const flight = findFlight(snap, route!, date!, req.lang);
      const median = flight.quantiles.find((q) => q.q === 0.5)!;
      const bounds = priceBounds(route!);
      return {
        route: route!.code,
        date: flight.date,
        seats: flight.seats,
        bounds,
        basePrice: route!.basePrice,
        costPerPassenger: route!.costPerPassenger,
        modelPrice: median.price,
        points: profitCurve(median.baseDemand, flight.seats, route!, 61, bounds),
        optimum: optimalPrice(median.baseDemand, flight.seats, route!, bounds),
        dataVersion: snap.version,
      };
    } catch (err) {
      throw localizeRouteMissing(err, req.lang);
    }
  });

  // Загрузка по дням месяца при одной цене (дополнение 2).
  app.post('/api/forecast/month', async (req) => {
    requireUser(req);
    const snap = requireData(app, req.lang);
    const body = (req.body ?? {}) as Body;
    const fields: Fields = {};
    try {
      const route = parseRoute(snap, body, fields);
      const price = parsePrice(body.price, fields);
      failIfFields(fields);
      const dates = snap.datesByRoute.get(route!.code) ?? [];
      return {
        route: route!.code,
        price,
        days: dates.map((d) => daySummary(snap.flights.get(flightKey(route!.code, d))!, route!, price!)),
        dataVersion: snap.version,
      };
    } catch (err) {
      throw localizeRouteMissing(err, req.lang);
    }
  });

  // Табло: все направления на одну дату (дополнения 3 и 8).
  app.post('/api/forecast/board', async (req) => {
    requireUser(req);
    const snap = requireData(app, req.lang);
    const body = (req.body ?? {}) as Body;
    const fields: Fields = {};
    const allDates = [...new Set([...snap.datesByRoute.values()].flat())].sort();
    // Без даты показываем первый день прогноза.
    const date = body.date === undefined || body.date === '' ? (allDates[0] ?? null) : parseDate(body, fields);
    failIfFields(fields);
    const mode = body.priceMode === 'model' ? 'model' : 'base';
    const flights = snap.routes.flatMap((route) => {
      const flight = date ? snap.flights.get(flightKey(route.code, date)) : undefined;
      if (!flight) return [];
      const median = flight.quantiles.find((q) => q.q === 0.5)!;
      const price = mode === 'model' && median.price !== null ? median.price : route.basePrice;
      const r = computeForecast(flight, route, price);
      return [
        {
          route: route.code,
          origin: route.origin,
          destination: route.destination,
          price,
          seats: r.seats,
          wants: r.median.wants,
          sales: r.median.sales,
          rounded: r.median.rounded,
          loadFactor: r.median.loadFactor,
          sellOut: r.sellOut,
          status: boardStatus(r.median.wants, r.seats),
          revenue: r.economics.revenue,
        },
      ];
    });
    return { date, priceMode: mode, dates: allDates, flights, dataVersion: snap.version };
  });

  // ---------- История расчётов (дополнение 5) ----------

  const listHistory = (userId: number) => {
    const rows = app.db
      .prepare('SELECT * FROM history WHERE user_id = ? ORDER BY pinned DESC, created_at DESC, id DESC LIMIT 100')
      .all(userId) as unknown as HistoryRow[];
    const snap = app.data.get();
    return rows.map((r) => historyView(r, snap));
  };

  app.get('/api/history', async (req, reply) => {
    const user = requireUser(req);
    reply.header('Cache-Control', 'no-store');
    return { items: listHistory(user.id) };
  });

  app.post('/api/history', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const snap = requireData(app, req.lang);
    const body = (req.body ?? {}) as Body;
    const fields: Fields = {};
    try {
      const route = parseRoute(snap, body, fields);
      const date = parseDate(body, fields);
      const price = parsePrice(body.price, fields);
      failIfFields(fields);
      const flight = findFlight(snap, route!, date!, req.lang);
      const r = computeForecast(flight, route!, price!);
      const now = Date.now();
      const latest = app.db
        .prepare('SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
        .get(user.id) as unknown as HistoryRow | undefined;
      if (latest && latest.route === route!.code && latest.date === flight.date && latest.price === price) {
        // Тот же расчёт подряд не дублируем, только обновляем время и результат.
        app.db
          .prepare('UPDATE history SET created_at = ?, sales = ?, wants = ?, seats = ? WHERE id = ?')
          .run(now, r.median.sales, r.median.wants, r.seats, latest.id);
      } else {
        app.db
          .prepare(
            'INSERT INTO history (user_id, route, date, price, seats, sales, wants, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
          )
          .run(user.id, route!.code, flight.date, price!, r.seats, r.median.sales, r.median.wants, now);
        // Незакреплённых записей храним не больше HISTORY_LIMIT.
        app.db
          .prepare(
            `DELETE FROM history WHERE user_id = ? AND pinned = 0 AND id NOT IN (
               SELECT id FROM history WHERE user_id = ? AND pinned = 0 ORDER BY created_at DESC, id DESC LIMIT ?)`,
          )
          .run(user.id, user.id, HISTORY_LIMIT);
      }
      return { items: listHistory(user.id) };
    } catch (err) {
      throw localizeRouteMissing(err, req.lang);
    }
  });

  const historyId = (req: FastifyRequest) => {
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'history_not_found');
    return id;
  };

  app.patch('/api/history/:id', async (req) => {
    const user = requireUser(req);
    const id = historyId(req);
    const pinned = (req.body as Body | undefined)?.pinned === true ? 1 : 0;
    const res = app.db.prepare('UPDATE history SET pinned = ? WHERE id = ? AND user_id = ?').run(pinned, id, user.id);
    if (Number(res.changes) === 0) throw new HttpError(404, 'history_not_found');
    return { items: listHistory(user.id) };
  });

  app.delete<{ Querystring: { mode?: unknown } }>('/api/history', async (req) => {
    const user = requireUser(req);
    const { mode } = req.query;
    if (mode !== 'all' && mode !== 'unpinned') throw new HttpError(400, 'history_clear_mode');

    app.db.prepare(
      mode === 'all' ? 'DELETE FROM history WHERE user_id = ?' : 'DELETE FROM history WHERE user_id = ? AND pinned = 0',
    ).run(user.id);
    return { items: listHistory(user.id) };
  });

  app.delete('/api/history/:id', async (req) => {
    const user = requireUser(req);
    const id = historyId(req);
    const res = app.db.prepare('DELETE FROM history WHERE id = ? AND user_id = ?').run(id, user.id);
    if (Number(res.changes) === 0) throw new HttpError(404, 'history_not_found');
    return { items: listHistory(user.id) };
  });

  // ---------- Загрузка прогноза администратором (дополнение 6) ----------

  app.get('/api/admin/data', async (req, reply) => {
    requireAdmin(req);
    reply.header('Cache-Control', 'no-store');
    return {
      data: dataInfo(app, req.lang, true),
      backups: {
        forecast: fs.existsSync(`${app.data.forecastPath}.bak`),
        routes: fs.existsSync(`${app.data.routesPath}.bak`),
      },
      uploadMaxMb: app.config.uploadMaxMb,
    };
  });

  app.get<{ Params: { kind: string } }>('/api/admin/download/:kind', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    requireAdmin(req);
    const { kind } = req.params;
    if (kind !== 'forecast' && kind !== 'routes') throw new HttpError(404, 'api_not_found');

    let version: ReturnType<typeof app.data.readFileVersion>;
    try {
      version = await app.data.downloadFile(kind);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'download_not_found');
      req.log.error({ err, kind }, 'Не удалось прочитать CSV для скачивания');
      throw new HttpError(500, 'download_read_failed');
    }

    const { name, content } = version;
    const asciiName = /^[A-Za-z0-9_. -]+$/.test(name) ? ` filename="${name}";` : '';
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment;${asciiName} filename*=UTF-8''${encoded}`)
      .send(content);
  });

  app.post(
    '/api/admin/upload',
    { bodyLimit: app.config.uploadMaxMb * 1024 * 1024 * 2 + 4096, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      requireAdmin(req);
      const body = (req.body ?? {}) as Body;
      const kind = body.kind === 'forecast' || body.kind === 'routes' ? body.kind : null;
      if (!kind) throw new HttpError(400, 'upload_kind');
      const filename = typeof body.filename === 'string' ? body.filename : undefined;
      const content = typeof body.content === 'string' ? body.content : '';
      if (!content.trim()) throw new HttpError(400, 'upload_empty');
      if (Buffer.byteLength(content, 'utf8') > app.config.uploadMaxMb * 1024 * 1024) {
        throw new HttpError(413, 'upload_too_large', { mb: app.config.uploadMaxMb });
      }

      const current = app.data.get();
      // Даже если текущие данные сломаны или файла нет, администратор может загрузить исправленный.
      const texts = app.data.readCurrentTexts();
      if (kind === 'forecast') texts.forecast = content;
      else texts.routes = content;

      let next: DatasetSnapshot;
      try {
        const fake = { name: filename ?? kind, size: Buffer.byteLength(content), modifiedAt: new Date().toISOString() };
        next = buildSnapshot(texts.routes, texts.forecast, {
          version: 0,
          replacingRoutes: kind === 'routes',
          source: {
            forecast: kind === 'forecast' ? fake : (current?.source.forecast ?? app.data.fileInfoOrEmpty('forecast')),
            routes: kind === 'routes' ? fake : (current?.source.routes ?? app.data.fileInfoOrEmpty('routes')),
          },
        });
      } catch (err) {
        const text = toLoadError(err).text(req.lang);
        return { ok: false, applied: false, error: text };
      }

      const summary = summarize(next);
      const diff = current ? compare(current, next) : null;
      const warnings = next.warnings.map((w) => render(req.lang, w));

      if (body.apply === true) {
        try {
          app.data.replaceFile(kind, Buffer.from(content), filename);
        } catch (err) {
          throw new HttpError(500, 'upload_write_failed', { reason: (err as Error).message });
        }
        req.log.info({ kind, flights: summary.flights }, 'Администратор заменил файл данных');
        return { ok: true, applied: true, summary, diff, warnings, data: dataInfo(app, req.lang, true) };
      }
      return { ok: true, applied: false, summary, diff, warnings };
    },
  );

  app.post('/api/admin/restore', async (req) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as Body;
    const kind = body.kind === 'forecast' || body.kind === 'routes' ? body.kind : null;
    if (!kind) throw new HttpError(400, 'upload_kind');
    let backup: ReturnType<typeof app.data.readFileVersion>;
    try {
      backup = app.data.readFileVersion(kind, true);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'not_found');
      throw err;
    }
    app.data.replaceFile(kind, backup.content, backup.name);
    return { ok: true, data: dataInfo(app, req.lang, true) };
  });
}

function summarize(s: DatasetSnapshot) {
  const dates = [...new Set([...s.datesByRoute.values()].flat())].sort();
  return {
    flights: s.flights.size,
    routes: s.routes.map((r) => r.code),
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
    quantileLevels: s.quantileLevels,
  };
}

/** Изменения в справочнике, количестве рейсов и средней медиане спроса. */
function compare(prev: DatasetSnapshot, next: DatasetSnapshot) {
  const prevRoutes = new Set(prev.routes.map((r) => r.code));
  const nextRoutes = new Set(next.routes.map((r) => r.code));
  const avgMedian = (s: DatasetSnapshot, code: string) => {
    const dates = s.datesByRoute.get(code) ?? [];
    if (!dates.length) return null;
    const sum = dates.reduce((acc, d) => acc + s.flights.get(flightKey(code, d))!.quantiles.find((q) => q.q === 0.5)!.baseDemand, 0);
    return sum / dates.length;
  };
  let changedFlights = 0;
  for (const [key, f] of next.flights) {
    const old = prev.flights.get(key);
    if (!old || old.seats !== f.seats || JSON.stringify(old.quantiles) !== JSON.stringify(f.quantiles)) changedFlights++;
  }
  const removedFlights = [...prev.flights.keys()].filter((k) => !next.flights.has(k)).length;
  const perRoute = [...new Set([...prevRoutes, ...nextRoutes])].sort().map((code) => {
    const before = avgMedian(prev, code);
    const after = avgMedian(next, code);
    return {
      route: code,
      before: before === null ? null : Math.round(before * 10) / 10,
      after: after === null ? null : Math.round(after * 10) / 10,
      deltaPct: before && after !== null ? Math.round(((after - before) / before) * 1000) / 10 : null,
    };
  });
  return {
    addedRoutes: [...nextRoutes].filter((r) => !prevRoutes.has(r)),
    removedRoutes: [...prevRoutes].filter((r) => !nextRoutes.has(r)),
    changedFlights,
    removedFlights,
    perRoute,
  };
}
