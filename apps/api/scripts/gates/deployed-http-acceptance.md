# Deployed HTTP acceptance caller

Prepared only. This checkpoint makes no deployed requests and creates no account or database fixture.

The caller uses the configured production API routes. It has no gate endpoint, paid-work method, source URL, email recipient or publishing mutation. It requires explicit private files and exact identities; it does not use application dotenv files.

## Required operator inputs

- A mode-0600 JSON credential journal with `apiKey`, `sessionToken`, `workspaceId` and `projectId`. The session must be an existing live Clerk test session. The API key must be the already-issued key with `projects:read`, `exports:read`, `processing:write` and no `publishing:read`. The Workspace argument must match the journal. The explicit Project argument may name the new accepted MCP source Project; both first-party and REST reads must prove its live ownership.
- A mode-0600 JSON Worker settings file with `WEB_ORIGIN`, `ELEVENLABS_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET` and `CLERK_WEBHOOK_SECRET`. Only these settings are used, plus optional `ZOOM_WEBHOOK_SECRET_TOKEN`. If Zoom is included, its production integration configuration must also be valid. No provider HTTP API key is read by the caller.
- The explicit HTTPS API origin. Redirects are refused.
- One exact Workspace UUID that this actor cannot select, for the first-party scope refusal. No foreign Workspace is created by the caller.
- For positive Tasks coverage, an existing nonexpired MCP Task ID owned by this exact API-key caller, bound to the supplied Workspace/Project's accepted operation. Root must provide this fixture. The caller never creates product work to obtain a Task. The Task argument is required. Until Root supplies that actual accepted fixture, invocation remains pending; omission fails before HTTP. No missing-ID-only run can pass the gate.
- A new journal filename in a mode-0700 directory. The caller writes exact controlled Clerk and Stripe event IDs there before making requests. It refuses an existing filename to prevent overwriting cleanup identities.

Root owns admission, candidate deployment and invocation. Run only against its selected final deployed candidate, while the appropriate HTTP reads and protocol operations are admitted. An expired Clerk session is a refusal, never a reason to substitute another identity. This caller does not migrate, change admission, refresh credentials, issue keys or create fixtures.

```sh
node --experimental-strip-types apps/api/scripts/run-deployed-http-acceptance.ts \
  --credentials-file PRIVATE_AUTH_JOURNAL \
  --settings-file PRIVATE_WORKER_SETTINGS \
  --api-origin API_ORIGIN \
  --workspace-id OWNED_WORKSPACE_UUID \
  --project-id OWNED_PROJECT_UUID \
  --denied-workspace-id INACCESSIBLE_WORKSPACE_UUID \
  --task-id EXISTING_OWNED_TASK_UUID \
  --journal-file NEW_PRIVATE_EVENT_JOURNAL
```

Do not paste private file contents, authorization headers or socket addresses into logs. Standard output contains check names/counts and safe failure codes, phase and request index only. It never includes response bodies, credentials, tickets, event IDs or URLs.

## Scope of the deployed run

- Existing Clerk Bearer reads the exact first-party Project. An inaccessible selected Workspace refuses with 409; an API key cannot enter the first-party surface.
- The scoped API key reads that Project over REST and remains bound to its own Workspace when a foreign selection hint is sent. Its absent publishing scope refuses, and a Clerk session cannot enter REST.
- A fresh production progress ticket upgrades through Node `ws`, receives the exact Project's connected frame, and refuses ticket reuse and a foreign Origin. The caller closes its socket promptly.
- Modern 2026-07-28 and legacy 2025-11-25 MCP read catalogs, the exact Project and all four immutable Apps resources/CSP. Modern private tool results require zero TTL/private caching. Missing publishing scope refuses. Modern Tasks negotiates its extension and tests missing-ID isolation plus the supplied existing Task.
- Exact raw, whitespace-preserving unknown ElevenLabs, Stripe and Clerk events verify successfully. Reserialization under the original signature refuses. Stripe and Clerk exact event replay reuses the receipt. Clerk's unknown type cannot enter user or email handlers; Stripe's unknown type has no customer, subscription or Workspace metadata and cannot wake billing reconciliation. Configured Zoom verifies an unknown event and rejects tampering. With no Zoom secret, an unknown event must return exact 503/zoom_not_configured.

Progress ticket/nonce records and controlled webhook receipts are intentional protocol writes. Task inspection may settle its transport status projection. No source import, render, upload, paid provider, email or social publication is started. Root's real source/render pipeline proof remains separate.

After recording deployed results, Root may clean only the two `WebhookDeliveryLog` provider/event-ID pairs in the private journal. Do not delete by event-type prefix, time range or broad Workspace scan. The caller does no cleanup. The positive Task belongs to the accepted operation and is not deleted by this gate.

## Bounds and local verification

The caller permits at most 64 HTTP requests, 15 seconds per HTTP request and 180 seconds overall. Responses are capped at 2 MiB; progress frames at 64 KiB/512 frames and a 12-second observation. RPC and provider names are fixed. No retry starts a different identity.

```sh
cd apps/api
node --experimental-strip-types --test scripts/gates/deployed-http-acceptance.test.ts
```

The six local tests use fixture-only fetch responses with real HMAC calculations and a loopback Node WebSocket server. They prove caller framing, redaction, refusal handling and bounds. They do not prove deployed authentication, domain SQL, provider consoles or product processing. The prepared checkpoint has no deployed acceptance result.
