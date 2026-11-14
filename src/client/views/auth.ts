import { api, ApiError, type User } from '../api';
import { brandMark, h, icon } from '../dom';
import { t } from '../i18n';
import { themeToggle } from '../theme';
import { langToggle } from './shell';

type Mode = 'login' | 'register';

let uid = 0;
function field(opts: { name: string; label: string; type: string; autocomplete: string; hint?: string; maxlength?: number }) {
  const id = `f-${opts.name}-${++uid}`;
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const input = h('input', {
    id,
    name: opts.name,
    type: opts.type,
    class: 'input',
    autocomplete: opts.autocomplete,
    required: true,
    maxlength: opts.maxlength ?? null,
    spellcheck: 'false',
    'aria-describedby': [opts.hint ? hintId : '', errId].filter(Boolean).join(' '),
  });
  const error = h('div', { class: 'field__error', id: errId });
  let control: HTMLElement = input;
  if (opts.type === 'password') {
    const toggle = h('button', { type: 'button', class: 'input-group__addon', 'aria-label': t('auth.showPassword'), 'aria-pressed': 'false' }, icon('eye'));
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? t('auth.hidePassword') : t('auth.showPassword'));
      toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    });
    control = h('div', { class: 'input-group' }, input, toggle);
  }
  const wrap = h(
    'div',
    { class: 'field' },
    h('label', { class: 'label', for: id }, opts.label),
    control,
    opts.hint ? h('div', { class: 'field__hint', id: hintId }, opts.hint) : null,
    error,
  );
  return {
    wrap,
    input,
    setError(msg: string | undefined) {
      error.textContent = msg ?? '';
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    },
  };
}

/**
 * Собирает экран входа и регистрации с декоративным фоном текущей темы из CSS.
 * @param root Обязательный контейнер приложения, содержимое которого заменяется.
 * @param onAuthed Обязательный обработчик полученного User после успешного входа или регистрации.
 * @param allowRegistration Обязательный флаг доступности регистрации.
 * @param signal Обязательный сигнал времени жизни для обработчиков темы и языка.
 * @param message Необязательное сообщение над формой; по умолчанию плашка отсутствует.
 * @returns Void после подключения экрана.
 * @remarks Запросы входа и регистрации запускаются при отправке формы. Ошибки API
 * отображаются в форме; синхронные ошибки сборки DOM распространяются. Фон загружает браузер.
 */
