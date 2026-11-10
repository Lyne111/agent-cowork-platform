import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HttpError } from './validation.js';

function same(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function installSecurity(app: FastifyInstance, port: number) {
  const session = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!hosts.has(request.headers.host ?? '')) throw new HttpError('INVALID_HOST', '只允许通过本机地址访问。', 403);
    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    if (origin && !origins.has(origin)) throw new HttpError('INVALID_ORIGIN', '不允许来自其他网站的请求。', 403);
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') throw new HttpError('CROSS_SITE_REQUEST', '不允许跨站请求。', 403);
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url.split('?')[0] === '/api/session') return;
    const cookies = request.headers.cookie?.split(';').map(item => item.trim()) ?? [];
    const cookie = cookies.find(item => item.startsWith('acw_session='))?.slice('acw_session='.length);
    if (!same(cookie, session)) throw new HttpError('UNAUTHENTICATED', '请重新打开本地工作台。', 401);
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (!origin || !origins.has(origin)) throw new HttpError('INVALID_ORIGIN', '写操作需要本机页面来源。', 403);
      const token = request.headers['x-csrf-token'];
      if (Array.isArray(token) || !same(token, csrfToken)) throw new HttpError('INVALID_CSRF', '请求已失效，请刷新页面后重试。', 403);
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError('INVALID_CONTENT_TYPE', '写操作必须使用 application/json。', 415);
    }
  });

  app.get('/api/session', async (_request, reply) => {
    reply.header('Set-Cookie', `acw_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
    return { csrfToken };
  });
}
