# Cross-Chain Transaction Relay Gateway (MVP)

A high-throughput service that accepts signed relay requests, validates them, and reliably routes them
to destination blockchains with retries and confirmation tracking.

| Layer | Tech | Responsibility |
|---|---|---|
| `verifier/` | **Rust** (axum, ed25519-dalek, rayon) | Stateless crypto core: parallel batch Ed25519 verification (`verify_strict`) + SHA-256 digest |
| `gateway/`  | **Node.js** (Express, pg) | Public API, validation, chain adapters, relay + confirmation workers |
| Postgres    | **PostgreSQL 16** | Source of truth and distributed work queue (`FOR UPDATE SKIP LOCKED`) |

## Architecture

```
client ──► API (Node) ──► Rust verifier  (batch Ed25519 verify, digest)
              │
              ▼ INSERT (unnest batch, ON CONFLICT DO NOTHING)
          PostgreSQL ◄──── workers (N processes/hosts, SKIP LOCKED claiming)
                              │  pending ─► processing ─► submitted ─► confirmed | failed
                              ▼
                       chain adapters: simulated | evm (JSON-RPC)
```

**Request lifecycle:** `pending → processing → submitted → confirmed | failed`. Every transition is written to
`relay_events` (audit trail). Failed submissions retry with exponential backoff + jitter (`MAX_ATTEMPTS`, default 6).
Workers that crash mid-flight are recovered automatically when their lock expires.

**Security properties**
- Every request is Ed25519-signed over canonical JSON `{v, sourceChain, destChain, nonce, payload}` – signatures bind both chains and the nonce, so a request can't be replayed on another route.
- Replay protection: `UNIQUE (sender_key, nonce)` and `UNIQUE (digest)` in Postgres. Resubmitting the identical request is idempotent (`200 duplicate`); reusing a nonce with different content is `409`.
- API-key auth with constant-time comparison; payload size limits; strict hex/shape validation.

## Quick start (Docker)

```bash
docker compose up --build            # postgres + rust verifier + api + worker
docker compose up --scale worker=4   # scale workers horizontally
node scripts/demo.mjs                # end-to-end demo (needs Node >= 20 on host)
TOTAL=5000 node scripts/load.mjs     # ingest throughput test
```

## Quick start (no Docker)

```bash
# 1. Postgres: create DB/user  (relay / relay / relay) or set DATABASE_URL
# 2. Verifier
cd verifier && cargo run --release            # listens on :7001
# 3. Gateway (new terminal)
cd gateway && npm install && npm start        # API + worker on :8080
# 4. Demo
node scripts/demo.mjs
```
`ROLE=api|worker|all` selects what a gateway process runs. Tests: `cd gateway && npm test` and `cd verifier && cargo test`.

## API  (header `x-api-key: dev-key`)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/relay` | Submit one request → `202 accepted`, `200 duplicate`, `400/401/409` on rejection |
| POST | `/v1/relay/batch` | `{ "requests": [ ... up to 500 ] }` → `207` with per-item results; one verifier round-trip + one INSERT |
| GET  | `/v1/relay/:id` | Status, destination tx hash, attempts, event timeline |
| GET  | `/v1/stats` | Counts by status |
| GET  | `/v1/chains` | Configured chains |
| GET  | `/healthz` | DB + verifier health (no auth) |

Request body:
```json
{ "sourceChain": "sim-alpha", "destChain": "sim-beta", "nonce": 1,
  "payload": { "to": "0xabc", "amount": "42" },
  "publicKey": "<64 hex>", "signature": "<128 hex>" }
```
Signature = Ed25519 over `canonicalize({v:1, sourceChain, destChain, nonce, payload})` (sorted keys, no whitespace).
See `gateway/src/canonical.js` and `scripts/client.mjs` for a reference signer.

## Chains

Configured in `gateway/chains.json` (override path with `CHAINS_FILE`).
- `simulated` – deterministic, stateless fake chain with configurable `confirmMs`, `submitFailRate`, `revertRate` (demos, load tests, CI).
- `evm` – JSON-RPC adapter. `payload.rawTx` is a pre-signed destination transaction; the gateway authenticates the request, broadcasts via `eth_sendRawTransaction`, and tracks `eth_getTransactionReceipt` to N confirmations. Set `"enabled": true` and your `rpcUrl` to use it.

Add a chain type by implementing `validatePayload(p)`, `submit(req) → {txHash}`, `getStatus(req) → {state}` and registering it in `gateway/src/chains/index.js`.

## Configuration (env)

`DATABASE_URL`, `VERIFIER_URL`, `API_KEYS` (comma-separated), `PORT`, `ROLE`, `WORKER_BATCH`, `WORKER_POLL_MS`,
`MAX_ATTEMPTS`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`, `CONFIRM_TIMEOUT_MS`, `MAX_BATCH_ITEMS`.

## Measured locally (sandbox, 1 API + 2 workers, simulated chains)

~2,600 verified + persisted requests/s through `/v1/relay/batch`; all 5,000 reached a terminal state with zero duplicates.
Your numbers will vary with hardware.

## Known MVP limits / next steps

- **Not a light client:** the gateway authenticates *senders*; it does not verify source-chain state (proofs/finality). Next: per-chain light-client or Merkle-proof verification in the Rust core.
- Ed25519 only. Add secp256k1 (ECDSA recovery) in `verifier/` for EVM-native signers.
- EVM adapter: an "already known" broadcast error is retried rather than resolved (needs keccak256 of the raw tx to derive the hash); no gas/nonce management or reorg handling beyond the confirmation depth.
- Static API keys; add per-key rate limits, key rotation and mTLS between API and verifier.
- Add Prometheus metrics, OpenTelemetry tracing, and a dead-letter/ops UI for `failed` requests.
- Schema is applied on boot (`schema.sql`, idempotent); move to a real migration tool before schema changes.