export function renderAuth(root: HTMLElement, onAuthed: (user: User) => void, allowRegistration: boolean, signal: AbortSignal, message?: string) {
  let mode: Mode = 'login';

  const formSlot = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('auth.tabs') });
  const tabLogin = h('button', { type: 'button', class: 'tabs__btn', role: 'tab', id: 'tab-login', 'aria-controls': 'auth-panel' }, t('auth.tabLogin'));
  const tabReg = h('button', { type: 'button', class: 'tabs__btn', role: 'tab', id: 'tab-register', 'aria-controls': 'auth-panel' }, t('auth.tabRegister'));
  tabs.append(tabLogin, tabReg);
  const panel = h('div', { id: 'auth-panel', role: 'tabpanel' }, formSlot);

  function setMode(next: Mode, focus = true) {
    mode = next;
    tabLogin.setAttribute('aria-selected', String(mode === 'login'));
    tabReg.setAttribute('aria-selected', String(mode === 'register'));
    tabLogin.tabIndex = mode === 'login' ? 0 : -1;
    tabReg.tabIndex = mode === 'register' ? 0 : -1;
    panel.setAttribute('aria-labelledby', mode === 'login' ? 'tab-login' : 'tab-register');
    formSlot.replaceChildren(mode === 'login' ? loginForm() : registerForm());
    if (focus) formSlot.querySelector('input')?.focus({ preventScroll: true });
  }
  tabLogin.addEventListener('click', () => setMode('login'));
  tabReg.addEventListener('click', () => setMode('register'));
  tabs.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setMode(mode === 'login' ? 'register' : 'login');
      (mode === 'login' ? tabLogin : tabReg).focus();
    }
  });

  function formAlert() {
    const box = h('div', { class: 'alert alert--error', role: 'alert', hidden: true });
    return {
      box,
      show(msg: string) {
        box.replaceChildren(icon('alert'), h('p', null, msg));
        box.hidden = false;
      },
      hide() {
        box.hidden = true;
      },
    };
  }

  function loginForm() {
    const email = field({ name: 'email', label: t('auth.email'), type: 'email', autocomplete: 'username', maxlength: 254 });
    const password = field({ name: 'password', label: t('auth.password'), type: 'password', autocomplete: 'current-password', maxlength: 128 });
    const alert = formAlert();
    const submit = h('button', { type: 'submit', class: 'btn btn--block' }, t('auth.login'));
    const form = h('form', { class: 'form', novalidate: true, 'data-testid': 'login-form' }, alert.box, email.wrap, password.wrap, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      alert.hide();
      email.setError(undefined);
      password.setError(undefined);
      let bad = false;
      if (!email.input.value.trim()) {
        email.setError(t('auth.err.email'));
        bad = true;
      }
      if (!password.input.value) {
        password.setError(t('auth.err.password'));
        bad = true;
      }
      if (bad) return;
      submit.disabled = true;
      submit.textContent = t('auth.loggingIn');
      try {
        const { user } = await api.login(email.input.value, password.input.value);
        onAuthed(user);
      } catch (err) {
        alert.show(err instanceof ApiError ? err.message : t('auth.err.login'));
        password.input.select();
      } finally {
        submit.disabled = false;
        submit.textContent = t('auth.login');
      }
    });
    const wrap = h('div', { class: 'form' }, form);
    if (allowRegistration) {
      const sw = h('button', { type: 'button', class: 'btn btn--link' }, t('auth.toRegister'));
      sw.addEventListener('click', () => setMode('register'));
      wrap.append(h('p', { class: 'form__note' }, `${t('auth.noAccount')} `, sw));
    }
    return wrap;
  }

  function registerForm() {
    const name = field({ name: 'name', label: t('auth.name'), type: 'text', autocomplete: 'name', maxlength: 80 });
    const email = field({ name: 'email', label: t('auth.workEmail'), type: 'email', autocomplete: 'username', maxlength: 254 });
    const password = field({ name: 'password', label: t('auth.password'), type: 'password', autocomplete: 'new-password', hint: t('auth.passwordHint'), maxlength: 128 });
    const alert = formAlert();
    const submit = h('button', { type: 'submit', class: 'btn btn--block' }, t('auth.register'));
    const form = h('form', { class: 'form', novalidate: true, 'data-testid': 'register-form' }, alert.box, name.wrap, email.wrap, password.wrap, submit);
    const fields = { name, email, password };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      alert.hide();
      Object.values(fields).forEach((f) => f.setError(undefined));
      const errs: Partial<Record<keyof typeof fields, string>> = {};
      if (!name.input.value.trim()) errs.name = t('auth.err.name');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.input.value.trim())) errs.email = t('auth.err.emailBad');
      const pw = password.input.value;
      if (pw.length < 8) errs.password = t('auth.err.pwShort');
      else if (!/\p{L}/u.test(pw) || !/\d/.test(pw)) errs.password = t('auth.err.pwWeak');
      if (Object.keys(errs).length) {
        for (const [k, v] of Object.entries(errs)) fields[k as keyof typeof fields].setError(v);
        fields[Object.keys(errs)[0] as keyof typeof fields].input.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = t('auth.registering');
      try {
        const { user } = await api.register(name.input.value, email.input.value, pw);
        onAuthed(user);
      } catch (err) {
        if (err instanceof ApiError && Object.keys(err.fields).length) {
          for (const [k, v] of Object.entries(err.fields)) fields[k as keyof typeof fields]?.setError(v);
        } else {
          alert.show(err instanceof ApiError ? err.message : t('auth.err.register'));
        }
      } finally {
        submit.disabled = false;
        submit.textContent = t('auth.register');
      }
    });
    const sw = h('button', { type: 'button', class: 'btn btn--link' }, t('auth.toLogin'));
    sw.addEventListener('click', () => setMode('login'));
    return h('div', { class: 'form' }, form, h('p', { class: 'form__note' }, `${t('auth.haveAccount')} `, sw));
  }

  const card = h('section', { class: 'auth__card', 'aria-label': t('auth.card') });
  if (message) card.append(h('div', { class: 'alert alert--warn', role: 'status' }, icon('info'), h('p', null, message)));
  if (allowRegistration) card.append(tabs);
  else card.append(h('h2', { class: 'card__title' }, t('auth.staffOnly')));
  card.append(panel);

  const view = h(
    'div',
    { class: 'auth' },
    h(
      'header',
      { class: 'auth__top' },
      h('span', { class: 'brand' }, brandMark(), t('app.name')),
      h('span', { class: 'auth__controls' }, langToggle(signal), themeToggle(signal)),
    ),
    h(
      'main',
      { class: 'auth__body', id: 'main' },
      h(
        'div',
        { class: 'auth__intro' },
        h('span', { class: 'label' }, t('auth.kicker')),
        h('h1', null, t('auth.title')),
        h('p', null, t('auth.lead')),
      ),
      card,
    ),
    h('footer', { class: 'auth__foot' }, t('app.author')),
  );

  root.replaceChildren(view);
  if (allowRegistration) setMode('login', false);
  else formSlot.replaceChildren(loginForm());
}
