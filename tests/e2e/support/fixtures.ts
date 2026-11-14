import { test as base, expect, type Page, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { chooseOption } from './pickers';

export interface Problems {
  /** Разрешить ожидаемые ошибки консоли (например, «Failed to load resource … 401» при неверном пароле). */
  allow(re: RegExp): void;
  readonly list: string[];
}

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

/**
 * Автоматическая фикстура: в каждом тесте собирает ошибки консоли, необработанные
 * исключения страницы и нарушения CSP (securitypolicyviolation) и в конце требует, чтобы их не было.
 */
export const test = base.extend<{ problems: Problems }>({
  problems: [
    async ({ page }, use) => {
      const list: string[] = [];
      const allowed: RegExp[] = [];
      await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__cspViolations!.push(`${e.violatedDirective} ${e.blockedURI}`);
        });
      });
      page.on('console', (msg) => {
        if (msg.type() === 'error' || /Content Security Policy/i.test(msg.text())) list.push(`console.${msg.type()}: ${msg.text()}`);
      });
      page.on('pageerror', (err) => list.push(`pageerror: ${err.message}`));
      await use({ allow: (re) => allowed.push(re), list });

      const csp = await page
        .evaluate(() => window.__cspViolations ?? [])
        .catch(() => [] as string[]);
      for (const v of csp) list.push(`csp-violation: ${v}`);
      const unexpected = list.filter((m) => !allowed.some((re) => re.test(m)));
      expect(unexpected, 'console errors / page errors / CSP violations').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
export { chooseOption };

export function newUser(prefix = 'e2e'): TestUser {
  const id = randomUUID().slice(0, 8);
  return { name: `Тест ${id}`, email: `${prefix}.${id}@example.com`, password: `Pa55-${randomUUID().slice(0, 12)}` };
}

/** Регистрация через API (cookie попадает в контекст браузера), затем открытие страницы. */
export async function registerViaApi(page: Page, user: TestUser = newUser()): Promise<TestUser> {
  const res = await page.request.post('/api/auth/register', { data: user });
  expect(res.status(), await res.text()).toBe(201);
  return user;
}

export function isForecast(res: Response): boolean {
  return res.url().endsWith('/api/forecast') && res.request().method() === 'POST';
}

export function waitForecast(page: Page) {
  return page.waitForResponse(isForecast);
}

/**
 * Регистрирует пользователя и открывает первый расчёт с явно заданными параметрами.
 * @param page Страница Playwright, в контексте которой создаётся сессия.
 * @param query Необязательная строка параметров URL, по умолчанию пустая. Переданные ключи
 * заменяют исходные значения для расчёта Москва — Сочи на 1 июня 2026 года по цене 9000.
 * @returns Новый пользователь после успешного ответа прогноза и отрисовки результата.
 * @throws Ошибки регистрации, навигации и ожидания, включая ответ прогноза с кодом, отличным от 200.
 * @remarks Создаёт пользователя и сессию через API, затем запускает расчёт переходом по ссылке.
 * При ошибке не удаляет созданного пользователя и не повторяет запросы.
 */
export async function openApp(page: Page, query = ''): Promise<TestUser> {
  const params = new URLSearchParams({ from: 'MOW', to: 'AER', date: '2026-06-01', price: '9000' });
  for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
  const user = await registerViaApi(page);
  const first = waitForecast(page);
  await page.goto(`/?${params}`);
  expect((await first).status()).toBe(200);
  await settled(page);
  return user;
}

/**
 * Устанавливает параметры через видимые поля и ожидает автоматический расчёт.
 * @param page Открытая страница Playwright с загруженным калькулятором.
 * @param q Параметры без значения по умолчанию: необязательный to — код доступного направления,
 * date — доступная дата ISO YYYY-MM-DD, price — допустимое число или строка цены; пропущенные поля сохраняются.
 * @returns Promise с JSON успешного ответа прогноза для запрошенных параметров.
 * @throws Ошибки Playwright и проверок при недоступных полях, таймауте или ответе не 200; повторы не выполняются.
 * @remarks Последовательно выбирает направление, вводит дату, затем цену; ждёт ответы зависимых шагов
 * и завершение рендера. Вызывает запросы приложения и обновление URL/истории; при ошибке введённые значения не откатывает.
 */
export async function calculate(page: Page, q: { to?: string; date?: string; price?: number | string }) {
  if (q.to !== undefined && (await page.getByTestId('to').inputValue()) !== q.to) {
    const r = waitForecast(page);
    await chooseOption(page, 'to', q.to);
    await r;
  }
  if (q.date !== undefined && (await page.getByTestId('date').inputValue()) !== q.date) {
    const r = waitForecast(page);
    await page.getByTestId('date-display').fill(q.date);
    await r;
  }
  // Ждём ответ именно на наши параметры (в полёте может быть запрос по debounce).
  const resP = page.waitForResponse((res) => {
    if (!isForecast(res)) return false;
    const body = res.request().postDataJSON() as { date: string; price: number; to: string };
    return (
      (q.price === undefined || body.price === Number(q.price)) &&
      (q.date === undefined || body.date === q.date) &&
      (q.to === undefined || body.to === q.to)
    );
  });
  const price = page.getByTestId('price');
  if (q.price === undefined || (await price.inputValue()) === String(q.price)) await price.dispatchEvent('input');
  else await price.fill(String(q.price));
  const res = await resP;
  expect(res.status()).toBe(200);
  await settled(page);
  return res.json();
}

/** Результат отрисован: класс is-loading снимается только после renderResult. */
export async function settled(page: Page) {
  await expect(page.getByTestId('results')).not.toHaveClass(/is-loading/);
  await expect(page.getByTestId('sales')).toBeVisible();
}

/** Текст элемента без пробелов любого вида. */
export async function textOf(page: Page, testId: string): Promise<string> {
  const t = await page.getByTestId(testId).textContent();
  return (t ?? '').replace(/[\s   ]/g, '').replace(/−/g, '-');
}

/** Ведущее число из текста элемента (например «705билетов» → «705»). */
export async function numberOf(page: Page, testId: string): Promise<string> {
  const t = await textOf(page, testId);
  return t.match(/^-?\d+(?:,\d+)?/)?.[0] ?? t;
}

/** Вход под владельцем, созданным при запуске тестового сервера. */
export async function loginAdmin(page: Page): Promise<void> {
  const { ADMIN } = await import('./admin-user');
  const res = await page.request.post('/api/auth/login', { data: { email: ADMIN.email, password: ADMIN.password } });
  expect(res.status(), await res.text()).toBe(200);
  expect(((await res.json()) as { user: { role: string } }).user.role).toBe('admin');
}

/** Ответ на запрос прогноза с заданной ценой. */
export function forecastAt(page: Page, price: number) {
  return page.waitForResponse((res) => isForecast(res) && (res.request().postDataJSON() as { price: number }).price === price);
}
