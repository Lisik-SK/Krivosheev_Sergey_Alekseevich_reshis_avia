import type { Page } from '@playwright/test';
import { test, expect, calculate, forecastAt, openApp, registerViaApi, settled, waitForecast, textOf } from './support/fixtures';
import { boardRow, expected, flights, int, norm, num1, routes } from './support/data';

/**
 * Определяет, какие направления справочника представлены в прогнозе на выбранный день.
 * @param date Обязательная дата в формате YYYY-MM-DD.
 * @returns Новый массив кодов в порядке справочника; пустой, если на дату нет рейсов.
 * @remarks Читает загруженные фикстуры без изменений и ввода-вывода. Неизвестная дата не вызывает ошибку.
 */
function boardCodes(date: string): string[] {
  const available = new Set(flights.filter((flight) => flight.date === date).map((flight) => flight.route));
  return routes.map((route) => route.route).filter((code) => available.has(code));
}

function boardResponse(page: Page) {
  return page.waitForResponse((r) => r.url().endsWith('/api/forecast/board') && r.request().method() === 'POST');
}

async function openBoard(page: Page, query = '') {
  await registerViaApi(page);
  const res = boardResponse(page);
  await page.goto('/board' + query);
  expect((await res).status()).toBe(200);
  await expect(page.getByTestId('board-table')).toBeVisible();
  await expect(page.getByTestId('board')).not.toHaveClass(/is-loading/);
}

/**
 * Сверяет строки табло с независимым расчётом для рейсов, доступных на дату.
 * @param page Обязательная страница Playwright с открытым табло.
 * @param date Обязательная дата YYYY-MM-DD, на которую загружены строки.
 * @param mode Обязательный режим цены: base для базовой или model для цены модели.
 * @returns Promise<void> после проверки количества строк, значений и статусов.
 * @throws Ошибка фикстур, Playwright или проверки при расхождении данных и разметки.
 * @remarks Читает DOM и фикстуры; не меняет страницу и не отправляет запросы приложения.
 */
async function checkRows(page: Page, date: string, mode: 'base' | 'model'): Promise<void> {
  const codes = boardCodes(date);
  const table = page.getByTestId('board-table');
  await expect(table.locator('tbody tr')).toHaveCount(codes.length);
  for (const code of codes) {
    const exp = boardRow(code, date, mode);
    const row = table.locator(`tbody tr[data-route="${code}"]`);
    const cells = (await row.locator('td').allTextContents()).map(norm);
    expect(cells[0], code).toBe(code.replace('-', '→'));
    expect(cells[2], `${code} цена`).toBe(`${int(exp.price)}₽`);
    expect(cells[3], `${code} продажи`).toBe(int(exp.salesRounded));
    expect(cells[4], `${code} места`).toBe(int(exp.seats));
    expect(cells[5], `${code} загрузка`).toBe(`${exp.loadPct}%`);
    await expect(row.locator('.board__status'), `${code} статус`).toHaveClass(new RegExp(`board__status--${exp.status}\\b`));
  }
}

