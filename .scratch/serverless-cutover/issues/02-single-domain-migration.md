# 02 - Single domain migration

**What to build:** Single domain migration.

**Blocked by:** 01

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** `ExecutionDispatch`; durable inbox/delivery receipts; epoch/generation bindings; executor owner acquisition; explicit operation/submission/result deadlines; `SourceAudio` and source revision binding; due indexes; destination delivery facts replacing Redis-specific event columns. Explicit, reviewed dev reset list. Keep usage/refund audits, work-set membership, execution ledgers and publication receipts. No `SourceRange`.
- **Files:** `packages/db/prisma/schema.prisma`, one `migrations/*_serverless_execution/migration.sql`.
- **Accept:** fresh and dev-shaped DBs migrate on disposable databases only. Uniques, checks and indexes hold. Every removed claim field has a documented replacement predicate.

## Evidence

Pending implementation and verification.
