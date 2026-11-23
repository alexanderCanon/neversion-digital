import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';

type Identity = { role: 'admin' | 'operator'; operatorId?: string };
type App = {
  Bindings: {
    DB: D1Database;
    ADMIN_EMAIL?: string;
    ADMIN_PASSWORD?: string;
    LOGIN_LIMIT: RateLimit;
    RECEIPT_LIMIT: RateLimit;
    RECEIPT_VALIDATOR?: Fetcher;
    RECEIPT_INTEGRATION_KEY?: string;
    REMINDER_API_KEY?: string;
  };
  Variables: { identity: Identity; sessionHash: string };
};

const app = new Hono<App>();
const now = () => Math.floor(Date.now() / 1000);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
const email = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length <= max ? value.trim() : null;
export const validPrice = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function input(c: Context<App>): Promise<Record<string, unknown>> {
  const data: unknown = await c.req.json().catch(() => null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

function derive(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('hex'));
    });
  });
}

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  await next();
});

app.get('/health', async (c) => {
  await c.env.DB.prepare('SELECT id FROM subscriptions LIMIT 1').first();
  return c.json({ ok: true });
});

app.post('/api/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') || 'local';
  const allowed = await c.env.LOGIN_LIMIT.limit({ key: ip });
  if (!allowed.success) return c.json({ error: 'Espera un minuto e inténtalo de nuevo.' }, 429);

  const body = await input(c);
  const login = email(body.email);
  const password = body.password;
  if (!isEmail(login) || typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return c.json({ error: 'Credenciales incorrectas.' }, 401);
  }

  let identity: Identity;
  const adminEmail = email(c.env.ADMIN_EMAIL);
  if (same(login, adminEmail)) {
    const adminPassword = c.env.ADMIN_PASSWORD;
    if (!adminPassword || adminPassword.length < 16 || !same(password, adminPassword)) {
      return c.json({ error: 'Credenciales incorrectas.' }, 401);
    }
    identity = { role: 'admin' };
  } else {
    const operator = await c.env.DB.prepare(
      'SELECT id, password_hash FROM operators WHERE email = ? AND revoked_at IS NULL AND access_until > ?',
    ).bind(login, now()).first<{ id: string; password_hash: string }>();
    const [salt, expected] = operator?.password_hash.split(':') ?? ['invalid-operator-login', ''];
    const verified = same(await derive(password, salt), expected);
    if (!operator || !verified) return c.json({ error: 'Credenciales incorrectas.' }, 401);
    identity = { role: 'operator', operatorId: operator.id };
  }

  const token = randomBytes(32).toString('hex');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
    c.env.DB.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind(hash(token), identity.operatorId ?? null, now() + 86400),
  ]);
  return c.json({ token, role: identity.role });
});

app.use('/api/*', async (c, next) => {
  const token = c.req.header('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return c.json({ error: 'Inicia sesión.' }, 401);
  const sessionHash = hash(token);
  const session = await c.env.DB.prepare(
    'SELECT s.operator_id FROM sessions s LEFT JOIN operators o ON o.id = s.operator_id ' +
    'WHERE s.token_hash = ? AND s.expires_at > ? AND ' +
    '(s.operator_id IS NULL OR (o.id IS NOT NULL AND o.revoked_at IS NULL AND o.access_until > ?))',
  ).bind(sessionHash, now(), now()).first<{ operator_id: string | null }>();
  if (!session) return c.json({ error: 'Tu sesión terminó. Vuelve a iniciar sesión.' }, 401);
  c.set('identity', session.operator_id ? { role: 'operator', operatorId: session.operator_id } : { role: 'admin' });
  c.set('sessionHash', sessionHash);
  const receiptUpload = c.req.method === 'POST' && c.req.path === '/api/receipts';
  if (session.operator_id && c.req.method !== 'GET' && c.req.path !== '/api/logout' && !receiptUpload) {
    return c.json({ error: 'Este acceso es de solo lectura.' }, 403);
  }
  await next();
});

app.post('/api/logout', async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.get('sessionHash')).run();
  return c.body(null, 204);
});

