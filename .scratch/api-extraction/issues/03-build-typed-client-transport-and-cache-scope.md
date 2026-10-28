# 03. Build typed client transport and cache scope

**What to build:** First-party requests use injected Bearer transport, typed ApiError and identity/Workspace-scoped React Query state without Clerk/Next in api-client.

**Blocked by:** [02 - Build HTTP admission and staff guard](02-build-http-admission-and-staff-guard.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:

- `bun.lock`

New files/directories or reserved skeletons handed off by a blocker:

- `packages/api-client/package.json`
- `packages/api-client/tsconfig.json`
- `packages/api-client/tsconfig.build.json`
- `packages/api-client/src/core/**`
- `packages/api-client/src/index.ts`
- `apps/web/app/_components/api-provider.tsx`

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

No direct UI/domain rows. This ticket supplies the shared contracts or final gates described above.

## Acceptance criteria

- [ ] Transport captures identity+Workspace, omits cookies, obtains a current token, propagates AbortSignal and rejects stale-scope responses.
- [ ] ApiError.code maps error field; safe status/details/requestId retained; at most one forced token refresh with the same intent key/body.
- [ ] QueryClient defaults, retry decisions, canonical filter keys and scope switch/sign-out cancellation match spec; tokens/grants are not persisted.
- [ ] Reusable mutation form/recovery interfaces and stable provider contracts are documented for UI owners; api-client imports no Clerk/Next/runtime API value.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun test packages/api-client/src/core
```

## Comments

Append claim, requested seam changes, paired review and evidence here.
