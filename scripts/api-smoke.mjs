import assert from 'node:assert/strict';

const base = process.env.NEVERSION_TEST_URL || 'http://127.0.0.1:8787';
const nonce = crypto.randomUUID().slice(0, 8);

async function call(path, status, { token, method = 'GET', payload } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(payload && { 'Content-Type': 'application/json' }),
    },
    body: payload && JSON.stringify(payload),
  });
  const data = response.status === 204 ? undefined : await response.json();
  assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
  return data;
}

for (let i = 0; ; i++) {
  try { await call('/health', 200); break; }
  catch (error) {
    if (i === 29) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

await call('/api/dashboard', 401);
await call('/internal/renewal-digest', 401);
const { token } = await call('/api/login', 200, {
  method: 'POST', payload: { email: 'admin@example.test', password: 'local-example-change-me' },
});
const { id: clientId } = await call('/api/clients', 201, { token, method: 'POST', payload: { name: 'Cliente ' + nonce } });
const { id: serviceId } = await call('/api/services', 201, { token, method: 'POST', payload: { name: 'Servicio', priceCents: 4599 } });
const { id } = await call('/api/subscriptions', 201, {
  token, method: 'POST', payload: { clientId, serviceId, dueOn: '2030-09-30' },
});
await call('/api/subscriptions/' + id, 204, {
  token, method: 'PATCH', payload: { action: 'renew', dueOn: '2030-10-31' },
});
const dashboard = await call('/api/dashboard', 200, { token });
assert.equal(dashboard.subscriptions.find((item) => item.id === id)?.due_on, '2030-10-31');
assert.equal(dashboard.subscriptions.find((item) => item.id === id)?.price_cents, 4599);

await call('/api/services/' + serviceId, 204, {
  token, method: 'PATCH', payload: { name: 'Servicio actualizado', priceCents: 5999 },
});
const afterEdit = await call('/api/dashboard', 200, { token });
assert.equal(afterEdit.services.find((item) => item.id === serviceId)?.price_cents, 5999);
assert.equal(afterEdit.subscriptions.find((item) => item.id === id)?.price_cents, 4599);

const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Guatemala' }).format(new Date());
await call('/api/subscriptions', 201, {
  token, method: 'POST', payload: { clientId, serviceId, dueOn: today },
});
const digest = await call('/internal/renewal-digest', 200, {
  token: 'local-example-reminder-key-only-not-for-production',
});
assert.ok(digest.subscriptions.some((item) => item.client === 'Cliente ' + nonce && item.dueOn === today));
await call('/api/clients/' + clientId, 204, { token, method: 'PATCH', payload: { action: 'archive' } });
const afterArchive = await call('/api/dashboard', 200, { token });
assert.ok(!afterArchive.clients.some((item) => item.id === clientId));
assert.ok(afterArchive.subscriptions.some((item) => item.id === id));

const operatorEmail = nonce + '@example.test';
const password = 'operator-example-1234';
await call('/api/operators', 204, { token, method: 'POST', payload: { email: operatorEmail, password, days: 1 } });
const operators = await call('/api/operators', 200, { token });
const operator = operators.operators.find((item) => item.email === operatorEmail);
assert.ok(operator);
const login = await call('/api/login', 200, { method: 'POST', payload: { email: operatorEmail, password } });
assert.equal(login.role, 'operator');
await call('/api/clients', 403, { token: login.token, method: 'POST', payload: { name: 'Bloqueado' } });
await call('/api/operators/' + operator.id, 204, { token, method: 'DELETE' });
await call('/api/dashboard', 401, { token: login.token });

await call('/api/logout', 204, { token, method: 'POST' });
await call('/api/dashboard', 401, { token });
console.log('Probados en Workers y D1: login, persistencia, renovación, permiso de operador, revocación y cierre de sesión.');
