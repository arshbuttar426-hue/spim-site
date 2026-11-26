-- Security hardening after the release audit.
--
-- KV has no compare-and-swap, so an id cannot be reserved atomically there.
-- D1 writes serialise: INSERT ... ON CONFLICT DO NOTHING is the fence that
-- stops a client-chosen id from overwriting an existing capsule, even when ten
-- uploads race under the same id.
CREATE TABLE IF NOT EXISTS capsule_reservation (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS capsule_reservation_expires ON capsule_reservation (expires_at);

-- A consume receipt is a client-held retry token. It lets a browser recover a
-- lost consume response without handing the payload to a second reader. This
-- table is additive: the 0001 burn table stays authoritative for legacy rows.
CREATE TABLE IF NOT EXISTS capsule_open (
  id           TEXT PRIMARY KEY,
  receipt      TEXT NOT NULL,
  consumed_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS capsule_open_expires ON capsule_open (expires_at);
