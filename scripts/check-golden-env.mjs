#!/usr/bin/env node
/**
 * Тест tests/unit/golden.test.ts молча пропускает сверку с Python, если не найден pandas.
 * Этот скрипт проверяет окружение тем же способом и громко сообщает, чего не хватает.
 *
 *   node scripts/check-golden-env.mjs
 */
import { spawnSync } from 'node:child_process';

const python = process.platform === 'win32' ? 'python' : 'python3';
const version = spawnSync(python, ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) {
  console.error(`✗ Не найден «${python}». Установите Python 3 и добавьте его в PATH.`);
  process.exit(1);
}
console.log(`✓ ${(version.stdout || version.stderr).trim()}`);

const pandas = spawnSync(python, ['-I', '-c', 'import pandas; print(pandas.__version__)'], { encoding: 'utf8' });
if (pandas.status !== 0) {
  console.error(`✗ pandas не установлен — сверка с Python в golden.test.ts будет ПРОПУЩЕНА.\n  Установите: ${python} -m pip install pandas`);
  process.exit(1);
}
console.log(`✓ pandas ${pandas.stdout.trim()} — сверка с Python будет выполнена.`);
console.log('\nЗапустите: npx vitest run tests/unit/golden.test.ts --reporter=verbose');
console.log('В выводе не должно быть строк со статусом skipped.');
