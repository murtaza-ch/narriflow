# Plan 023: Bound remote media ingest, stream R2 uploads, and canonicalize OAuth returns

> **Executor instructions**: Follow every step and verification. Touch only
> scoped files. Stop rather than improvising when a STOP condition occurs. The
> reviewer owns `plans/README.md`.
>
> **Working-tree override**: current product code is uncommitted. Work directly
> in the shared tree; do not branch, stage, commit, push, or revert unrelated
> work.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- packages/services/src/url-guard.ts packages/services/src/url-guard.test.ts packages/services/src/rss.ts packages/services/src/r2-storage.ts packages/services/src/index.ts apps/worker/src/tasks/ingest.ts 'apps/web/app/api/[[...route]]/route.ts' apps/web/lib packages/validators/src/error-messages.ts packages/validators/src/error-messages.test.ts`
> Inspect live code because the working tree is intentionally ahead of HEAD.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 021
- **Category**: security, correctness, performance
- **Planned at**: commit `05d273d`, 2026-07-09, live working tree
- **Result**: REOPENED — RSS/R2/OAuth boundaries remain implemented, but fresh
  review found the YouTube `yt-dlp` subprocess/download path has no timeout,
  output bound, single-item flag, pre-download byte limit, or maximum-duration
  enforcement. Production OAuth still has a validated canonical app origin.

## Why this matters

RSS enclosure imports currently call unrestricted `fetch()` on a URL supplied
by a client/feed, follow redirects automatically, and stream unlimited bytes to
disk. A hostile enclosure can reach internal services or exhaust worker disk,
bandwidth, and R2. Separately, `putFileFromPath` calls `readFileSync`, so one
legitimate 5 GB source can exhaust the worker's memory. Media whose duration
cannot be probed is admitted as zero minutes, allowing costly transcription to
bypass plan limits. Finally, OAuth accepts backslash-containing return paths
that WHATWG URL parsing can reinterpret as an external authority.

## Current state

- `packages/services/src/url-guard.ts` rejects obvious private literals but
  does not resolve hostnames, validate redirect hops, reject credentials, or
  bound responses.
- `packages/services/src/rss.ts:49-63` validates the original feed URL only,
  then uses automatic redirects and unbounded `response.text()`.
- `apps/worker/src/tasks/ingest.ts:228-244` uses unrestricted `fetch` for RSS
  enclosures and pipes until EOF; it trusts feed/client duration.
- `apps/worker/src/tasks/ingest.ts:101-112` catches upload duration probe errors
  and stores `null`; `project.service` admission treats null duration as zero.
- `packages/services/src/r2-storage.ts:206-221` uses `readFileSync` as
  `PutObject.Body` even though accepted media can be 5 GB.
- `apps/web/app/api/[[...route]]/route.ts:75-80` accepts any single-slash
  prefix. Backslashes/control/encoded authority delimiters are not rejected;
  `new URL(result.redirectPath, origin)` later interprets the saved value.
- The only current caller requests `/settings/social`. Prefer an allowlist or a
  strict canonical same-origin pathname contract; arbitrary external returns
  are not a product requirement.
- `MAX_UPLOAD_SIZE_BYTES` and `MAX_MEDIA_DURATION_SECONDS` already live in
  `packages/validators/src/upload.ts`; reuse them rather than adding conflicting
  limits.

## Scope

Only modify/create:

- `packages/services/src/url-guard.ts`
- `packages/services/src/url-guard.test.ts`
- `packages/services/src/rss.ts`
- `packages/services/src/r2-storage.ts`
- `packages/services/src/index.ts`
- `apps/worker/src/tasks/ingest.ts`
- `apps/web/lib/safe-redirect.ts` (create)
- `apps/web/lib/safe-redirect.test.ts` (create)
- `apps/web/app/api/[[...route]]/route.ts`
- `packages/validators/src/error-messages.ts`
- `packages/validators/src/error-messages.test.ts`

Out of scope:

- Multipart-session schema/lifecycle migration.
- Account deletion, billing entitlement, workflow lease, or social-publish
  reconciliation.
- New npm dependencies or package-manifest/lockfile changes.
- Provider-specific allowlists for podcast CDNs.
- Logging URL query strings, credentials, resolved private addresses, or other
  sensitive values.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Targeted services tests | `bun test packages/services/src/url-guard.test.ts` | all pass |
| Redirect tests | `bun test apps/web/lib/safe-redirect.test.ts` | all pass |
| Error taxonomy tests | `bun test packages/validators/src/error-messages.test.ts` | all pass |
| Full lint | `bun run lint:biome` | exit 0 |
| Full typecheck | `bun run typecheck` | exit 0 |
| Full tests | `bun run test` | exit 0 |
| Build | `bun run build` | exit 0 |

## Steps

### Step 1: Build a tested public-HTTP boundary

Extend the existing URL guard without adding a dependency:

- Reject non-http(s), embedded username/password, obvious private hostnames,
  control characters, and private/reserved IP literals.
- Resolve hostnames with `node:dns/promises.lookup({ all: true, verbatim: true })`
  and reject the request if any returned address is loopback, private,
  link-local, unspecified, multicast, carrier-grade NAT, or reserved. Cover
  IPv4-mapped IPv6.
- Add a guarded fetch helper that performs redirects manually (maximum five),
  revalidates and re-resolves every hop, rejects missing/invalid `Location`,
  and uses a finite timeout. Do not forward a caller's authorization/cookie
  headers across hosts.
- Add bounded body helpers or a reusable byte-counting transform so both feed
  text and enclosure streaming can stop immediately above an explicit limit.
- Make network/fetch/DNS dependencies injectable only where needed for
  deterministic unit tests; production exports must use safe defaults.

Tests must cover: public host accepted; hostname resolving to 127/10/169.254
rejected; mixed public+private answers rejected; credential URL rejected;
public redirect accepted; redirect to private host rejected before the second
fetch; redirect loop/limit rejected; over-limit body rejected.

**Verify**: targeted URL-guard tests pass and no test performs real network IO.

### Step 2: Apply the boundary to RSS feeds and enclosures

Use the guarded fetch for the feed and for enclosure downloads.

- Bound feed XML to a small production-safe limit (5 MiB is sufficient for 50
  episodes). Reject oversized `Content-Length` before reading and enforce the
  same limit while streaming when the header is absent/false.
- In the worker, cap enclosure bytes at `MAX_UPLOAD_SIZE_BYTES`, validate both
  declared and streamed byte counts, and allow only audio/video media types
  plus a conservative `application/octet-stream` fallback used by podcast
  CDNs. Fail other types before R2 upload.
- Use manual redirect safety from Step 1 and a finite but realistic media
  download timeout. Always close/cancel response bodies and remove temp files
  on errors.
- Map unsafe URL, timeout, oversized media, invalid content type, and download
  failures into stable worker error codes. Add actionable, provider-neutral
  messages for the new codes in the shared error taxonomy; do not expose raw
  hosts or provider internals.

**Verify**:

- `rg -n 'fetch\(' packages/services/src/rss.ts apps/worker/src/tasks/ingest.ts`
  shows no unguarded RSS feed/enclosure fetch path.
- Full tests cover error-message mappings.

### Step 3: Require an authoritative duration before paid processing

For upload finalization, YouTube, and RSS:

- Probe the authoritative object/local downloaded file before completing the
  ingest job. For YouTube, provider metadata may be the first value but fall
  back to ffprobe when missing/invalid. For RSS, ignore client/feed duration as
  authoritative and probe the downloaded file.
- If a finite positive duration cannot be established, fail ingest with a
  stable actionable `media_duration_unavailable` code instead of completing
  with `null`/zero admission.
- Reuse `MAX_MEDIA_DURATION_SECONDS` downstream admission; do not duplicate
  plan-tier policy in the worker.

**Verify**: no successful completion branch in this file deliberately passes a
null source duration for upload, YouTube, or RSS.

### Step 4: Stream filesystem uploads into R2

Replace `readFileSync` with `createReadStream`. Use `stat()` for
`ContentLength`, pass the Node readable to `PutObject`, and ensure stream errors
propagate. Keep the function's key/file-name return contract unchanged. Do not
read the whole file anywhere else as a workaround.

**Verify**:

- `rg -n 'readFileSync' packages/services/src/r2-storage.ts` returns no match.
- Typecheck/build accept the AWS SDK body type under Bun/Node.

### Step 5: Canonicalize OAuth return paths

Create a small pure helper and tests. The helper must return a safe default for
empty/external/scheme-relative/backslash/control-character/encoded-slash or
encoded-backslash inputs. It must parse against a fixed dummy HTTPS origin and
return only the canonical pathname/search/hash when the result is same-origin.
Because the only current destination is `/settings/social`, an explicit
allowlist for that route (and its query/hash) is preferred and safest.

Use this helper at both OAuth start and error-return sites. The stored state and
callback must never receive a noncanonical value.

Tests must include `//evil.example`, `/\\evil.example`, `%5c`, `%2f`, an
absolute URL, control characters, a valid `/settings/social`, and a valid query.

