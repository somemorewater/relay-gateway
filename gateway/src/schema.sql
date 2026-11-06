CREATE TABLE IF NOT EXISTS relay_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  digest          TEXT NOT NULL UNIQUE,            -- sha256 of canonical signed message (computed by Rust core)
  sender_key      TEXT NOT NULL,                   -- ed25519 public key, hex
  nonce           BIGINT NOT NULL,
  source_chain    TEXT NOT NULL,
  dest_chain      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  signature       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','submitted','confirmed','failed')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by       TEXT,
  locked_until    TIMESTAMPTZ,
  dest_tx_hash    TEXT,
  last_error      TEXT,
  submitted_at    TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sender_key, nonce)                       -- replay protection
);

CREATE INDEX IF NOT EXISTS relay_requests_work_idx ON relay_requests (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS relay_requests_sender_idx ON relay_requests (sender_key, created_at DESC);

CREATE TABLE IF NOT EXISTS relay_events (
  id          BIGSERIAL PRIMARY KEY,
  request_id  UUID NOT NULL REFERENCES relay_requests(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_events_request_idx ON relay_events (request_id, id);
