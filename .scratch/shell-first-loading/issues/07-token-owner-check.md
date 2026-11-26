# 07 - A request never goes out with another user's token

**What to build:** The transport sends a request only with a token issued to that request's user. A token Clerk already issued to someone else (another tab signed in as a different user, applied to the runtime scope one effect later) is refused as `scope_changed`, without a network call and without a failure callback.

**Blocked by:** None.

**Status:** done

Spec: [../spec.md](../spec.md). Files: `packages/api-client/src/core/{session-token,transport,index}.ts` (+ tests), `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-cloud-http.ts` (+ test).

## Behaviour

1. After obtaining the token and before sending, `attempt()` reads the token's `sub` and compares it with the request's target user. It covers the first attempt and the forced refresh after a 401.
2. A differing subject throws `scope_changed`, the error a Workspace move produces: never passed to `onAuthenticationFailed` / `onWorkspaceSelectionChanged`, and callers already treat it as superseded.
3. A token whose subject cannot be read (not a JWT) is sent unchecked.
4. Decoding is hand-written base64url → UTF-8: no `Buffer`, `atob` or `TextDecoder`, so it runs in browsers, Workers and React Native.

## Acceptance

- [x] A matching subject sends.
- [x] A differing subject is refused as `scope_changed` with no network call and no failure callback.
- [x] An unreadable token sends as before.
- [x] The 401 forced-refresh path is covered.
- [x] All existing api-client tests pass.

## Comments

2026-11-26 (implementer). Confirmed the runtime identity is Clerk's `userId`: `ApiProvider` calls `runtime.setIdentity(userId)` from `useAuth()`, and Clerk session tokens carry that user id as `sub` (for an impersonation token too: `sub` is the impersonated user, as is `useAuth().userId`). `sessionTokenClaims` / `sessionTokenSubject` live in `core/session-token.ts`, exported from `@narriflow/api-client/core`. They read without verifying, which is only good enough to refuse. The API still verifies every token.

Other token consumers: the progress socket gets its ticket through `transport.json`, so it is covered. Guest review sessions and REST API keys are not Clerk tokens. One consumer bypassed the transport: the Studio's close-time keepalive (`studio-cloud-http.ts`) sends a token captured by `createTokenSnapshot` from Clerk's live `getToken`. It compared only the runtime scope, so it could send B's token under A's scope. It now refuses a readable subject that is not the Studio's user. Its `tokenExpiryMs` uses the shared claims reader instead of its own `atob` decoder.

Verified: transport cases under "the token belongs to the request's user" (matching sends; another user's token refused as `scope_changed` for a scoped POST and an identity fetch with zero calls and no callbacks; `a.!!!.c` sent unchecked; a refreshed token after 401 for another user refused after one call with no callback; a same-user refresh replays). `session-token.test.ts`: base64url with multibyte claims, standard base64 with padding, and eleven unreadable shapes return null. Mutation: removing the check fails the two refusal cases. Studio: "never sends a token captured for another user". api-client 242 pass, web 1471 pass, typecheck, check:web-split and Biome on the touched files pass.

2026-11-26 (orchestrator, from Sol's review). The decoder now accepts unpadded or correctly padded input only (a run of extra `=` was stripped before) and builds its text inside the exception boundary, so an oversized segment is unreadable instead of throwing.