**Verify**: redirect tests pass and the inline weak helper no longer exists in
the route file.

### Step 6: Run the release gates and inspect the diff

Run every command in the table and read the full diff. Confirm no manifest,
lockfile, schema, or migration changed.

### Step 7: Bound the YouTube subprocess and download (reopened follow-up)

`apps/worker/src/tasks/ingest.ts:69-103` buffers unbounded stdout/stderr and has
no timeout/termination path. Both `yt-dlp` calls at `:202-220` omit
`--no-playlist`; the download has no pre-download size bound. Final `stat()` is
too late to prevent disk exhaustion. `requireDuration` at `:161-169` also checks
only positivity, not `MAX_MEDIA_DURATION_SECONDS`.

Implement all of the following:

- make the subprocess helper accept an explicit wall timeout, bounded stdout/
  stderr capture and abort signal; on expiry/abort, terminate the complete child
  process group, wait a short grace period, force-kill if needed, and settle once;
- never include unbounded/raw `yt-dlp` stderr in a user-facing or structured
  error; keep a small redacted diagnostic tail;
- pass `--no-playlist`, `--max-downloads 1`, bounded retries/socket timeout, and
  the official `--max-filesize` option to metadata/download paths as applicable;
  keep final streamed/disk byte enforcement because provider size may be absent;
