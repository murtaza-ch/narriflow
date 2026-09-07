# 04 — Move Upload Session and ingest flows through policy

**What to build:** Move local upload, link ingest, RSS preview and import, Upload Session resume, transfer grants, finalization, status, and discard through Authenticated Request Policy. Users should keep the existing resumable Upload Session experience while authentication, `processing.consume`, rate limiting, strict input, typed domain failures, and temporary storage recovery become consistent with the rest of the app.

**Blocked by:** 03 — Recover Workspace and Project admission.

**Status:** done

- [x] Every upload and ingest entry declares its exact capability and receives unambiguous actor and Workspace scope.
- [x] Unauthenticated and forbidden requests perform no rate-limit, parse, storage, provider, or domain work.
- [x] Rate limits use actor or Workspace identity according to the operation and return a valid `Retry-After` value.
- [x] Malformed input and forged infrastructure or ownership fields are rejected before Upload Session or ingest work begins.
- [x] Existing Upload Session success responses, accepted states, transfer plans, idempotency, integrity, quota, compensation, and resume behavior remain unchanged.
- [x] Link and RSS intake preserve their existing source validation, plan-limit recovery, and Project handoff behavior.
- [x] Browser recovery consumes the shared authentication, authorization, rate-limit, missing, and unavailable classifications while retaining Upload Session-specific resume and integrity guidance.
- [x] A session or permission change during transfer preserves the durable browser resume record and never reports false completion.
- [x] Known Upload Session and ingest failures use typed codes and safe copy. Unexpected storage or provider details never reach the response.
- [x] Old direct actor checks, repeated validation responses, owner-based rate keys, and local common-error translation are removed from the migrated adapters.
- [x] Focused HTTP, Server Action, browser, Upload Session, and ingest tests prove the complete slice.
