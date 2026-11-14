/**
 * Внешний вид.
 *
 * 1. «Вёрстка без эталонов» — проверки, которые работают с первого запуска:
 *    шрифты загрузились, элементы шапки не наезжают друг на друга, содержимое
 *    не вылезает за карточки, текст не обрезан.
 * 2. «Скриншоты» (тег @visual) — сравнение с эталонными картинками. При первом запуске
 *    эталонов нет: создайте их флагом --update-snapshots и просмотрите глазами (см. README).
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect, openApp, registerViaApi, settled, loginAdmin } from '../e2e/support/fixtures';
import { NETWORK_NOISE, patchedForecast, stable, useLang, useTheme } from './support/extra';

const Q = '?from=MOW&to=AER&date=2026-06-01&price=9500';
type Theme = 'light' | 'dark';

test.use({ reducedMotion: 'reduce' });

// ---------------------------------------------------------------------------
// Проверки вёрстки, не требующие эталонов
// ---------------------------------------------------------------------------

/** Список проблем вёрстки на текущем экране. */
async function layoutProblems(page: Page): Promise<string[]> {
  await stable(page);
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}.${[...el.classList].join('.')}`;

    // 1. Элементы шапки не перекрываются
    const head = [
      ...document.querySelectorAll(
        '.topbar .brand, .topbar .nav__link, [data-testid=history-open], [data-testid=lang-toggle], [data-testid=theme-toggle], [data-testid=user-chip], [data-testid=logout], .auth__top .brand, .auth__controls > *',
      ),
    ].filter(visible);
    for (let i = 0; i < head.length; i++) {
      for (let j = i + 1; j < head.length; j++) {
        const a = head[i]!.getBoundingClientRect();
        const b = head[j]!.getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) out.push(`шапка: ${name(head[i]!)} наезжает на ${name(head[j]!)}`);
      }
    }

    // 2. Содержимое не вылезает за карточку по горизонтали
    for (const card of document.querySelectorAll('.card, .auth__card')) {
      if (!visible(card)) continue;
      const c = card.getBoundingClientRect();
      for (const el of card.querySelectorAll('*')) {
        if (el.closest('.table-wrap, .tooltip, .sr-only, [aria-hidden="true"]')) continue;
        if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.right > c.right + 1 || r.left < c.left - 1) {
          out.push(`карточка: ${name(el)} выходит за край (${Math.round(r.left)}…${Math.round(r.right)} при карточке ${Math.round(c.left)}…${Math.round(c.right)})`);
          break; // одной находки на карточку достаточно
        }
      }
    }

    // 3. Текст не обрезан и не вылезает за свой элемент
    for (const el of document.querySelectorAll<HTMLElement>('.btn, .seg__btn, .tabs__btn, .stat__value, .page__title, .card__title, .nav__link')) {
      if (!visible(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`текст не помещается: ${name(el)} «${(el.textContent ?? '').trim().slice(0, 40)}» (${el.scrollWidth} > ${el.clientWidth})`);
    }

    // 4. Нет горизонтальной прокрутки страницы
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      out.push(`страница шире экрана: ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`);
    }
    return out;
  });
}

async function fontsLoaded(page: Page): Promise<string[]> {
  await stable(page);
  return page.evaluate(() => {
    const loaded = new Set<string>();
    document.fonts.forEach((f) => {
      if (f.status === 'loaded') loaded.add(f.family.replace(/["']/g, ''));
    });
    return [...loaded];
  });
}

test.describe('Вёрстка без эталонов', () => {
  test('фирменные шрифты IBM Plex загрузились и применены', async ({ page }) => {
    await openApp(page, Q);
    const families = await fontsLoaded(page);
    expect(families, 'загруженные шрифты').toContain('IBM Plex Sans');
    expect(families, 'загруженные шрифты').toContain('IBM Plex Mono');
    const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(body).toMatch(/IBM Plex Sans/);
  });

  for (const theme of ['light', 'dark'] as Theme[]) {
    test(`вход: ничего не наезжает (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto('/');
      await expect(page.getByTestId('login-form')).toBeVisible();
      expect(await layoutProblems(page)).toEqual([]);
      await page.getByRole('tab', { name: 'Регистрация' }).click();
      await page.getByTestId('register-form').getByRole('button', { name: 'Создать аккаунт' }).click();
      expect(await layoutProblems(page), 'регистрация с ошибками').toEqual([]);
    });

    test(`расчёт со сравнением: ничего не наезжает (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await openApp(page, `${Q}&b=10000`);
      await expect(page.getByTestId('compare-card')).toBeVisible();
      expect(await layoutProblems(page)).toEqual([]);
      await page.getByTestId('table-toggle').click();
      expect(await layoutProblems(page), 'режим «Таблица»').toEqual([]);
    });

    test(`табло: ничего не наезжает (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await registerViaApi(page);
      await page.goto('/board?date=2026-06-12');
      await expect(page.getByTestId('board-table')).toBeVisible();
      await expect(page.getByTestId('route-map').locator('.map__route')).toHaveCount(5);
      expect(await layoutProblems(page)).toEqual([]);
    });
  }

  test('английский интерфейс: длинные подписи помещаются', async ({ page }) => {
    await useLang(page, 'en');
    await openApp(page, `${Q}&b=10000`);
    expect(await layoutProblems(page)).toEqual([]);
    await page.getByTestId('nav-board').click();
    await expect(page.getByTestId('board-table')).toBeVisible();
    expect(await layoutProblems(page), 'табло (EN)').toEqual([]);
  });

  test('экран «Данные» с проверенным файлом: ничего не наезжает', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-file').setInputFiles({ name: 'seasonal_forecast.csv', mimeType: 'text/csv', buffer: Buffer.from(patchedForecast({ '0.5_base_demand': '850' })) });
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    expect(await layoutProblems(page)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Скриншоты (сравнение с эталонами)
// ---------------------------------------------------------------------------

/** Меняющиеся от запуска к запуску места закрываем плашкой. */
function masks(page: Page): Locator[] {
  return [page.getByTestId('user-chip'), page.locator('footer'), page.locator('.hist__time'), page.getByTestId('admin-current')];
}

async function snap(page: Page, name: string, target?: Locator, fullPage = true) {
  if (target) await target.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await stable(page);
  if (target) await expect(target).toHaveScreenshot(`${name}.png`, { mask: masks(page) });
  else await expect(page).toHaveScreenshot(`${name}.png`, { fullPage, mask: masks(page) });
}

test.describe('Скриншоты', { tag: '@visual' }, () => {
  test.beforeEach(({ browserName, problems }) => {
    if (browserName !== 'webkit') return;
    // Playwright вставляет временный style с body {} для синхронизации анимаций в WebKit.
    problems.allow(/^csp-violation: style-src-elem inline$/);
    problems.allow(/^console\.error: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.$/);
  });
  for (const theme of ['light', 'dark'] as Theme[]) {
    test(`вход (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto('/');
      await expect(page.getByTestId('login-form')).toBeVisible();
      await snap(page, `login-${theme}`);
    });

    test(`расчёт (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await openApp(page, Q);
      await snap(page, `calculator-${theme}`);
    });

    test(`табло (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await registerViaApi(page);
      await page.goto('/board?date=2026-06-12');
      await expect(page.getByTestId('board-table')).toBeVisible();
      await expect(page.getByTestId('route-map').locator('.map__route')).toHaveCount(5);
      await snap(page, `board-${theme}`);
    });
  }

  test('регистрация с ошибками проверки', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Регистрация' }).click();
    await page.getByTestId('register-form').getByRole('button', { name: 'Создать аккаунт' }).click();
    await expect(page.getByTestId('register-form').locator('[aria-invalid="true"]').first()).toBeVisible();
    await snap(page, 'register-errors');
  });

  test('таблица сценариев', async ({ page }) => {
    await openApp(page, Q);
    await page.getByTestId('table-toggle').click();
    await expect(page.getByTestId('scenario-table')).toBeVisible();
    await snap(page, 'scenario-table', page.locator('.chart-card'));
  });

  test('сравнение двух цен', async ({ page }) => {
    await openApp(page, `${Q}&b=10000`);
    await expect(page.getByTestId('compare-card')).toBeVisible();
    await snap(page, 'compare', page.getByTestId('compare-card'));
  });

  test('подсказка на графике', async ({ page }) => {
    await openApp(page, Q);
    const chart = page.getByTestId('demand-chart');
    await chart.locator('.hit').nth(4).focus();
    await expect(chart.locator('.tooltip')).toBeVisible();
    await snap(page, 'chart-tooltip', page.locator('.chart-card'));
  });

  test('кривая дохода и календарь', async ({ page }) => {
    await openApp(page, Q);
    await snap(page, 'profit-curve', page.getByTestId('curve-card'));
    await snap(page, 'calendar', page.getByTestId('calendar-card'));
  });

  test('панель истории', async ({ page }) => {
    await openApp(page, Q);
    await expect
      .poll(async () => ((await (await page.request.get('/api/history')).json()) as { items: unknown[] }).items.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await page.getByTestId('history-open').click();
    await expect(page.getByTestId('history-item').first()).toBeVisible();
    await snap(page, 'history-drawer', undefined, false);
  });

  test('экран «Данные» с проверенным файлом', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/admin');
    await page.getByTestId('admin-file').setInputFiles({ name: 'seasonal_forecast.csv', mimeType: 'text/csv', buffer: Buffer.from(patchedForecast({ '0.5_base_demand': '850' })) });
    await expect(page.getByTestId('admin-valid')).toBeVisible();
    await snap(page, 'admin-preview', page.getByTestId('admin-preview'));
  });

  test('английский интерфейс', async ({ page }) => {
    await useLang(page, 'en');
    await openApp(page, Q);
    await snap(page, 'calculator-en');
  });

  test('ошибка сети при расчёте', async ({ page, problems }) => {
    problems.allow(NETWORK_NOISE);
    await openApp(page, Q);
    await page.route('**/api/forecast', (r) => r.abort('failed'));
    await page.getByTestId('price').fill('9100');
    await expect(page.getByTestId('query-form').getByRole('alert')).toBeVisible();
    await settled(page).catch(() => undefined);
    await snap(page, 'network-error', page.getByTestId('query-form'));
  });
});
