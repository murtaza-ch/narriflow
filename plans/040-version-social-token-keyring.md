# Plan 040: Version and rotate social OAuth token encryption safely

> **Credential migration — approval required**: A bad rollout can make every
> connected social account undecryptable. Inventory ciphertext/key deployment
> state, back up the database, and rehearse with copied synthetic/test-account
> rows before touching production. Never log plaintext tokens or key material.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- packages/services/src/social-oauth.service.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations apps/web/.env.example apps/worker/.env.example README.md packages/services/src/*.test.ts`

## Status

- **Priority**: P1 before native social publishing GA
- **Effort**: M
- **Risk**: HIGH
- **Confidence**: HIGH
- **Depends on**: plans/041-production-shaped-integration-gates.md
- **Category**: security, secrets, migration, operations
- **Planned at**: commit `05d273d`, 2026-07-10, live working tree

## Why this matters

`getTokenCryptoKey()` accepts any non-empty
`SOCIAL_TOKEN_ENCRYPTION_KEY`; values that do not decode to 32 bytes are silently
SHA-256 hashed (`packages/services/src/social-oauth.service.ts:92-97`). This
converts an operator passphrase of unknown entropy into a valid AES key without
warning. Ciphertext contains only `v1:iv:tag:ciphertext` and no key identifier
(`social-oauth.service.ts:99-126`), so replacing the environment value can
orphan every existing connection.

The database stores only ciphertext strings
(`packages/db/prisma/schema.prisma:485-500`), and both web and worker must share
the same key. Rotation therefore needs explicit versioning, dual-read/new-write
deployment, migration checkpoints, and an auditable rollback window.

## Target invariants

1. Production accepts only explicitly encoded, exactly 32-byte random keys with
   stable key IDs; weak passphrase derivation fails startup.
2. Ciphertext authenticates its format, key ID, and relevant record context.
3. Readers can decrypt approved active/retiring keys; writers always use one
   configured primary key.
4. Rotation is resumable, idempotent, observable, and never removes an old key
   until every live ciphertext is proven migrated.
5. Web and worker reject incompatible keyring configuration before serving or
   publishing.
6. Plaintext tokens and key bytes never appear in logs, errors, metrics, tests,
   migration output, or support UI.

## Phase 1: Define the envelope and configuration contract

Choose a versioned envelope such as:

`v2:<key-id>:<nonce>:<tag>:<ciphertext>`

Use AES-256-GCM or an equally reviewed authenticated-encryption primitive.
Include additional authenticated data binding at minimum envelope version,
record/account ID, platform, and token kind (`access` or `refresh`) so copied
ciphertext cannot be silently replayed into a different context.

Define configuration as:

- one primary key ID;
- a keyring map of ID to strict base64-encoded 32-byte keys;
- an allowlist of decrypt-only retiring key IDs;
- startup validation for duplicate/unknown IDs, invalid encoding/length, missing
  primary, and environment mismatch.

Keep secret-manager/KMS adoption as a compatible provider abstraction. Do not
invent a custom cryptographic derivation or serialize raw key material into DB.

## Phase 2: Dual-read, new-write rollout

1. Add pure envelope parse/encrypt/decrypt helpers with stable safe error codes.
2. Deploy readers that support current `v1` plus `v2` keyring ciphertext while
   all writers emit `v2` under the primary key.
3. For legacy `v1`, require the explicitly configured legacy key and validate it
   as 32-byte base64. Do not retain passphrase hashing as a silent fallback.
4. Add a non-secret `encryptionKeyId`/version column only if it materially
   improves queryability; the envelope remains self-describing. Keep access and
   refresh token migration atomic per account.
5. Validate web/worker configuration parity with a safe key-ID fingerprint or
   deployment check that never exposes key bytes.

## Phase 3: Resumable re-encryption job

- Process bounded account batches by stable cursor.
- Decrypt with the envelope's old key, immediately re-encrypt under primary,
  and update only if the ciphertext/version still matches the row read.
- Mark per-row migration outcome/attempt with safe error classification; no
  plaintext staging table or durable job payload.
- Re-running the job skips current primary ciphertext and safely retries only
  failures.
- Track counts by envelope/key ID: total, migrated, remaining, invalid, revoked,
  and unreachable—never token length/content.
- Revoke/disconnect unrecoverable accounts explicitly rather than leaving them
  appearing active.

## Phase 4: Rotation runbook and retirement

Document and rehearse:

1. generate a random 32-byte key with the approved secret manager/tool;
2. deploy it decrypt-capable but not primary;
3. promote it to primary for all writers;
4. run and monitor migration;
5. verify zero live rows under the retiring key and successful test-account
   refresh/publish in every provider adapter;
6. retain rollback access for the approved window;
7. remove the retiring key and prove startup/read tests fail closed if stale
   ciphertext is introduced.

Key rotation does not replace provider-token revocation, account disconnect,
least-privilege scopes, or Plan 030 deletion.

## Test plan

- Unit: strict key parsing, v1/v2 envelopes, AAD mismatch, wrong key, tampered
  nonce/tag/ciphertext, unknown version/ID, access-versus-refresh substitution.
- Property/fuzz: malformed envelopes never crash or leak raw data.
- Integration with Postgres: dual-read/new-write, conditional migration,
  concurrent token refresh versus migration, partial batch failure and restart.
- Deployment: web/worker same-keyring readiness, missing/weak key fails startup,
  old-key removal blocked while rows remain.
- Provider sandbox: migrated access/refresh token can read/refresh/publish;
  failure disconnects safely without retrying an irreversible publish.
- Logging test: captured logs/errors contain no plaintext token/key fixture.

## Done criteria

- [ ] Production rejects weak/non-32-byte key configuration.
- [ ] New ciphertext includes a version and key ID and is context-authenticated.
- [ ] Dual-read/new-write rollout is backward compatible.
- [ ] Every active account is migrated or explicitly disconnected with a safe
  reason before old-key retirement.
- [ ] Rotation can resume after failure and has a tested rollback window.
- [ ] Web/worker readiness detects keyring mismatch before provider operations.
- [ ] No plaintext token or key material is logged or persisted outside the
  encrypted fields/secret manager.

## STOP conditions

- The current production key value/encoding or ciphertext population cannot be
  inventoried without printing secrets.
- There is no database backup or provider test account for rehearsal.
- Web and worker cannot deploy dual-read support before primary-key change.
- A migration design decrypts tokens into a durable queue, file, log, or
  analytics payload.
- Any live ciphertext remains under a key proposed for removal.
- Rotation is combined with unrelated social-provider behavior changes.
