# 02 — Establish the Authenticated Request Policy tracer

**What to build:** Introduce the single Authenticated Request Policy execution interface and prove it through one narrow slice that spans a Hono request, a Server Action, browser failure presentation, and real Workspace membership data. Project listing and folder operations should preserve their success behavior while sharing actor resolution, exact capability admission, validation order, typed failures, safe diagnostics, and recovery behavior.

**Blocked by:** 01 — Make actor and Workspace identity unambiguous.

**Status:** done

- [x] The module exposes one execution interface with explicit signed-in, Workspace-capability, and active-Project admission variants and no default capability.
- [x] The execution order is authentication, active Workspace, capability, optional rate limit, optional Project, input validation, and domain operation.
- [x] Ordinary execution resolves actor and Workspace at most once and never uses process-global authorization caching.
- [x] The typed failure taxonomy covers authentication, Workspace selection change, Workspace mismatch, capability denial, restriction, missing resource, invalid input, semantic refusal, quota or payment refusal, conflict, rate limiting, retryable unavailability, and unexpected failure handling.
- [x] Expected failures carry a stable code, user-safe message, bounded details, retry metadata when known, and a request identifier. Unexpected exceptions never expose their message to the browser.
- [x] The Hono adapter preserves existing successful status and response shapes while producing consistent error JSON and `Retry-After` when applicable.
- [x] The Server Action and page adapter returns expected failures as values or framework control flow and lets unexpected exceptions reach an error boundary.
- [x] The shared browser classifier preserves the current destination and submitted values and distinguishes sign-in, permission, restriction, missing, conflict, rate-limit, and retry recovery.
- [x] Project listing and folder operations use the new interface end to end and remove their old direct policy implementation.
- [x] Table tests prove admission decisions and call ordering through the public interface. Disposable PostgreSQL tests prove real membership and capability behavior.
- [x] The project glossary and an architecture decision record the module, interface, seam, adapters, error contract, and rejected alternatives.
