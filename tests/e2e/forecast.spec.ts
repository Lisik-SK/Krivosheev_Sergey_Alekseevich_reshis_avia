import { test, expect, openApp, calculate, textOf, numberOf } from './support/fixtures';
import { expected, flight, route, num1, int, norm } from './support/data';

interface Case {
  title: string;
  code: string;
  date: string;
  price: number;
  check?: (e: ReturnType<typeof expected>) => void;
}

const cases: Case[] = [
  {
    title: 'цена = базовой (MOW-AER)',
    code: 'MOW-AER',
    date: '2026-06-01',
    price: route('MOW-AER').basePrice,
    check: (e) => expect(e.wants).toBe(flight('MOW-AER', '2026-06-01').base[0.5]),
  },
  {
    title: 'дробный результат 704,5 → продажи 705 (MOW-AER)',
    code: 'MOW-AER',
    date: '2026-06-01',
    price: 9500,
    check: (e) => {
      expect(e.wants).toBe(704.5);
      expect(e.salesRounded).toBe(705);
      expect(e.freeRounded).toBe(195);
    },
  },
  {
    title: 'цена выше базовой (MOW-OVB)',
    code: 'MOW-OVB',
    date: '2026-06-10',
    price: 13500,
    check: (e) => {
      expect(e.wants).toBeLessThan(flight('MOW-OVB', '2026-06-10').base[0.5]!);
      expect(e.seats).toBe(270);
    },
  },
  {
    title: 'цена выше базовой (MOW-KGD)',
    code: 'MOW-KGD',
    date: '2026-06-20',
    price: 8800,
  },
  {
    title: 'очень высокая цена → продажи 0 (MOW-LED)',
    code: 'MOW-LED',
    date: '2026-06-15',
    price: 200000,
    check: (e) => {
      expect(e.wants).toBeLessThan(0);
      expect(e.salesRounded).toBe(0);
      expect(e.freeRounded).toBe(e.seats);
    },
  },
  {
    title: 'очень низкая цена → продажи упираются в число мест (MOW-AER)',
    code: 'MOW-AER',
    date: '2026-06-01',
    price: 5000,
    check: (e) => {
      expect(e.wants).toBeGreaterThan(e.seats);
      expect(e.salesRounded).toBe(e.seats);
      expect(e.freeRounded).toBe(0);
    },
  },
  {
    title: 'цена с копейками → дробный спрос (MOW-AER)',
    code: 'MOW-AER',
    date: '2026-06-01',
    price: 9500.5,
    check: (e) => expect(num1(e.wants)).toBe('704,4'),
  },
  {
    title: 'нулевая цена (MOW-KGD)',
    code: 'MOW-KGD',
    date: '2026-06-08',
    price: 0,
  },
  {
    title: 'низкая цена, другой маршрут (MOW-MRV)',
    code: 'MOW-MRV',
    date: '2026-07-01',
    price: 4800,
  },
];

test.describe('Корректность прогноза относительно CSV', () => {
  for (const c of cases) {
    test(`${c.title}: ${c.date}, ${c.price} ₽`, async ({ page }) => {
      const e = expected(c.code, c.date, c.price);
      c.check?.(e);
      const to = c.code.split('-')[1]!;

      await openApp(page);
      const body = (await calculate(page, { to, date: c.date, price: c.price })) as {
        route: { code: string };
        median: { wants: number; sales: number };
        seats: number;
      };
      // Ответ API согласован с CSV (защита от того, что UI и тест сравнивают одно и то же неверное число).
      expect(body.route.code).toBe(c.code);
      expect(body.seats).toBe(e.seats);
      expect(body.median.wants).toBeCloseTo(e.wants, 6);
      expect(body.median.sales).toBeCloseTo(e.sales, 6);

      expect(await textOf(page, 'seats')).toBe(int(e.seats));
      expect(await numberOf(page, 'sales')).toBe(int(e.salesRounded));
      expect(await textOf(page, 'free-seats')).toBe(int(e.freeRounded));
      expect(await textOf(page, 'wants')).toBe(num1(e.wants));
      expect(await textOf(page, 'sellout')).toBe(norm(e.sellOut));
      expect(await textOf(page, 'median-caption')).toBe(num1(e.wants));

      const meter = page.getByRole('meter', { name: 'Загрузка самолёта' });
      await expect(meter).toHaveAttribute('aria-valuenow', String(e.loadPct));

      // Подпись «хотят» под карточкой: при переполнении — сколько не поместятся
      if (e.wants > e.seats) {
        await expect(page.getByText(/не поместятся/)).toBeVisible();
      }
    });
  }

  test('пример из условия: 704,5 в «хотят» и 705 в продажах (точная строка)', async ({ page }) => {
    await openApp(page);
    await calculate(page, { to: 'AER', date: '2026-06-01', price: 9500 });
    await expect(page.getByTestId('wants')).toHaveText('704,5');
    await expect(page.getByTestId('sales')).toContainText('705');
    await expect(page.getByTestId('free-seats')).toHaveText('195');
    await expect(page.getByTestId('seats')).toHaveText('900');
  });
});
