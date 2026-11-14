import { buildApp } from './app.js';

const app = await buildApp();
const { host, port } = app.config;

try {
  const adminEmail = process.env.INITIAL_ADMIN_EMAIL?.trim();
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD;
  if (adminEmail || adminPassword) {
    if (!adminEmail || !adminPassword) {
      throw new Error('Для первичной настройки задайте INITIAL_ADMIN_EMAIL и INITIAL_ADMIN_PASSWORD.');
    }
    await app.auth.ensureInitialAdmin(adminEmail, adminPassword);
  }
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`Получен ${signal}, останавливаем сервер`);
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
