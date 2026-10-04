# 03 - Contracts and tool workflow

**What to build:** Strict compact schemas/projections, complete intake-to-publication tools, scope parity, exact intent confirmation.

**Blocked by:** [02 - Domain retries](02-domain-retries.md).

**Status:** done

**Owner:** workflow implementer

- [x] Every tool has strict request/result contract and current admission policy.
- [x] No sensitive/internal snapshots, explicit mutation workspace, pagination/excerpt controls.
- [x] Exact-post confirmation and transport wire tests pass.

## Comments

The SDK factory registers all 23 model tools with validators-owned contracts and compact projections. Mutations select a workspace and supply a retry key. OAuth and API keys use the same application permissions; all five reads are API-key defaults, and each write is selected explicitly. Clip lists default to 20, cap at 50, and load transcript excerpts only on request.

Exact publication confirmation binds caller, workspace, intent, operation key, and a ten-minute expiry. Modern elicitation, App buttons, and authenticated web confirmation use the same signed intent. Scheduling reads an already accepted intent before requesting approval again, including a lost MRTR response whose private receipt never reached the caller. New scheduling still checks approval expiry, the mutation limiter, current membership, and the authoritative review gate. The strict MCP intent excludes hidden thumbnails, assisted copy references, immediate timing shortcuts, and review overrides; the confirmation views show every accepted intent field.

Generation Tasks follow their exact STT and detection lineage, then frozen ordinary render IDs. Durable child outcomes preserve the original result through Studio cache resets and later clip replacement. Retryable child failures remain working, unrelated shared work does not affect settlement, and cancellation stops only original pending work without an accepted terminal outcome. Export cancellation targets the selected export and preserves shared runs, other exports, and running claims.

Verification: 107 deterministic tests across ten suites covering the owned contracts, admission, SDK wire workflow, browser policy parity, read defaults, publishing facts, and generation-family resolution passed. MCP core/services typechecks and the affected Biome checks passed. The final local disposable PostgreSQL gate passed 11 operation and 11 Task lifecycle tests (123 assertions) with all 99 migrations and schema cleanup. Actual client OAuth acceptance remains ticket 06.
