/**
 * Синхронизирует тему и значок вкладки перед отрисовкой. Аргументов и результата нет.
 * Читает сохранённый выбор или системную тему, при ошибке чтения выбирает светлую.
 * Обновляет атрибут корневого элемента и при тёмной теме меняет адрес значка, если ссылка есть.
 * Записей в хранилище не делает. Загрузку значка выполняет браузер, ошибки DOM распространяются.
 */
(function () {
  var theme = 'light';
  try {
    var saved = localStorage.getItem('ra-theme');
    theme = saved === 'light' || saved === 'dark'
      ? saved
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (e) {
    /* При недоступном хранилище используем светлую тему. */
  }
  document.documentElement.setAttribute('data-theme', theme);
  var favicon = document.querySelector('link[rel="icon"]');
  if (favicon && theme === 'dark') favicon.setAttribute('href', '/favicon-dark.svg');
})();
