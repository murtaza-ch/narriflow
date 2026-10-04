# MCP Standards review

Reviewed the complete working diff against `6a31c20f75be0a67daf86e3046bcb5e47598ff44`, including untracked implementation files, on `dev`. No commits exist after the baseline. Standards consulted: root `AGENTS.md`, web `AGENTS.md`, `CONTEXT.md`, and ADR 0001's authoritative workflow lifecycle boundary. Tooling-enforced style is excluded. Findings below concern observable correctness at the documented upload, workflow, and publication boundaries.

## Actionable findings

No remaining actionable findings in the reviewed auth, HTTP, stdio, upload, publication, export cancellation, Task adapter, and generation-family history changes.

## Repairs verified during review

Export cancellation now lives in `ClipExportService`, cancels only its pending variants even before assignment, and preserves running variants and shared render runs. Eleven disposable PostgreSQL domain tests pass, including shared exports and four races with the real worker claim method (77 assertions). Minimal MCP identity lookup selects only `User.id` and still excludes deleted users; it avoids unrelated shared development schema drift.

Task handles now retain only the schema-validated operation metadata needed by the progress card, while excluding other private metadata. Seven combined wire/registry tests passed. Retained expired Task records no longer shorten operation replay lifetime: their original accepted tool result is returned, and direct access to expired task handles remains unavailable.

The publication card now treats a lost scheduling response as uncertain, disables Decline, retains its approval receipt, and permits retry of the same immutable intent. Confirmed scheduling and explicit decline remain terminal. Three card-decision tests pass, including lost-response behavior.

Eventual Task ToolResults now explicitly carry private zero-TTL cache fields; nested outcomes do not receive the SDK's top-level stamping.

The final generation resolver freezes exact render IDs at handoff, retains durable child outcomes independently of mutable Studio caches, and waits through retryable failures. Cancellation excludes already settled IDs so it cannot stop a later Studio re-render. The actual lifecycle regression proves failure, requeue, and later successful completion. Concurrent Task registration now recovers a unique-identity race instead of depending on Prisma's emulated empty-update upsert. Request fingerprints use locale-independent key ordering, verified against a literal Unicode SHA-256 fixture.

Final disposable PostgreSQL verification passed **22 tests, 123 assertions**, applying all **99 migrations** and dropping the isolated schema. Log: `/tmp/narriflow-mcp-db-99-final.log`. Actual live client/media acceptance is deferred by the user; shared migrations remain the root agent's deployment task. No live client success is inferred from these deterministic gates.
