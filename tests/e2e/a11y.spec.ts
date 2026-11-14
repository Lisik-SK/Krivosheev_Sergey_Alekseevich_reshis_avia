import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import type { Result } from 'axe-core';
import { test, expect, openApp, calculate, loginAdmin, registerViaApi, settled } from './support/fixtures';

type Theme = 'light' | 'dark';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/**
 * Исключения из общих проверок axe. Сейчас пусто: найденные ранее дефекты исправлены,
 * для каждого ниже есть отдельный регрессионный тест.
 */
const KNOWN: Array<{ id: string; target?: RegExp; message?: RegExp; html?: RegExp }> = [];

function isKnown(v: Result, n: Result['nodes'][number]): boolean {
  const msg = n.any[0]?.message ?? '';
  return KNOWN.some(
    (k) =>
      k.id === v.id &&
      (!k.target || k.target.test(n.target.join(' '))) &&
      (!k.message || k.message.test(msg)) &&
      (!k.html || k.html.test(n.html)),
  );
}

async function setTheme(page: Page, theme: Theme) {
  await page.addInitScript((t) => localStorage.setItem('ra-theme', t), theme);
}

async function runAxe(page: Page, rules?: string[]) {
  // Дождаться окончания CSS-переходов, чтобы контраст считался по итоговым цветам.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const builder = new AxeBuilder({ page });
  if (rules) builder.withRules(rules);
  else builder.withTags(TAGS);
  return (await builder.analyze()).violations;
}

function describe(violations: Result[]): string[] {
  return violations.flatMap((v) =>
    v.nodes.map((n) => `[${v.impact}] ${v.id}: ${n.target.join(' ')} — ${n.any[0]?.message ?? v.help}`),
  );
}

async function audit(page: Page, testInfo: TestInfo, name: string) {
  const violations = await runAxe(page);
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(violations, null, 2), contentType: 'application/json' });
  const all = describe(violations);
  if (all.length) console.log(`axe ${name} (${testInfo.project.name}):\n  ${all.join('\n  ')}`);
  const blocking = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !isKnown(v, n)) }))
    .filter((v) => v.nodes.length > 0);
  expect(describe(blocking), 'serious/critical нарушения axe').toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`Доступность (axe), тема ${theme}`, () => {
    test.beforeEach(async ({ page }) => setTheme(page, theme));

    test('страница входа', async ({ page }, testInfo) => {
      await page.goto('/');
      await expect(page.getByTestId('login-form')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await audit(page, testInfo, `login-${theme}`);
    });

    test('форма регистрации с ошибками валидации', async ({ page }, testInfo) => {
      await page.goto('/');
      await page.getByRole('tab', { name: 'Регистрация' }).click();
      await page.getByRole('button', { name: 'Создать аккаунт' }).click();
      await expect(page.getByText('Укажите имя')).toBeVisible();
      await audit(page, testInfo, `register-errors-${theme}`);
    });

    test('страница с результатами (график)', async ({ page }, testInfo) => {
      await openApp(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      // Состояние с переполнением и предупреждением о цене — максимум элементов на экране
      await calculate(page, { price: 5000 });
      await expect(page.getByTestId('price-range-warning')).toBeVisible();
      // С открытой подсказкой графика
      await page.getByTestId('demand-chart').locator('.hit').nth(4).focus();
      await audit(page, testInfo, `results-chart-${theme}`);
    });

    test('страница с результатами (таблица)', async ({ page }, testInfo) => {
      await openApp(page);
      await page.getByTestId('table-toggle').click();
      await expect(page.getByTestId('scenario-table')).toBeVisible();
      await audit(page, testInfo, `results-table-${theme}`);
    });

    test('табло (/board)', async ({ page }, testInfo) => {
      await registerViaApi(page);
      await page.goto('/board');
      await expect(page.getByTestId('board-table')).toBeVisible();
      await expect(page.getByTestId('route-map').locator('.map__route')).toHaveCount(5);
      await audit(page, testInfo, `board-${theme}`);
    });

    test('администрирование (/admin) с проверенным файлом', async ({ page }, testInfo) => {
      await loginAdmin(page);
      await page.goto('/admin');
      await expect(page.getByTestId('admin-current')).toContainText('csv');
      await page.getByTestId('admin-file').setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
      await expect(page.getByTestId('admin-invalid')).toBeVisible();
      await audit(page, testInfo, `admin-${theme}`);
    });

    test('расчёт на английском, со сравнением цен', async ({ page }, testInfo) => {
      await page.addInitScript(() => localStorage.setItem('ra-lang', 'en'));
      await openApp(page, '?from=MOW&to=AER&date=2026-06-01&price=9500&b=11000');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByTestId('compare-card')).toBeVisible();
      await settled(page);
      await audit(page, testInfo, `results-en-${theme}`);
    });
  });
}

