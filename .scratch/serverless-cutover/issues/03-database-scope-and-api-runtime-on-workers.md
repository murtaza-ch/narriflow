# 03 - Database scope and API runtime on Workers

**What to build:** Database scope and API runtime on Workers.

**Blocked by:** 02

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.4: engine-free Prisma with adapter-pg over Hyperdrive, scoped clients, Workers exports, `wrangler.jsonc`, raw-body webhooks, Clerk/API-key admission, W/A origins, REST, remote MCP, narrow exports.
- **Files:** `packages/db/src/{client,index}.ts`, `packages/db/package.json`, schema generator, `apps/api/src/{index,runtime,config,server-hooks}.ts`, `http/**`, domain runtimes, `apps/api/wrangler.jsonc`, `packages/services`/`mcp-core` exports, `bun.lock`.
- **Accept:** every mounted route runs under workerd. Inventory and OpenAPI pass. No binding or client crosses requests. Locks, rollback and raw SQL are proven through deployed uncached Hyperdrive. No native module in the final isolate graph (after 07/16/18).

## Evidence

The request/step-scoped engine-free Prisma runtime is implemented. [Deployed isolated Hyperdrive evidence](../evidence/hyperdrive-transactions-20261031.json) proves seven checks through the configured uncached Hyperdrive: interactive transactions, advisory and row-lock exclusion, commit visibility, rollback, server statement cancellation, and a healthy query after cancellation. The separate idle Hyperdrive was not queried.

Every mounted route, final native import closure, and full candidate deployment verification remain open; this ticket remains claimed.