app.get('/api/dashboard', async (c) => {
  const offset = Number(c.req.query('offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
    return c.json({ error: 'Página inválida.' }, 400);
  }
  const [clients, services, subscriptions] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, name, contact FROM clients WHERE archived_at IS NULL ORDER BY name, id'),
    c.env.DB.prepare('SELECT id, name, price_cents FROM services WHERE archived_at IS NULL ORDER BY name, id'),
    c.env.DB.prepare(
      'SELECT s.id, s.client_id, s.service_id, c.name AS client_name, v.name AS service_name, ' +
      's.price_cents, s.due_on, s.cancelled_at FROM subscriptions s ' +
      'JOIN clients c ON c.id = s.client_id JOIN services v ON v.id = s.service_id ' +
      'ORDER BY s.cancelled_at IS NOT NULL, s.due_on, s.id LIMIT 51 OFFSET ?',
    ).bind(offset),
  ]);
  return c.json({ role: c.get('identity').role, clients: clients.results, services: services.results,
    subscriptions: subscriptions.results.slice(0, 50), hasMore: subscriptions.results.length > 50 });
});

app.post('/api/clients', async (c) => {
  const body = await input(c);
  const name = text(body.name, 120);
  const contact = text(body.contact ?? '', 200);
  if (!name || contact === null) return c.json({ error: 'Revisa el nombre y contacto del cliente.' }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO clients (id, name, contact) VALUES (?, ?, ?)').bind(id, name, contact).run();
  return c.json({ id }, 201);
});

app.post('/api/services', async (c) => {
  const body = await input(c);
  const name = text(body.name, 120);
  if (!name || !validPrice(body.priceCents)) return c.json({ error: 'Revisa el nombre y el precio.' }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO services (id, name, price_cents) VALUES (?, ?, ?)').bind(id, name, body.priceCents).run();
  return c.json({ id }, 201);
});

app.post('/api/subscriptions', async (c) => {
  const body = await input(c);
  const client = text(body.clientId, 36);
  const service = text(body.serviceId, 36);
  if (!client || !service || !validDate(body.dueOn)) {
    return c.json({ error: 'Selecciona cliente, servicio y fecha válida.' }, 400);
  }
  const id = crypto.randomUUID();
  const result = await c.env.DB.prepare(
    'INSERT INTO subscriptions (id, client_id, service_id, price_cents, due_on) ' +
    'SELECT ?, c.id, s.id, s.price_cents, ? FROM clients c CROSS JOIN services s ' +
    'WHERE c.id = ? AND s.id = ? AND c.archived_at IS NULL AND s.archived_at IS NULL',
  ).bind(id, body.dueOn, client, service).run();
  if (!result.meta.changes) return c.json({ error: 'Cliente o servicio no disponible.' }, 409);
  return c.json({ id }, 201);
});

app.patch('/api/subscriptions/:id', async (c) => {
  const body = await input(c);
  const id = c.req.param('id');
  if (body.action === 'cancel') {
    await c.env.DB.prepare(
      'UPDATE subscriptions SET cancelled_at = COALESCE(cancelled_at, ?) WHERE id = ?',
    ).bind(now(), id).run();
    return c.body(null, 204);
  }
  if (body.action !== 'renew' || !validDate(body.dueOn)) {
    return c.json({ error: 'Ingresa la nueva fecha de vencimiento.' }, 400);
  }
  const result = await c.env.DB.prepare(
    'UPDATE subscriptions SET due_on = ? WHERE id = ? AND cancelled_at IS NULL AND due_on < ?',
  ).bind(body.dueOn, id, body.dueOn).run();
  if (!result.meta.changes) return c.json({ error: 'La nueva fecha debe ser posterior al vencimiento actual.' }, 409);
  return c.body(null, 204);
});

app.get('/api/operators', async (c) => {
  if (c.get('identity').role !== 'admin') return c.json({ error: 'Acceso restringido.' }, 403);
  const result = await c.env.DB.prepare(
    'SELECT id, email, access_until, revoked_at FROM operators ORDER BY email',
  ).all();
  return c.json({ operators: result.results });
});

app.post('/api/operators', async (c) => {
  const body = await input(c);
  const login = email(body.email);
  const password = body.password;
  const days = body.days;
  if (!isEmail(login) || login === email(c.env.ADMIN_EMAIL) || typeof password !== 'string' ||
      password.length < 12 || password.length > 128 || typeof days !== 'number' ||
      !Number.isInteger(days) || days < 1 || days > 90) {
    return c.json({ error: 'Revisa el correo, la contraseña (12 caracteres o más) y los días de acceso (1 a 90).' }, 400);
  }
  const salt = randomBytes(16).toString('hex');
  const passwordHash = salt + ':' + await derive(password, salt);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE operator_id = (SELECT id FROM operators WHERE email = ?)').bind(login),
    c.env.DB.prepare(
      'INSERT INTO operators (id, email, password_hash, access_until) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, ' +
      'access_until = excluded.access_until, revoked_at = NULL',
    ).bind(crypto.randomUUID(), login, passwordHash, now() + days * 86400),
  ]);
  return c.body(null, 204);
});

