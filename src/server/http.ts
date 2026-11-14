import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { render, type Lang, type Localizable, type MessageKey, type Params } from '../shared/messages.js';

export const SESSION_COOKIE = 'ra_session';

/** HTTP-ошибка с переводимым текстом и (необязательно) ошибками по полям формы. */
export class HttpError extends Error {
  readonly body: Localizable;
  constructor(
    public readonly statusCode: number,
    key: MessageKey,
    params: Params = {},
    public readonly fields?: Record<string, Localizable>,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(render('ru', { key, params }));
    this.body = { key, params };
  }
}

export function L(key: MessageKey, params?: Params): Localizable {
  return params ? { key, params } : { key };
}

export function localizeFields(lang: Lang, fields: Record<string, Localizable>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = render(lang, v);
  return out;
}

export function setSessionCookie(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: number,
) {
  const secure = app.config.cookieSecure === 'auto' ? req.protocol === 'https' : app.config.cookieSecure;
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