test.describe('Табло вылетов', () => {
  test('Tab останавливается на таблице только при горизонтальной прокрутке', async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 900 });
    await openBoard(page);
    const scroll = page.getByTestId('board').locator('.table-wrap');
    const firstFlight = page.getByTestId('board-open').first();
    const mode = page.getByTestId('mode-model');
    await expect(scroll).toHaveAttribute('tabindex', '-1');
    await mode.focus();
    await page.keyboard.press('Tab');
    await expect(firstFlight).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(scroll).toHaveAttribute('tabindex', '0');
    await mode.focus();
    await page.keyboard.press('Tab');
    await expect(scroll).toBeFocused();
    await expect(scroll).toHaveCSS('outline-offset', '-3px');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  });

  test('все направления на первую дату по базовой цене', async ({ page }) => {
    await openBoard(page);
    await expect(page.getByTestId('board-date')).toHaveValue('2026-06-01');
    await expect(page.getByTestId('board-date-display')).toHaveValue('01.06.2026');
    await expect(page.getByTestId('mode-base')).toHaveAttribute('aria-pressed', 'true');
    await checkRows(page, '2026-06-01', 'base');
    // Итог по табло: сумма продаж (медиана, без округления) и мест.
    const codes = boardCodes('2026-06-01');
    const totalSales = codes.reduce((s, c) => s + expected(c, '2026-06-01', boardRow(c, '2026-06-01', 'base').price).sales, 0);
    const totalSeats = codes.reduce((s, c) => s + expected(c, '2026-06-01', 0).seats, 0);
    const totals = await textOf(page, 'board-totals');
    expect(totals).toContain(num1(totalSales));
    expect(totals).toContain(int(totalSeats));
  });

  test('выбор даты в календаре и режим «цена модели» (0.5_price)', async ({ page, isMobile }) => {
    await openBoard(page);
    const trigger = page.getByTestId('board-date-trigger');
    const calendar = page.getByRole('dialog');
    if (isMobile) await trigger.tap();
    else await trigger.click();
    await expect(calendar.locator('[data-date="2026-06-01"]')).toHaveAttribute('aria-pressed', 'true');
    let res = boardResponse(page);
    const day = calendar.locator('[data-date="2026-06-19"]');
    if (isMobile) await day.tap();
    else await day.click();
    expect((await res).request().postDataJSON()).toMatchObject({ date: '2026-06-19' });
    await expect(calendar).toBeHidden();
    await expect(page.getByTestId('board')).not.toHaveClass(/is-loading/);
    await expect(page.getByTestId('board-date-display')).toHaveValue('19.06.2026');
    await checkRows(page, '2026-06-19', 'base');
    expect(new URL(page.url()).searchParams.get('date')).toBe('2026-06-19');

    res = boardResponse(page);
    await page.getByTestId('mode-model').click();
    await res;
    await expect(page.getByTestId('board')).not.toHaveClass(/is-loading/);
    await expect(page.getByTestId('mode-model')).toHaveAttribute('aria-pressed', 'true');
    await checkRows(page, '2026-06-19', 'model');
    expect(new URL(page.url()).searchParams.get('mode')).toBe('model');

    // Состояние табло восстанавливается по ссылке
    res = boardResponse(page);
    await page.reload();
    await res;
    await expect(page.getByTestId('board-date')).toHaveValue('2026-06-19');
    await expect(page.getByTestId('mode-model')).toHaveAttribute('aria-pressed', 'true');
    await checkRows(page, '2026-06-19', 'model');
  });

  test('календарь доступен с клавиатуры, ручной ввод проверяется, стрелки меняют дату', async ({ page }) => {
    await openBoard(page);
    const trigger = page.getByTestId('board-date-trigger');
    const display = page.getByTestId('board-date-display');
    const calendar = page.getByRole('dialog');
    const prev = page.getByRole('button', { name: 'Предыдущий день', exact: true });
    const next = page.getByRole('button', { name: 'Следующий день', exact: true });
    await expect(prev).toBeDisabled();
    await trigger.press('Enter');
    await expect(calendar.locator('[data-date="2026-06-01"]')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(calendar.locator('[data-date="2026-06-02"]')).toBeFocused();
    let res = boardResponse(page);
    await page.keyboard.press('Enter');
    expect((await res).request().postDataJSON()).toMatchObject({ date: '2026-06-02' });
    await expect(calendar).toBeHidden();
    await expect(page).toHaveURL(/date=2026-06-02/);

    const requestedDates: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/forecast/board')) {
        requestedDates.push(request.postDataJSON().date);
      }
    });
    await display.fill('31.06.2026');
    await expect(display).toHaveAttribute('aria-invalid', 'true');
    await expect(display).toHaveAccessibleDescription(/\S/);
    await display.fill('02.07.2026');
    await expect(display).toHaveAttribute('aria-invalid', 'true');
    await expect(display).toHaveAccessibleDescription(/\S/);
    await expect(page).toHaveURL(/date=2026-06-02/);

    res = boardResponse(page);
    await display.fill('12062026');
    expect((await res).request().postDataJSON()).toMatchObject({ date: '2026-06-12' });
    await expect(display).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/date=2026-06-12/);
    expect(requestedDates).toEqual(['2026-06-12']);

    res = boardResponse(page);
    await next.click();
    expect((await res).request().postDataJSON()).toMatchObject({ date: '2026-06-13' });
    await expect(display).toHaveValue('13.06.2026');
    res = boardResponse(page);
    await prev.click();
    expect((await res).request().postDataJSON()).toMatchObject({ date: '2026-06-12' });
    await expect(display).toHaveValue('12.06.2026');
    await expect(page).toHaveURL(/date=2026-06-12/);
  });

  test('повторный выбор дня перезапускает загрузку после ошибки сети', async ({ page, problems }) => {
    await openBoard(page);
    problems.allow(/503/);
    const trigger = page.getByTestId('board-date-trigger');
    const day = page.getByRole('dialog').locator('[data-date="2026-06-19"]');
    const alert = page.locator('#main').getByRole('alert');
    await page.route('**/api/forecast/board', (route) => route.fulfill({
      status: 503, json: { error: 'Табло временно недоступно' },
    }), { times: 1 });
    await trigger.click();
    await day.click();
    await expect(alert).toBeVisible();
    await expect(page).toHaveURL(/date=2026-06-01/);
    await trigger.click();
    const response = boardResponse(page);
    await day.click();
    expect((await response).status()).toBe(200);
    await expect(page).toHaveURL(/date=2026-06-19/);
    await expect(alert).toHaveCount(0);
  });

  test('«Открыть» переходит в расчёт рейса с маршрутом, датой и ценой', async ({ page }) => {
    await openBoard(page, '?date=2026-06-08&mode=model');
    const exp = boardRow('MOW-OVB', '2026-06-08', 'model');
    const res = waitForecast(page);
    await page.getByTestId('board-table').locator('tr[data-route="MOW-OVB"]').getByTestId('board-open').click();
    expect((await res).request().postDataJSON()).toEqual({ from: 'MOW', to: 'OVB', date: '2026-06-08', price: exp.price });
    await settled(page);
    await expect(page).toHaveURL(/\/\?/);
    await expect(page.getByTestId('to')).toHaveValue('OVB');
    await expect(page.getByTestId('date')).toHaveValue('2026-06-08');
    await expect(page.getByTestId('price')).toHaveValue(String(exp.price));
    expect(await textOf(page, 'free-seats')).toBe(int(exp.freeRounded));
    await expect(page.getByTestId('nav-flight')).toHaveAttribute('aria-current', 'page');
  });

  test('схема направлений на выбранную дату, клик открывает расчёт', async ({ page }) => {
    await openBoard(page, '?date=2026-06-12');
    const map = page.getByTestId('route-map');
    await map.scrollIntoViewIfNeeded();
    const arcs = map.locator('.map__route');
    const codes = boardCodes('2026-06-12');
    await expect(arcs).toHaveCount(codes.length);
    expect((await arcs.evaluateAll((els) => els.map((e) => e.getAttribute('data-route')))).sort()).toEqual(codes.sort());

    const res = waitForecast(page);
    await map.locator('.map__route[data-route="MOW-KGD"]').click();
    expect((await res).request().postDataJSON()).toMatchObject({ from: 'MOW', to: 'KGD', date: '2026-06-12' });
    await settled(page);
    await expect(page.getByTestId('to')).toHaveValue('KGD');
  });

  test('схема направлений доступна с клавиатуры (Enter)', async ({ page }) => {
    await openBoard(page);
    const arc = page.getByTestId('route-map').locator('.map__route[data-route="MOW-LED"]');
    await arc.focus();
    const res = waitForecast(page);
    await page.keyboard.press('Enter');
    expect((await res).request().postDataJSON()).toMatchObject({ to: 'LED' });
  });

  test('ссылки в шапке восстанавливают параметры и результаты рейса и табло после перезагрузки', async ({ page }) => {
    const [flightDate, boardDate] = ['2026-06-15', '2026-06-19'];
    const [price, comparisonPrice] = [6000, 6500];
    const flightLink = page.getByTestId('nav-flight');
    const boardLink = page.getByTestId('nav-board');
    const comparison = page.getByTestId('compare-card');

    await openApp(page);
    await calculate(page, { to: 'LED', date: flightDate, price });
    const compareResponse = forecastAt(page, comparisonPrice);
    await page.getByTestId('compare-toggle').check({ force: true });
    await page.getByTestId('price-b').fill(String(comparisonPrice));
    await compareResponse;
    await settled(page);
    await page.getByTestId('table-toggle').click();
    await expect(page.getByTestId('scenario-table')).toBeVisible();

    await boardLink.click();
    await expect(page.getByTestId('board-table')).toBeVisible();
    let response = boardResponse(page);
    await page.getByTestId('board-date-display').fill(boardDate);
    expect((await response).request().postDataJSON()).toMatchObject({ date: boardDate });
    response = boardResponse(page);
    await page.getByTestId('mode-model').click();
    expect((await response).request().postDataJSON()).toMatchObject({ date: boardDate, priceMode: 'model' });
    await expect(page.getByTestId('board')).not.toHaveClass(/is-loading/);
    await checkRows(page, boardDate, 'model');

    await page.reload();
    await expect(page.getByTestId('board-table')).toBeVisible();
    await expect(page.getByTestId('board')).not.toHaveClass(/is-loading/);
    await expect(page.getByTestId('board-date')).toHaveValue(boardDate);
    await expect(page.getByTestId('mode-model')).toHaveAttribute('aria-pressed', 'true');

    let finishMeta!: () => void;
    const metaGate = new Promise<void>((resolve) => { finishMeta = resolve; });
    await page.route('**/api/meta', async (route) => {
      await metaGate;
      await route.continue();
    }, { times: 1 });
    const meta = page.waitForResponse('**/api/meta');
    try {
      await flightLink.click();
      await expect(page.getByTestId('scenario-table')).toBeVisible();
      await expect(comparison).toBeVisible();
    } finally {
      finishMeta();
    }
    await meta;
    await settled(page);
    await expect(page.getByTestId('from')).toHaveValue('MOW');
    await expect(page.getByTestId('to')).toHaveValue('LED');
    await expect(page.getByTestId('date')).toHaveValue(flightDate);
    await expect(page.getByTestId('price')).toHaveValue(String(price));
    await expect(page.getByTestId('compare-toggle')).toBeChecked();
    await expect(page.getByTestId('price-b')).toHaveValue(String(comparisonPrice));
    await expect(page.getByTestId('scenario-table')).toBeVisible();
    expect(await textOf(page, 'wants')).toBe(num1(expected('MOW-LED', flightDate, price).wants));
    const comparisonCells = await comparison.locator('tbody tr').first().locator('td').allTextContents();
    expect(comparisonCells.slice(1, 3).map(norm)).toEqual([
      num1(expected('MOW-LED', flightDate, price).wants),
      num1(expected('MOW-LED', flightDate, comparisonPrice).wants),
    ]);

    await page.reload();
    await settled(page);
    await expect(page.getByTestId('date')).toHaveValue(flightDate);
    await expect(page.getByTestId('price-b')).toHaveValue(String(comparisonPrice));

    let finishBoard!: () => void;
    const boardGate = new Promise<void>((resolve) => { finishBoard = resolve; });
    await page.route('**/api/forecast/board', async (route) => {
      await boardGate;
      await route.continue();
    }, { times: 1 });
    response = boardResponse(page);
    try {
      await boardLink.click();
      await expect(page.getByTestId('board-table')).toBeVisible();
      await checkRows(page, boardDate, 'model');
    } finally {
      finishBoard();
    }
    await response;
    await expect(page.getByTestId('board-date')).toHaveValue(boardDate);
    await expect(page.getByTestId('mode-model')).toHaveAttribute('aria-pressed', 'true');
    await checkRows(page, boardDate, 'model');

    const row = page.getByTestId('board-table').locator('tr[data-route="MOW-OVB"]');
    const boardPrice = boardRow('MOW-OVB', boardDate, 'model').price;
    const opened = waitForecast(page);
    await row.getByTestId('board-open').click();
    expect((await opened).request().postDataJSON()).toEqual({
      from: 'MOW', to: 'OVB', date: boardDate, price: boardPrice,
    });
    await settled(page);
    await expect(page.getByTestId('compare-toggle')).not.toBeChecked();
  });

  test('цена рейса сохраняется после ухода до отложенного расчёта и перезагрузки табло', async ({ page }) => {
    await openApp(page);
    const price = 9800;
    // Ввод и переход в одной задаче браузера, чтобы таймер расчёта не успел сработать.
    await page.getByTestId('price').evaluate((input: HTMLInputElement, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector<HTMLAnchorElement>('[data-testid="nav-board"]')!.click();
    }, price);
    await expect(page.getByTestId('board-table')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('board-table')).toBeVisible();
    await page.getByTestId('nav-flight').click();
    await settled(page);
    await expect(page.getByTestId('price')).toHaveValue(String(price));
    expect(await textOf(page, 'wants')).toBe(num1(expected('MOW-AER', '2026-06-01', price).wants));
  });

  test('повреждённый кеш рейса пропускается, а его параметры сохраняются', async ({ page }) => {
    await openApp(page, '?from=MOW&to=KGD&date=2026-06-12&price=8100');
    await page.getByTestId('nav-board').click();
    await expect(page.getByTestId('board-table')).toBeVisible();
    await page.evaluate(() => {
      const key = 'ra-flight-screen-v1';
      const saved = JSON.parse(sessionStorage.getItem(key)!);
      saved.state.result = {};
      sessionStorage.setItem(key, JSON.stringify(saved));
    });
    await page.reload();
    await expect(page.getByTestId('board-table')).toBeVisible();
    const response = waitForecast(page);
    await page.getByTestId('nav-flight').click();
    expect((await response).request().postDataJSON()).toEqual({
      from: 'MOW', to: 'KGD', date: '2026-06-12', price: 8100,
    });
    await settled(page);
    expect(await textOf(page, 'wants')).toBe(num1(expected('MOW-KGD', '2026-06-12', 8100).wants));
  });

  test('навигация: ссылки «Рейс» / «Табло» в шапке', async ({ page }) => {
    await registerViaApi(page);
    await page.goto('/');
    await expect(page.getByTestId('query-form')).toBeVisible();
    await page.getByTestId('nav-board').click();
    await expect(page).toHaveURL(/\/board/);
    await expect(page.getByTestId('board-table')).toBeVisible();
    await expect(page.getByTestId('nav-board')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('board-date-display').fill('2026-06-11');
    await expect(page).toHaveURL(/date=2026-06-11/);
    await page.goBack();
    await expect(page.getByTestId('query-form')).toBeVisible();
    await expect(page.getByTestId('from')).toHaveValue('');
    await expect(page.getByTestId('nav-flight')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('nav-board').click();
    await expect(page.getByTestId('board-date')).toHaveValue('2026-06-11');
    await expect(page.getByTestId('board-table')).toBeVisible();
  });
});
