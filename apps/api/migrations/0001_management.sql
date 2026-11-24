CREATE TABLE clients (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  archived_at INTEGER
);
CREATE INDEX clients_name ON clients(name, id);

CREATE TABLE services (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  archived_at INTEGER
);
CREATE INDEX services_name ON services(name, id);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  due_on TEXT NOT NULL,
  cancelled_at INTEGER
);
CREATE INDEX subscriptions_due ON subscriptions(due_on, id);
CREATE INDEX subscriptions_client ON subscriptions(client_id);
CREATE INDEX subscriptions_service ON subscriptions(service_id);

CREATE TABLE operators (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  access_until INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  operator_id TEXT REFERENCES operators(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
