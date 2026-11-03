# 25 - Fix local progress ticket issuance

**What to build:** Local development can issue a valid progress ticket and connect to the shared cloud progress socket.

**Blocked by:** None.

**Status:** done

**Spec:** [Serverless cutover, authorized progress](../spec.md#49-live-progress-over-durable-objects).

The owner reported `POST /api/projects/:projectId/progress-ticket` returning 500 locally. Reproduction confirmed invalid dotenv escaping in five JSON settings. A second reproduction found that localhost tickets carried the local audience while their WebSocket terminates on the shared cloud Worker.

- Preserve literal settings across Bun and Wrangler without variable expansion or exposing credentials.
- Reject malformed JSON settings in `env:check` before startup.
- Keep local request authorization, then obtain the ticket from the shared development Worker using its configured audience and the original authorization timestamp.
- Retain Origin, scope, nonce, epoch fencing and connection lifetime rules.
- Verify the original project ticket request and real local WebSocket connection, plus regression tests using real loaders and service RPC.

## Evidence

Initial local HTTP reproduction returned 500; the same deployed endpoint returned 200. The loader regression reproduced escaped keyring quotes. After settings repair the local endpoint returned 200. The socket reproduction then returned 500 locally, while a bounded cloud trace showed the proxied ticket was refused with 401. The direct deployed connection returned 101 and the correct project's `connected` frame.

The next socket failure was isolated to middleware modifying immutable remote response headers. A two-Worker workerd regression reproduced the exact 500, then passed after the proxy copied the response while retaining its WebSocket. It also verifies that replay, invalid-ticket and wrong-Origin refusals keep their original statuses.

The owner's exact Project now returns HTTP 200 for its ticket and receives the correct Project's connected frame over a 101 WebSocket through localhost:4000. A fresh invocation of the repaired launcher on port4001 passed the same check. The local loader and service-binding regressions are included in the local test and pre-push commands. Signing key material, database selection and scheduler selection were retained. Reviews found one parser edge, which was corrected and retested; both reviews are clear.
