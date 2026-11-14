import type { FullConfig } from '@playwright/test';
import { ADMIN } from './admin-user';

/** Проверяет владельца, созданного при запуске сервера с чистым хранилищем. */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!;
  const res = await fetch(`${baseURL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseURL },
    body: JSON.stringify(ADMIN),
  });
  const body = (await res.json()) as { user?: { role?: string } };
  if (res.status !== 200 || body.user?.role !== 'admin') {
    throw new Error(`Не удалось войти как владелец тестового сайта (HTTP ${res.status}).`);
  }
}
