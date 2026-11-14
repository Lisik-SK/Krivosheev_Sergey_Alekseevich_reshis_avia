/**
 * Сенсорный ввод: касания вместо мыши, размер целей для пальца, поведение на iPhone.
 * Запускается только в проектах с сенсорным экраном (Pixel 7, iPhone 14).
 */
import type { Locator } from '@playwright/test';
import { test, expect, openApp, registerViaApi, settled, waitForecast } from '../e2e/support/fixtures';
import { datesOf, norm } from '../e2e/support/data';
import { hasTouch, stable } from './support/extra';

const Q = '?from=MOW&to=AER&date=2026-06-01&price=9500';

test.beforeEach(({}, testInfo) => {
  test.skip(!hasTouch(testInfo), 'только для устройств с сенсорным экраном');
});

/** Касание в точке внутри элемента (доли ширины и высоты, по умолчанию — центр). */
async function tapAt(target: Locator, fx = 0.5, fy = 0.5) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await target.tap({ position: { x: box.width * fx, y: box.height * fy } });
}

test.describe('Касания: графики и календарь', () => {
  test('касание столбца графика показывает подсказку, и она не исчезает сразу', async ({ page }) => {
    await openApp(page, Q);
    const chart = page.getByTestId('demand-chart');
    const tooltip = chart.locator('.tooltip');
    // Касаемся нижней части столбца, подальше от пунктира мест
    await tapAt(chart.locator('.hit').nth(4), 0.5, 0.92);
    await expect(tooltip).toBeVisible();
    await page.waitForTimeout(800);
    await expect(tooltip, 'после касания подсказка должна оставаться на экране').toBeVisible();
    expect(norm(await tooltip.textContent())).toContain('P50');

    // Касание другого столбца переключает подсказку
    await tapAt(chart.locator('.hit').nth(8), 0.5, 0.92);
    await expect(tooltip).toContainText('P90');

    // Подсказка целиком на экране
    const tb = (await tooltip.boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(tb.x).toBeGreaterThanOrEqual(0);
    expect(tb.x + tb.width).toBeLessThanOrEqual(vw + 1);

    // Касание вне графика убирает подсказку
    await page.locator('h1').first().tap();
    await expect(tooltip).toBeHidden();
  });

  test('касание кривой дохода ставит цену и пересчитывает', async ({ page }) => {
    await openApp(page, Q);
    const hit = page.getByTestId('profit-curve').locator('.hit');
    const res = waitForecast(page);
    await tapAt(hit, 0.8, 0.5);
    const body = (await res).request().postDataJSON() as { price: number };
    expect(body.price).toBeGreaterThan(9500);
    await settled(page);
    await expect(page.getByTestId('price')).toHaveValue(String(body.price));
  });

  test('касание дня в календаре меняет дату и пересчитывает', async ({ page }) => {
    await openApp(page, Q);
    const date = datesOf('MOW-AER')[5]!;
    const day = page.getByTestId('calendar').locator(`button.cal__cell[data-date="${date}"]`);
    await day.scrollIntoViewIfNeeded();
    const res = waitForecast(page);
    await day.tap();
    expect((await res).request().postDataJSON()).toMatchObject({ date });
    await settled(page);
    await expect(page.getByTestId('date')).toHaveValue(date);
  });

  test('касание дуги на схеме направлений открывает расчёт рейса', async ({ page }) => {
    await registerViaApi(page);
    await page.goto('/board?date=2026-06-12');
    const arc = page.getByTestId('route-map').locator('.map__route[data-route="MOW-KGD"]');
    await arc.scrollIntoViewIfNeeded();
    const res = waitForecast(page);
    await arc.tap();
    expect((await res).request().postDataJSON()).toMatchObject({ from: 'MOW', to: 'KGD', date: '2026-06-12' });
  });
});

test.describe('Касания: элементы управления', () => {
  test('переключатель «Сравнить с другой ценой» включается касанием', async ({ page }) => {
    await openApp(page, Q);
    await page.locator('label[for="q-compare"]').tap();
    await expect(page.getByTestId('compare-toggle')).toBeChecked();
    await expect(page.getByTestId('price-b')).toBeVisible();
    await expect(page.getByTestId('compare-card')).toBeVisible();
  });

  test('история: открытие и закрытие касанием, переход к расчёту', async ({ page }) => {
    await openApp(page, Q);
    await expect
      .poll(async () => ((await (await page.request.get('/api/history')).json()) as { items: unknown[] }).items.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await page.getByTestId('history-open').tap();
    await expect(page.getByTestId('history-drawer')).toBeVisible();
    await page.getByTestId('history-close').tap();
    await expect(page.getByTestId('history-drawer')).toHaveCount(0);

    await page.getByTestId('history-open').tap();
    const res = waitForecast(page);
    await page.getByTestId('history-item').first().tap();
    await res;
    await expect(page.getByTestId('history-drawer')).toHaveCount(0);
    await settled(page);
  });

  test('поле цены на телефоне открывает цифровую клавиатуру', async ({ page }) => {
    await openApp(page, Q);
    for (const id of ['price', 'price-b']) {
      const input = page.getByTestId(id);
      expect(await input.getAttribute('inputmode'), `${id}: inputmode`).toBe('decimal');
    }
  });
});

test.describe('Удобство на телефоне', () => {
  test('поля ввода не мельче 16 px — iPhone не увеличивает страницу при фокусе', async ({ page }) => {
    const check = async (where: string) => {
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('input, select, textarea')]
          .filter((el) => el.getBoundingClientRect().width > 2 && getComputedStyle(el).visibility !== 'hidden')
          .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
          .map((el) => `${el.tagName.toLowerCase()}#${el.id || el.getAttribute('name') || '?'} ${getComputedStyle(el).fontSize}`),
      );
      expect(small, `${where}: поля с шрифтом меньше 16 px`).toEqual([]);
    };
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await check('вход');
    await page.getByRole('tab', { name: 'Регистрация' }).tap();
    await check('регистрация');
    await openApp(page, Q);
    await page.locator('label[for="q-compare"]').tap();
    await check('расчёт');
  });

  test('масштабирование страницы не запрещено (meta viewport)', async ({ page }) => {
    await page.goto('/');
    const content = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? '';
    expect(content).toContain('width=device-width');
    expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
    const max = content.match(/maximum-scale\s*=\s*([\d.]+)/i);
    if (max) expect(Number(max[1])).toBeGreaterThanOrEqual(2);
  });

  test('цели для пальца не меньше 24×24 px (WCAG 2.2, критерий 2.5.8)', async ({ page }) => {
    const check = async (where: string) => {
      await stable(page);
      const small = await page.evaluate(() => {
        const sel = 'button, a[href], select, input, [role=button], [role=tab], [role=switch], [role=slider], [tabindex="0"]';
        const out: string[] = [];
        for (const el of document.querySelectorAll<Element>(sel)) {
          if (el.closest('[aria-hidden="true"], [hidden]')) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          let target: Element = el;
          if (el instanceof HTMLInputElement && ['checkbox', 'radio', 'file'].includes(el.type)) target = el.labels?.[0] ?? el;
          if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
          const r = target.getBoundingClientRect();
          if (r.width <= 2 || r.height <= 2) continue; // визуально скрытые (sr-only)
          const mapStroke = target.querySelector('.map__hit');
          if (mapStroke && target.matches('.map__route')) {
            const stroke = getComputedStyle(mapStroke);
            if (stroke.vectorEffect === 'non-scaling-stroke' && parseFloat(stroke.strokeWidth) >= 24) continue;
          }
          // Исключение WCAG: ссылки и кнопки-ссылки внутри строки текста
          if (el.matches('a, .btn--link') && el.parentElement?.matches('p, li, span')) continue;
          if (r.width < 24 || r.height < 24) {
            const name = el.getAttribute('aria-label') ?? el.getAttribute('data-testid') ?? (el.textContent ?? '').trim().slice(0, 30);
            out.push(`${el.tagName.toLowerCase()} «${name}» ${Math.round(r.width)}×${Math.round(r.height)}`);
          }
        }
        return out;
      });
      expect(small, `${where}: слишком маленькие цели`).toEqual([]);
    };
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await check('вход');
    await openApp(page, '?from=MOW&to=AER&date=2026-06-01&price=9500&b=10000');
    await check('расчёт');
    await page.getByTestId('history-open').tap();
    await expect(page.getByTestId('history-drawer')).toBeVisible();
    await check('история');
    await page.getByTestId('history-close').tap();
    await page.getByTestId('nav-board').tap();
    await expect(page.getByTestId('board-table')).toBeVisible();
    await check('табло');
  });
});
