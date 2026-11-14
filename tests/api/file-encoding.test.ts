/** Проверяет сохранение рабочего снимка, когда CSV на диске записали в неверной кодировке. */
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { msg } from '../../src/shared/messages';
import { DATA_ROUTES, makeApp, makeTempDir, meta, registerUser } from './helpers';

it('сохраняет снимок после прямой замены CSV в Windows-1251 и загружает исправленный UTF-8 с BOM', async () => {
  const dir = makeTempDir('file-encoding');
  const routesPath = path.join(dir, 'routes.csv');
  const staged = path.join(dir, 'incoming.csv');
  const routesText = fs.readFileSync(DATA_ROUTES, 'utf8');
  fs.writeFileSync(routesPath, routesText);
  const app = await makeApp({ routesPath });

  try {
    const { token } = await registerUser(app);
    const before = (await meta(app, token)).json();

    // Имя города в Windows-1251 делает CSV некорректным UTF-8 даже при читаемой схеме.
    const [head, tail] = routesText.split('Москва', 2);
    expect(head).toBeDefined();
    expect(tail).toBeDefined();
    const moscowOffset = Buffer.byteLength(head!, 'utf8');
    const original = Buffer.from(routesText);
    const wrongEncoding = Buffer.concat([
      original.subarray(0, moscowOffset),
      Buffer.from([0xcc, 0xee, 0xf1, 0xea, 0xe2, 0xe0]),
      original.subarray(moscowOffset + Buffer.byteLength('Москва')),
    ]);
    fs.writeFileSync(staged, wrongEncoding);
    fs.renameSync(staged, routesPath);

    const ruError = msg('ru', 'file_invalid_encoding', { what: 'what_routes' });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'degraded', data: { ok: false, error: ruError } });
    const degraded = (await meta(app, token, { 'x-lang': 'en' })).json();
    expect(degraded.data).toMatchObject({
      version: before.data.version,
      error: msg('en', 'file_invalid_encoding', { what: 'what_routes' }),
    });
    expect(degraded.routes).toEqual(before.routes);

    fs.writeFileSync(staged, `\uFEFF${routesText.replaceAll('Москва', 'Москва (новая версия)')}`);
    fs.renameSync(staged, routesPath);

    const after = (await meta(app, token)).json();
    expect(after.data).toMatchObject({ ok: true, error: null, version: before.data.version + 1 });
    expect(after.routes[0].origin.name).toBe('Москва (новая версия)');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
