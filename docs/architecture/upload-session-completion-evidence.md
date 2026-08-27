# Upload Session completion evidence

Evidence run on 28 August 2026 against the pre-production direct-cutover path.
The fixed code-review baseline is `10fa51faa0b2c9b0f65040a780f26968d0362736`.

## Public interfaces

- The Upload Session module owns open/resume, grants, status, finalization,
  discard, compensation, reconciliation, expiry, and the atomic Project,
  Content Pack, and Ingest Job handoff.
- The browser adapter exposes one snapshot and the `start`, `pause`, `discard`,
  `startFresh`, `shouldConfirmUnload`, and `dispose` lifecycle interfaces. React
  renders those facts and never accepts a provider upload ID, key, expiry,
  ETag, or part plan.
- Hono exposes strict open, grant, finalize, status, and discard schemas with
  typed status mapping, per-actor rate limits, and no raw provider errors.
- The worker maintenance loop, Prisma persistence, and R2 implementation are
  adapters behind the module interface. Link and RSS intake remain on their
  existing paths.

## Reproducible verification

| Gate | Result |
| --- | --- |
| Upload Session module | 71 passed |
| Browser adapter | 27 passed |
| React state/accessibility | 4 passed |
| Hono contracts | 10 passed |
| R2 adapter suite | 15 passed; four opt-in live scenarios cover direct PUT, multipart, provider pagination, embedded completion errors, CORS/ETag, expiry, HeadObject, NoSuchUpload, abort, delete, and exact-key recovery |
| Disposable PostgreSQL | all 54 migrations applied; two recovery/concurrency drills passed with 76 assertions across the module and Prisma CAS paths |
| Repository tests | all 12 workspace tasks passed |
| Typecheck | all 12 workspace tasks passed |
| Biome | 643 files clean |
| Production build | all 12 workspace tasks passed; Next.js generated 52 pages |

Commands:

```sh
bun run typecheck
bun run lint
bun run lint:biome
bun run test
bun run build
bun run test:upload-session:db
R2_CONTRACT_TEST_PREFIX=tests/narriflow-upload-session-cutover bun --env-file=apps/worker/.env test packages/services/src/r2-storage.test.ts
```

The R2 run used random UUID paths below the dedicated test prefix and cleaned
up in success and failure. The `narriflow-dev` bucket now has a narrow CORS rule
for `http://localhost:3000`: GET/HEAD/PUT, `Content-Type`, exposed `ETag`, and a
one-hour preflight cache. Its seven-day incomplete-multipart abort rule remains
enabled. Add the deployed app origin to this rule before a non-local deployment.
The live expired-signature response intentionally records R2's actual behavior:
it omits CORS response headers, so browser code treats it as an opaque transfer
failure and resumes through a fresh server-issued grant without parsing provider
error detail.

## Cost and performance evidence

- Direct upload asserts one PutObject and one exact HeadObject probe, with no
  multipart operations.
- Healthy multipart asserts one initiation, exactly the planned part writes,
  one completion, and one exact HeadObject probe, with no ListParts.
- Recovery fixtures separately assert the extra ListParts, exact unfinished
  upload inventory, completion retry, abort, delete, and reconciliation calls.
- Public-adapter small, medium, 1 GiB, and 5 GiB fixtures measure first-grant
  latency, response bytes, steady throughput, retry bytes, live part-body bytes,
  finalize latency, reconciliation latency, and provider-operation counts. They
  enforce at most 64 MiB of concurrent bodies and a 10% floor against the
  recorded 64 MiB/s local signed-PUT baseline. The separate virtual-clock test
  remains deterministic coverage of byte accounting, not operational evidence.
- Structured diagnostics and service metrics provide planned Class A operation
  counts, completion-part counts, and declared-abandoned-byte cost proxies. A
  key-allowlist test proves that transition records contain no provider secrets
  or object facts.

## Browser evidence and remaining environment gate

The authenticated Chrome session loaded `/upload` with a clean application
console, completed the supplied YouTube import, created the same queued Project,
continued through ingest, and showed the unchanged processing timeline. A
fresh upload-page render also passed visual and accessibility inspection after
the adapter/UI refactor.

Native local-file selection remains an automation-environment gate, not an app
failure: the ChatGPT Chrome extension returns `Not allowed` because file-URL
access is disabled, and browser security policy prevents the agent from opening
`chrome://extensions` to change it. The live R2 contracts, browser-adapter
tests, and React tests cover the local-file protocol, but the native Chrome
small-audio/multipart/Pause/Discard checklist must be repeated after that
permission is enabled. The architecture recommendation must not be counted as
complete until that last real-browser row passes.

To unblock it: open `chrome://extensions`, click **Details** under the ChatGPT
browser extension, and enable **Allow access to file URLs**. Then rerun the
browser checklist in [the operational runbook](../runbooks/upload-session-intake.md).
