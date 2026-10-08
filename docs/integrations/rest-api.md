# Public REST API v1

The public reference is the marketing page at `/developers/api`; the
OpenAPI 3.1 document is served at `GET /api/v1/openapi.json`. This page is
for people who run and change the API. [ADR 0013](../adr/0013-integration-surfaces.md)
records the design.

## Where things live

- `apps/web/app/api/v1/[[...route]]/route.ts` mounts the app. It is a
  separate Hono app, not part of the browser API or its declaration
  inventory. `apps/web/proxy.ts` lets `/api/v1` bypass Clerk.
- `apps/web/lib/rest-api/app.ts` holds the routes; REST envelopes live in
  `packages/validators/src/rest-api.ts`. `REST_ENDPOINT_COMMANDS` maps every endpoint to one
  integration command.
- `packages/services/src/integration-admission.ts` is the command table
  shared with MCP. `integration-commands.ts` holds the shared commands,
  derived keys, and resource views.
- `packages/services/src/operation-receipt.ts` is the Operation Receipt
  executor. `completion-callback.ts` and `completion-callback-runtime.ts`
  hold Completion Callbacks; the worker's `completion_callbacks` loop runs
  them.

## Rules

- Only Workspace API keys (`nf_…`) authenticate. OAuth bearer tokens are
  out of scope for v1.
- Requests that start work need `Idempotency-Key`. Upload grants,
  finalize, and discard are keyed by the Upload Session ID instead.
- Rate limit: 300 requests a minute per key, in the `rest:<apiKeyId>`
  bucket. While Upstash is unavailable, reads and receipt replays proceed
  and new mutations return `503 mutations_unavailable`.
- Changes within v1 are additive. The OpenAPI document is snapshot-tested
  (`apps/web/lib/rest-api/__snapshots__`); review any snapshot diff for
  removed or tightened fields before updating it. Breaking changes need
  `/api/v2`.
- No publishing, Autopilot management, review creation, content suite, or
  cancellation endpoints in v1.

## Completion Callbacks

- A Workspace needs a signing secret (Settings → API) before any request
  may include `callback.url`; otherwise acceptance returns
  `409 callback_secret_required` and no work starts.
- URLs and secrets are sealed with AES-256-GCM under a key derived from
  `SOCIAL_TOKEN_ENCRYPTION_KEY`, which web and worker must share.
- `COMPLETION_CALLBACK_POLL_INTERVAL_MS` (worker, default 5000) sets how
  often the loop looks for due rows. Each waiting row backs off on its own
  from 15 seconds to 5 minutes.
- Logs: `completion_callback_attempt` records Workspace, operation, event
  ID, host, attempt, status, duration, and disposition. They never carry
  the URL path, query, or payload.

## Verification

`bun run test:integration-api:db` covers receipts, callbacks, Operation
Status, and MCP Tasks in a disposable schema. The REST contract suite is
`apps/web/lib/rest-api/app.test.ts`, and
`apps/web/lib/integration-admission-parity.test.ts` checks every REST
endpoint and MCP tool against its browser peer. The n8n template has its
own acceptance runs in [n8n/README.md](n8n/README.md).
