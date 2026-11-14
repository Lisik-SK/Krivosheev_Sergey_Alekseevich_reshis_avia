#!/usr/bin/env node
/**
 * Проверка деплоя на своей машине (нужен запущенный Docker).
 *
 *   node scripts/deploy-smoke.mjs          — всё проверить и убрать за собой
 *   node scripts/deploy-smoke.mjs --keep   — оставить собранный образ
 *
 * Что проверяется:
 *   1. Конфиги PM2 и systemd указывают на существующий собранный сервер (нужен npm run build).
 *   2. Docker-образ собирается.
 *   3. Контейнер стартует, /api/health отвечает "ok", процесс работает не от root.
 *   4. Папки storage/ и data/ в контейнере доступны на запись (иначе не работают регистрация и загрузка CSV).
 *   5. Заголовки безопасности на месте, регистрация и расчёт работают (704,5 из условия).
 *   6. Встроенный HEALTHCHECK образа переводит контейнер в состояние healthy.
 *   7. nginx с deploy/nginx.conf проходит nginx -t и правильно проксирует: регистрация через прокси
 *      проходит проверку Origin (порт в заголовке Host сохраняется).
 *   8. COOKIE_SECURE=auto за HTTPS-прокси ставит cookie флаг Secure.
 *   9. Пользователи переживают перезапуск контейнера (storage на томе).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const KEEP = process.argv.includes('--keep');
const ID = `ra-smoke-${randomBytes(3).toString('hex')}`;
const IMAGE = `${ID}:latest`;
const NET = `${ID}-net`;
const APP = `${ID}-app`;
const NGINX = `${ID}-nginx`;
const VOL = `${ID}-storage`;
const APP_PORT = Number(process.env.SMOKE_APP_PORT ?? 3398);
const NGINX_PORT = Number(process.env.SMOKE_NGINX_PORT ?? 3397);
const NGINX_IMAGE = process.env.SMOKE_NGINX_IMAGE ?? 'nginx:1.27-alpine';
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const PROXY_URL = `http://127.0.0.1:${NGINX_PORT}`;

const results = [];
let failed = 0;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function docker(args, { inherit = false, allowFail = false } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  if (r.error) throw new Error(`не удалось запустить docker: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.join(' ')} → код ${r.status}\n${(r.stderr ?? '').trim() || (r.stdout ?? '').trim()}`);
  }
  return (r.stdout ?? '').trim();
}

function ok(cond, message) {
  if (!cond) throw new Error(message);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    log(`  ✓ ${name}${note ? ` — ${note}` : ''} (${((Date.now() - started) / 1000).toFixed(1)} с)`);
    return true;
  } catch (err) {
    failed++;
    results.push({ name, ok: false });
    log(`  ✗ ${name}\n      ${String(err instanceof Error ? err.message : err).replace(/\n/g, '\n      ')}`);
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(1000);
  }
  throw new Error(`не дождались: ${what}${last ? ` (последняя ошибка: ${last})` : ''}`);
}

async function health(base) {
  const res = await fetch(`${base}/api/health`);
  if (res.status !== 200) return null;
  const body = await res.json();
  return body.status === 'ok' ? body : null;
}

function cookieOf(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  return all.find((c) => c.trim().length > 0) ?? '';
}

/** origin: по умолчанию — адрес сервера (как у браузера); пустая строка — без заголовка Origin. */
async function postJson(base, url, body, { cookie, origin = base, headers = {} } = {}) {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

const user = {
  name: 'Smoke Test',
  email: `smoke.${randomBytes(4).toString('hex')}@example.test`,
  password: `Pw-${randomBytes(6).toString('hex')}-9z`,
};

async function main() {
  log(`\nПроверка деплоя «Решись Авиа» (метка запуска ${ID})\n`);

  log('Конфиги без Docker:');
  await step('PM2: deploy/ecosystem.config.cjs указывает на собранный сервер, 1 процесс', () => {
    const require = createRequire(import.meta.url);
    const cfg = require(path.join(ROOT, 'deploy', 'ecosystem.config.cjs'));
    const app = cfg.apps?.[0];
    ok(app, 'в ecosystem.config.cjs нет apps[0]');
    const script = path.resolve(app.cwd ?? ROOT, app.script);
    ok(fs.existsSync(script), `файл ${path.relative(ROOT, script)} не найден — выполните npm run build`);
    ok(app.instances === 1, `instances = ${app.instances}, а SQLite рассчитан на один процесс`);
    ok(app.env?.TRUST_PROXY === 'loopback', 'за локальным nginx нужен TRUST_PROXY=loopback');
  });
  await step('systemd: deploy/reshis-avia.service запускает тот же файл сервера', () => {
    const unit = fs.readFileSync(path.join(ROOT, 'deploy', 'reshis-avia.service'), 'utf8');
    const exec = unit.match(/^ExecStart=(.+)$/m)?.[1] ?? '';
    ok(exec.includes('dist/node/server/index.js'), `ExecStart не указывает на dist/node/server/index.js: ${exec}`);
    ok(/^WorkingDirectory=/m.test(unit), 'нет WorkingDirectory');
    ok(/^User=(?!root)/m.test(unit), 'сервис должен работать не от root (User=...)');
    ok(/^Restart=/m.test(unit), 'нет Restart= — сервис не поднимется после сбоя');
  });

  log('\nDocker:');
  if (!(await step('Docker доступен', () => `сервер ${docker(['version', '--format', '{{.Server.Version}}'])}`))) {
    log('\nDocker не запущен — остальные проверки пропущены.');
    return;
  }
  if (!(await step('образ собирается (docker build)', () => {
    docker(['build', '-t', IMAGE, '.'], { inherit: true });
    const size = Number(docker(['image', 'inspect', IMAGE, '--format', '{{.Size}}']));
    return `${Math.round(size / 1024 / 1024)} МБ`;
  }))) return;

  docker(['network', 'create', NET]);
  docker(['volume', 'create', VOL]);

  const started = await step('контейнер стартует, /api/health = ok', async () => {
    docker(['run', '-d', '--name', APP, '--network', NET, '-p', `127.0.0.1:${APP_PORT}:3000`, '-v', `${VOL}:/app/storage`, '-e', 'TRUST_PROXY=uniquelocal', IMAGE]);
    try {
      const body = await waitFor('ответ /api/health', () => health(APP_URL), 60_000);
      return `рейсов: ${body.data?.flights}`;
    } catch (err) {
      log(docker(['logs', APP], { allowFail: true }));
      throw err;
    }
  });
  if (!started) return;

  await step('процесс в контейнере работает не от root', () => {
    const who = docker(['exec', APP, 'id', '-un']);
    ok(who !== 'root', `пользователь: ${who}`);
    return `пользователь ${who}`;
  });
  await step('storage/ и data/ доступны на запись', () => {
    docker(['exec', APP, 'sh', '-c', 'touch /app/storage/.w && rm /app/storage/.w']);
    docker(['exec', APP, 'sh', '-c', 'touch /app/data/.w && rm /app/data/.w']);
  });
  await step('заголовки безопасности на главной странице', async () => {
    const res = await fetch(`${APP_URL}/`);
    ok(res.status === 200, `GET / → ${res.status}`);
    const csp = res.headers.get('content-security-policy') ?? '';
    ok(csp.includes("script-src 'self'"), `CSP: ${csp || 'нет заголовка'}`);
    ok(res.headers.get('x-content-type-options') === 'nosniff', 'нет X-Content-Type-Options: nosniff');
    ok(/frame-ancestors 'none'/.test(csp) || res.headers.get('x-frame-options'), 'страницу можно встроить во фрейм');
  });
  let cookie = '';
  await step('регистрация и расчёт напрямую (704,5 из условия)', async () => {
    const reg = await postJson(APP_URL, '/api/auth/register', user);
    ok(reg.status === 201, `регистрация → ${reg.status}: ${await reg.text()}`);
    cookie = cookieOf(reg).split(';')[0];
    ok(cookie, 'сервер не выдал cookie сессии');
    const f = await postJson(APP_URL, '/api/forecast', { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9500 }, { cookie });
    ok(f.status === 200, `расчёт → ${f.status}`);
    const body = await f.json();
    ok(body.median?.wants === 704.5, `median.wants = ${body.median?.wants}, ожидалось 704.5`);
  });
  await step('COOKIE_SECURE=auto: за HTTPS-прокси cookie получает флаг Secure', async () => {
    // Origin не передаём: имитируем прокси, который сам завершает HTTPS.
    const res = await postJson(APP_URL, '/api/auth/login', { email: user.email, password: user.password }, { origin: '', headers: { 'X-Forwarded-Proto': 'https' } });
    ok(res.status === 200, `вход → ${res.status}`);
    ok(/;\s*secure/i.test(cookieOf(res)), `Set-Cookie без Secure: ${cookieOf(res)}`);
    const plain = await postJson(APP_URL, '/api/auth/login', { email: user.email, password: user.password });
    ok(!/;\s*secure/i.test(cookieOf(plain)), 'по обычному HTTP cookie не должна быть Secure, иначе браузер её не сохранит');
  });
  await step('встроенный HEALTHCHECK образа: статус healthy', async () => {
    const status = await waitFor(
      'docker health = healthy (проверка раз в 30 с)',
      () => {
        const s = docker(['inspect', '-f', '{{.State.Health.Status}}', APP]);
        if (s === 'unhealthy') throw new Error('контейнер unhealthy');
        return s === 'healthy' ? s : null;
      },
      100_000,
    );
    return status;
  });

  log('\nnginx (deploy/nginx.conf):');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-nginx-'));
  const conf = fs
    .readFileSync(path.join(ROOT, 'deploy', 'nginx.conf'), 'utf8')
    .replace(/proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/, `proxy_pass http://${APP}:3000;`)
    .replace(/server_name\s+[^;]+;/, 'server_name _;');
  const confPath = path.join(tmpDir, 'default.conf');
  fs.writeFileSync(confPath, conf);
  try {
    await step('nginx -t: конфиг корректен', () => {
      docker(['run', '--rm', '--network', NET, '-v', `${confPath}:/etc/nginx/conf.d/default.conf:ro`, NGINX_IMAGE, 'nginx', '-t']);
    });
    const proxy = await step('nginx запускается и проксирует /api/health', async () => {
      docker(['run', '-d', '--name', NGINX, '--network', NET, '-p', `127.0.0.1:${NGINX_PORT}:80`, '-v', `${confPath}:/etc/nginx/conf.d/default.conf:ro`, NGINX_IMAGE]);
      await waitFor('ответ через nginx', () => health(PROXY_URL), 30_000);
    });
    if (proxy) {
      await step('через nginx: регистрация проходит проверку Origin, вход и расчёт работают', async () => {
        const second = { ...user, email: `proxy.${user.email}` };
        const reg = await postJson(PROXY_URL, '/api/auth/register', second);
        ok(reg.status === 201, `регистрация через прокси → ${reg.status}: ${await reg.text()}`);
        const login = await postJson(PROXY_URL, '/api/auth/login', { email: second.email, password: second.password });
        ok(login.status === 200, `вход через прокси → ${login.status}`);
        const c = cookieOf(login).split(';')[0];
        const f = await postJson(PROXY_URL, '/api/forecast', { from: 'MOW', to: 'AER', date: '2026-06-01', price: 9500 }, { cookie: c });
        ok(f.status === 200, `расчёт через прокси → ${f.status}`);
        ok((await f.json()).median?.wants === 704.5, 'неверный расчёт через прокси');
      });
      await step('через nginx: запрос с чужого Origin отклоняется', async () => {
        const res = await postJson(PROXY_URL, '/api/auth/login', { email: user.email, password: user.password }, { origin: 'https://evil.example' });
        ok(res.status === 403, `ожидался 403, получен ${res.status}`);
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  log('\nПостоянство данных:');
  await step('пользователь переживает перезапуск контейнера', async () => {
    docker(['restart', APP]);
    await waitFor('ответ /api/health после перезапуска', () => health(APP_URL), 60_000);
    const res = await postJson(APP_URL, '/api/auth/login', { email: user.email, password: user.password });
    ok(res.status === 200, `вход после перезапуска → ${res.status} (storage не на томе?)`);
  });
}

function cleanup() {
  for (const c of [NGINX, APP]) docker(['rm', '-f', c], { allowFail: true });
  docker(['network', 'rm', NET], { allowFail: true });
  docker(['volume', 'rm', VOL], { allowFail: true });
  if (!KEEP) docker(['image', 'rm', IMAGE], { allowFail: true });
}

try {
  await main();
} catch (err) {
  failed++;
  log(`\nНепредвиденная ошибка: ${err instanceof Error ? err.stack : err}`);
} finally {
  try {
    cleanup();
  } catch {
    /* docker недоступен — убирать нечего */
  }
}

const passed = results.filter((r) => r.ok).length;
log(`\nИтог: ${passed} из ${results.length} проверок прошли${failed ? `, ошибок: ${failed}` : ''}.`);
process.exit(failed ? 1 : 0);