- reject known metadata duration above `MAX_MEDIA_DURATION_SECONDS` before
  download, then probe and enforce the same absolute maximum on the downloaded
  artifact before R2 upload/completion;
- define behavior for live/unknown-duration videos explicitly. Do not allow an
  unbounded live download under the normal import path;
- preserve cleanup in every timeout/kill/oversize/error branch.

Official option reference: <https://github.com/yt-dlp/yt-dlp#video-selection>
and <https://github.com/yt-dlp/yt-dlp#download-options>.

Tests must use a deterministic fake child/executable and cover playlist URLs,
stalled metadata/download, output flooding, graceful/forced kill, known and
probed over-duration media, announced/actual oversize, and temp cleanup. No test
downloads real YouTube media.

## Done criteria

- [x] Feed and enclosure requests resolve public addresses, validate every
  redirect, time out, and enforce byte limits.
- [x] Private/loopback/redirect/oversize cases have deterministic tests.
- [x] Unknown duration cannot complete ingest as zero minutes.
- [x] Files stream to R2 without whole-file buffering.
- [x] OAuth return paths are canonical same-origin allowlisted paths with tests.
- [x] New failure codes have actionable user messages.
- [x] Targeted and full lint/typecheck/tests/build pass.
- [x] No out-of-scope file changed.
- [ ] YouTube imports are single-item, time/output/byte/duration bounded before
  storage, with deterministic kill/cleanup and focused tests.

## STOP conditions

Stop and report if:

- Safe DNS/redirect handling requires a new network dependency.
- The runtime cannot stream a Node `ReadStream` into the AWS SDK without a
  package/runtime change.
- Existing tests depend on fetching localhost/private fixtures; do not weaken
  production guards to satisfy them.
- Correctness requires a database migration or route response-shape change.
- A verification fails twice after one reasonable correction.

## Maintenance notes

- DNS resolution before native fetch closes the current direct/redirect SSRF
  paths but cannot cryptographically pin DNS between resolution and connection.
  If the deployment threat model requires rebinding-proof IP pinning, put
  outbound media behind an egress proxy that resolves and connects to the same
  approved address.
- Multipart expected-size persistence and abandoned-upload sweeping remain a
  separate migration plan.
