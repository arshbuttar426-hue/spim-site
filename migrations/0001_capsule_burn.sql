-- Single-view burn registry.
--
-- Authority for "this capsule was opened". D1 is SQLite on a single primary,
-- so writes serialise: the INSERT ... ON CONFLICT below is the fence. Exactly
-- one consume can win (changes = 1); every other attempt is a no-op
-- (changes = 0). That replaces the read-modify-write on KV, which had no
-- compare-and-swap and could burn the same capsule twice from two edges.
--
-- Rows are small and never updated. expires_at exists so a scheduled task can
-- prune: DELETE FROM capsule_burn WHERE expires_at < ?1;

CREATE TABLE IF NOT EXISTS capsule_burn (
  id          TEXT PRIMARY KEY,
  consumed_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS capsule_burn_expires ON capsule_burn (expires_at);