test.describe('Доступность: регрессии исправленных дефектов', () => {
  // Было: контраст неактивных вкладок/сегментов в светлой теме 4.34:1 (#66727b на #eef1f3), нужно ≥ 4.5:1.
  test('контраст неактивной вкладки и кнопки «Таблица» в светлой теме', async ({ page }) => {
    await setTheme(page, 'light');
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    const pair = /background color: #eef1f3/;
    const login = describe(await runAxe(page, ['color-contrast']));
    await openApp(page);
    const app = describe(await runAxe(page, ['color-contrast']));
    expect([...login, ...app].filter((m) => pair.test(m))).toEqual([]);
  });

  // Было: белые подписи на бирюзовых клетках календаря (ступень загрузки 70–85 %) — 3.88:1 в светлой
  // и 3.86:1 в тёмной теме при требуемых 4.5:1.
  for (const theme of ['light', 'dark'] as const) {
    test(`контраст подписей в клетках календаря (${theme})`, async ({ page }) => {
      await setTheme(page, theme);
      await openApp(page);
      await expect(page.getByTestId('calendar-card').locator('.cal__cell--s3').first()).toBeVisible();
      const msgs = describe(await runAxe(page, ['color-contrast'])).filter((m) => /foreground color: #ffffff/.test(m));
      expect(msgs).toEqual([]);
    });
  }

  // Было (WCAG 2.5.3): видимый текст «RU / EN» не входит в доступное имя переключателя языка.
  test('доступное имя переключателя языка содержит видимый текст', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('lang-toggle')).toBeVisible();
    const v = await runAxe(page, ['label-content-name-mismatch']);
    expect(describe(v).filter((m) => /lang-toggle/.test(m))).toEqual([]);
  });

  // Было (WCAG 2.5.3): у кнопок календаря aria-label не содержит видимый текст «<число> <процент>».
  test('доступные имена дней календаря содержат видимый текст', async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId('calendar-card').locator('button.cal__cell').first()).toBeVisible();
    const v = (await runAxe(page, ['label-content-name-mismatch'])).map((x) => ({ ...x, nodes: x.nodes.filter((n) => /cal__cell/.test(n.html)) }));
    expect(describe(v)).toEqual([]);
  });

  // Было: <svg role="img"> кривой дохода содержит фокусируемый слайдер (nested-interactive).
  test('кривая дохода: нет интерактивного элемента внутри role="img"', async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId('profit-curve').locator('svg')).toBeVisible();
    expect(describe(await runAxe(page, ['nested-interactive']))).toEqual([]);
  });

  // Было: на узком экране таблица сценариев прокручивается по горизонтали внутри .table-wrap,
  // но у контейнера нет tabindex — с клавиатуры скрытые столбцы не прокрутить.
  test('таблица сценариев на узком экране доступна с клавиатуры', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await page.getByTestId('table-toggle').click();
    await expect(page.getByTestId('scenario-table')).toBeVisible();
    const scrollable = await page.locator('.table-wrap').evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable, 'предусловие: таблица шире контейнера').toBe(true);
    expect(describe(await runAxe(page, ['scrollable-region-focusable']))).toEqual([]);
  });
});
