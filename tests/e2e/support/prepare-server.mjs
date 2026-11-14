// Запускается командой webServer перед стартом сервера:
// чистое хранилище для создания владельца при запуске сервера
// и копия data/ — тесты админки меняют файлы данных, оригинал не трогаем.
import fs from 'node:fs';
import path from 'node:path';

const storage = path.resolve(process.env.STORAGE_DIR ?? 'test-results/e2e-storage');
const dataDir = path.resolve(process.env.DATA_DIR ?? 'test-results/e2e-data');
if (path.resolve(dataDir) === path.resolve('data')) throw new Error('DATA_DIR must not point to the original data/ directory');

fs.rmSync(storage, { recursive: true, force: true });
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
for (const f of ['seasonal_forecast.csv', 'routes.csv']) fs.copyFileSync(path.resolve('data', f), path.join(dataDir, f));
console.log(`[e2e] storage reset: ${storage}; data copied to ${dataDir}`);
