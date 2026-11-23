import { readFile, writeFile } from 'node:fs/promises';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !/^[a-f0-9]{32}$/i.test(account) || !token) {
  throw new Error('Configura CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN.');
}

const path = new URL('../apps/api/wrangler.jsonc', import.meta.url);
const config = JSON.parse(await readFile(path, 'utf8'));
const db = config.d1_databases[0];
const endpoint = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/d1/database';

async function call(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    const codes = body.errors?.map(({ code }) => code).join(', ') || 'unknown';
    throw new Error('Cloudflare D1: HTTP ' + response.status + ', códigos ' + codes);
  }
  return body.result;
}

const matches = await call(endpoint + '?name=' + encodeURIComponent(db.database_name));
const existing = matches.find((database) => database.name === db.database_name);
const database = existing ?? await call(endpoint, {
  method: 'POST',
  body: JSON.stringify({ name: db.database_name }),
});
if (!/^[a-f0-9-]{36}$/i.test(database.uuid)) throw new Error('Cloudflare no devolvió un ID de D1 válido.');
db.database_id = database.uuid;
const validator = process.env.RECEIPT_VALIDATOR_SERVICE;
if (validator) config.services = [{ binding: 'RECEIPT_VALIDATOR', service: validator }];
await writeFile(new URL('../apps/api/wrangler.deploy.jsonc', import.meta.url),
  JSON.stringify(config, null, 2) + '\n');
console.log('D1 de despliegue preparado.');