app.delete('/api/operators/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE operators SET revoked_at = ? WHERE id = ?').bind(now(), id),
    c.env.DB.prepare('DELETE FROM sessions WHERE operator_id = ?').bind(id),
  ]);
  return c.body(null, 204);
});

app.post('/api/receipts', bodyLimit({
  maxSize: 5 * 1024 * 1024 + 100_000,
  onError: (c) => c.json({ error: 'La imagen puede pesar hasta 5 MB.' }, 413),
}), async (c) => {
  const validator = c.env.RECEIPT_VALIDATOR;
  const key = c.env.RECEIPT_INTEGRATION_KEY;
  if (!validator || !key || key.length < 32) {
    return c.json({ error: 'La validación de comprobantes aún no está habilitada.' }, 503);
  }
  const contentType = c.req.header('Content-Type');
  if (!contentType?.startsWith('multipart/form-data;')) {
    return c.json({ error: 'Adjunta un comprobante como imagen.' }, 415);
  }
  const actor = c.get('identity').operatorId ?? 'admin';
  if (!(await c.env.RECEIPT_LIMIT.limit({ key: actor })).success) {
    return c.json({ error: 'Espera un minuto antes de volver a validar.' }, 429);
  }
  const response = await validator.fetch('https://receipt-validator.internal/api/integrations/neversion/receipts', {
    method: 'POST',
    headers: { 'Content-Type': contentType, Authorization: 'Bearer ' + key, 'X-Neversion-Actor': actor },
    body: c.req.raw.body,
  });
  if (response.status >= 500 || response.status === 401 || response.status === 404) {
    await response.body?.cancel();
    return c.json({ error: 'El validador de comprobantes no está disponible.' }, 502);
  }
  const result = await response.json<{ id?: string; status?: string; reason?: string; message?: string }>();
  return Response.json({ id: result.id, status: result.status, reason: result.reason, message: result.message },
    { status: response.status, headers: { 'Cache-Control': 'no-store' } });
});

app.get('/internal/renewal-digest', async (c) => {
  const key = c.env.REMINDER_API_KEY;
  if (!key || key.length < 32 || !same(c.req.header('Authorization') ?? '', 'Bearer ' + key)) {
    return c.json({ error: 'Acceso restringido.' }, 401);
  }
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Guatemala' }).format(new Date());
  const result = await c.env.DB.prepare(
    'SELECT c.name AS client, v.name AS service, s.due_on AS dueOn, COUNT(*) OVER () AS total ' +
    'FROM subscriptions s JOIN clients c ON c.id = s.client_id JOIN services v ON v.id = s.service_id ' +
    "WHERE s.cancelled_at IS NULL AND s.due_on BETWEEN ? AND date(?, '+3 days') " +
    'ORDER BY s.due_on, s.id LIMIT 20',
  ).bind(today, today).all<{ client: string; service: string; dueOn: string; total: number }>();
  return c.json({
    today,
    total: result.results[0]?.total ?? 0,
    subscriptions: result.results.map(({ client, service, dueOn }) => ({ client, service, dueOn })),
  });
});

app.onError((error, c) => {
  console.error('Request failed', error.name);
  return c.json({ error: 'Ocurrió un error. Intenta de nuevo.' }, 500);
});

export default app;
