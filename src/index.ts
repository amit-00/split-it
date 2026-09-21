import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createAuth, isAuthConfigured } from './auth';
import { expenses } from './expenses';
import { settlements } from './settlements';
import { groups } from './groups';
import { ApiError, fail, type Bindings } from './api';

const app = new Hono<Bindings>();
app.use('/api/*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.header('X-Request-ID', c.get('requestId'));
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  await next();
});
app.use('/api/*', bodyLimit({ maxSize: 65536, onError: () => fail(413, 'body_too_large', 'Request body exceeds 64 KiB.') }));
app.get('/api/health', c => c.json({ ok: true, authConfigured: isAuthConfigured(c.env) }));
app.use('/api/*', async (c, next) => {
  if (!/^\/api\/(auth(?:\/|$)|me$|users(?:\/|$)|expenses(?:\/|$)|settlements(?:\/|$)|balances$|groups(?:\/|$))/.test(c.req.path)) fail(404, 'not_found', 'Endpoint not found.');
  if (!isAuthConfigured(c.env)) fail(503, 'auth_unconfigured', 'Configure the auth secret and Google OAuth credentials.');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if ((origin && origin !== new URL(c.env.BETTER_AUTH_URL).origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') fail(403, 'untrusted_origin', 'Use the application origin for authenticated writes.');
    if (!c.req.path.startsWith('/api/auth/') && !origin) fail(403, 'origin_required', 'Send the application Origin header for authenticated writes.');
  }
  await next();
});
app.all('/api/auth/*', c => createAuth(c.env).handler(c.req.raw));
app.use('/api/*', async (c, next) => {
  const { response: session, headers } = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
  for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
  const appUserId = session && 'appUserId' in session.user ? session.user.appUserId : undefined;
  if (typeof appUserId !== 'string') fail(401, 'unauthorized', 'Sign in with Google again.');
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id=? AND EXISTS(SELECT 1 FROM user_identities WHERE user_id=users.id AND provider='google')").bind(appUserId).first<{id: string}>();
  if (!user) fail(401, 'unauthorized', 'Sign in with Google again.');
  c.set('userId', user.id);
  await next();
});
app.get('/api/me', async c => {
  const user = await c.env.DB.prepare('SELECT id,display_name AS name,email,avatar_url AS avatarUrl FROM users WHERE id=?').bind(c.get('userId')).first();
  return c.json({ user });
});
app.all('/api/me', c => c.body(null, 405, { Allow: 'GET' }));
app.route('/api', groups);
app.route('/api', expenses);
app.route('/api', settlements);
app.all('/api/*', () => fail(404, 'not_found', 'Endpoint not found.'));
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message }, requestId: c.get('requestId') }, error.status);
  const message = error.message;
  const unavailable = /D1.*(?:unavailable|overloaded|timed out|timeout)|Network connection lost/i.test(message);
  console.error(JSON.stringify({ requestId: c.get('requestId'), event: 'request_failed', errorType: error.name }));
  return c.json({ error: { code: unavailable ? 'database_unavailable' : 'internal_error', message: unavailable ? 'Database is temporarily unavailable. Retry the request.' : 'Request failed. Use the request ID when reporting this error.' }, requestId: c.get('requestId') }, unavailable ? 503 : 500);
});
export default app;
