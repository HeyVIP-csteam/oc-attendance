import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { runCron } from './cron';
import type { AppBindings, Env } from './env';
import { log } from './lib/audit';
import { requireSession } from './lib/auth';
import { ConfigError, redact } from './lib/crypto';
import { ApiError } from './lib/http';
import { adminRoutes } from './routes/admins';
import { attendanceRoutes } from './routes/attendance';
import { authRoutes } from './routes/auth';
import { employeeRoutes } from './routes/employees';
import { exceptionRoutes } from './routes/exceptions';
import { settingsRoutes } from './routes/settings';
import { shiftRoutes } from './routes/shifts';
import { tgImportRoutes } from './routes/tgimport';
import { webhookRoutes } from './routes/webhook';

export const app = new Hono<AppBindings>();

app.use('/api/*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
});

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.code, message: err.msg, ...(err.extra ?? {}) }, err.status);
  if (err instanceof HTTPException) return c.json({ error: 'HTTP', message: { zh: err.message, en: err.message } }, err.status);
  if (err instanceof ConfigError) {
    log('error', 'config_error', { path: c.req.path, error: err.message });
    return c.json({ error: 'CONFIG', message: { zh: `服务器配置错误：${err.message}`, en: `Server configuration error: ${err.message}` } }, 500);
  }
  log('error', 'unhandled', { path: c.req.path, method: c.req.method, error: redact(String(err?.message ?? err)) });
  return c.json({ error: 'INTERNAL', message: { zh: '服务器错误，请稍后再试', en: 'Server error. Please try again.' } }, 500);
});

// public endpoints
app.get('/api/health', (c) => c.json({ ok: true, env: c.env.APP_ENV ?? 'unknown' }));
app.route('/api/auth', authRoutes);
app.route('/api/telegram', webhookRoutes);

// everything else under /api requires an admin session
app.use('/api/*', requireSession);
app.route('/api', settingsRoutes);
app.route('/api', attendanceRoutes);
app.route('/api', employeeRoutes);
app.route('/api', shiftRoutes);
app.route('/api', exceptionRoutes);
app.route('/api', adminRoutes);
app.route('/api', tgImportRoutes);
app.all('/api/*', (c) => c.json({ error: 'NOT_FOUND', message: { zh: '接口不存在', en: 'Not found' } }, 404));

// non-API paths are normally served from static assets before the Worker runs; this is the fallback.
app.all('*', (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404)));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env).catch((e) => log('error', 'cron_failed', { error: redact(String((e as Error).message)) })));
  },
} satisfies ExportedHandler<Env>;
