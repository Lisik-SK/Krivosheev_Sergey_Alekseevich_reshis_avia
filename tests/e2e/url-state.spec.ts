import { test, expect, openApp, calculate, registerViaApi, settled, textOf, waitForecast, newUser } from './support/fixtures';
import { expected, int, num1 } from './support/data';

test.describe('Состояние в URL', () => {
  test('после расчёта URL синхронизирован, перезагрузка восстанавливает маршрут, дату, цену и результат', async ({ page }) => {
    const e = expected('MOW-KGD', '2026-06-12', 8100);
    await openApp(page);
    await calculate(page, { to: 'KGD', date: '2026-06-12', price: 8100 });

    const params = new URL(page.url()).searchParams;
    expect(Object.fromEntries(params)).toEqual({ from: 'MOW', to: 'KGD', date: '2026-06-12', price: '8100' });

    const res = waitForecast(page);
    await page.reload();
    const body = (await res).request().postDataJSON();
    expect(body).toEqual({ from: 'MOW', to: 'KGD', date: '2026-06-12', price: 8100 });
    await settled(page);

    await expect(page.getByTestId('from')).toHaveValue('MOW');
    await expect(page.getByTestId('to')).toHaveValue('KGD');
    await expect(page.getByTestId('date')).toHaveValue('2026-06-12');
    await expect(page.getByTestId('price')).toHaveValue('8100');
    expect(await textOf(page, 'wants')).toBe(num1(e.wants));
    expect(await textOf(page, 'free-seats')).toBe(int(e.freeRounded));
    expect(await textOf(page, 'seats')).toBe(int(e.seats));
  });

  test('ссылка с параметрами открывается сразу с нужным расчётом (регистр кодов не важен)', async ({ page }) => {
    const e = expected('MOW-LED', '2026-06-20', 6000);
    await openApp(page, '?from=mow&to=led&date=2026-06-20&price=6000');
    await expect(page.getByTestId('to')).toHaveValue('LED');
    await expect(page.getByTestId('date')).toHaveValue('2026-06-20');
    await expect(page.getByTestId('price')).toHaveValue('6000');
    expect(await textOf(page, 'wants')).toBe(num1(e.wants));
  });

  test('ссылка с параметрами переживает вход в систему', async ({ page }) => {
    const u = newUser();
    await registerViaApi(page, u);
    await page.context().clearCookies();
    await page.goto('/?from=MOW&to=OVB&date=2026-06-25&price=11000');
    const form = page.getByTestId('login-form');
    await form.getByLabel('Email', { exact: true }).fill(u.email);
    await form.getByLabel('Пароль', { exact: true }).fill(u.password);
    const res = waitForecast(page);
    await form.getByRole('button', { name: 'Войти' }).click();
    expect((await res).request().postDataJSON()).toEqual({ from: 'MOW', to: 'OVB', date: '2026-06-25', price: 11000 });
    await settled(page);
    expect(await textOf(page, 'wants')).toBe(num1(expected('MOW-OVB', '2026-06-25', 11000).wants));
  });

  test('недопустимые параметры URL оставляют поля пустыми, допустимые сохраняются', async ({ page }) => {
    await registerViaApi(page);
    await page.goto('/?from=mow&to=%3Cscript%3E&date=2099-01-01&price=abc');
    await expect(page.getByTestId('from')).toHaveValue('MOW');
    await expect(page.getByTestId('to')).toHaveValue('');
    await expect(page.getByTestId('date')).toHaveValue('');
    await expect(page.getByTestId('price')).toHaveValue('');
    await expect(page.getByTestId('sales')).toBeHidden();
  });
});
