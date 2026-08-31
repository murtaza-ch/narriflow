# Narriflow Business REST API v1

The Business REST API exposes stable, high-level workflow operations at
`https://<app-origin>/api/v1`. It uses the same services, entitlement checks,
workspace capabilities, rollout controls, immutable revisions, idempotency
rules, and provider configuration as the web application. It is not a bypass
around Review approval, generation usage, or Social Publication Attempt.

## Authentication and boundaries

Create a scoped key in **Settings → Developer access** and send it only in the
Authorization header:

```http
Authorization: Bearer nf_<secret>
Content-Type: application/json
```

Every key is bound to one Workspace. A path containing any other Workspace ID
is rejected. API access also requires that Workspace to be active on Business
and the key owner to retain the required Workspace capability. Downgraded,
pending-payment, restricted, removed, expired, and revoked access fails closed.

Requests are limited to 256 KiB and 300 requests per key per minute. A rate
limit response is `429` with `Retry-After: 60`. Responses use
`Cache-Control: no-store`.

## Scopes

| Scope | Public API use |
| --- | --- |
| `brand:read` | List and read Brand Profiles |
| `brand:write` | Reserved; no v1 Brand Profile mutation is public |
| `campaign:operate` | Read/preview Campaign Operations and apply high-level Brand Profile, style, Scene Template, or motion actions |
| `review:read` | Read sanitized Review Round status |
| `review:write` | Create an idempotent Review Round |
| `publishing:prepare` | Generate/read assisted copy, request/read thumbnail extraction, and bulk schedule |
| `generated-media:submit` | Submit and read generated-media jobs |

Existing project, usage, autopilot, and publishing scopes keep their documented
behavior. Grant only the scopes a client needs. A read operation still checks
`content.view`; a mutation checks the owning capability such as `content.edit`,
`review.manage`, or `publishing.manage`.

## Endpoint inventory

The base below is `/api/v1/workspaces/{workspaceId}`.

| Method and path | Scope | Idempotency |
| --- | --- | --- |
| `GET /brand-profiles` | `brand:read` | Read only; accepts `cursor`, `limit`, `query`, and `includeDeleted` query parameters |
| `GET /brand-profiles/{profileId}` | `brand:read` | Read only |
| `GET /projects/{projectId}/campaign-operations` | `campaign:operate` | Read only |
| `GET /projects/{projectId}/campaign-operations/editor-action-catalog` | `campaign:operate` | Read only; returns the frozen project brand and eligible styles/scenes without media URLs |
| `POST /projects/{projectId}/campaign-operations/preview-editor-action` | `campaign:operate` | Read-only preview; rejects raw editor patches and returns eligibility/revision outcomes |
| `POST /projects/{projectId}/campaign-operations/apply-brand-profile` | `campaign:operate` | Required UUID in `Idempotency-Key` header |
| `POST /projects/{projectId}/campaign-operations/apply-style` | `campaign:operate` | Required UUID in `Idempotency-Key` header |
| `POST /projects/{projectId}/campaign-operations/apply-motion` | `campaign:operate` | Required UUID in `Idempotency-Key` header |
| `POST /projects/{projectId}/brand-profiles/{profileId}/scene-templates/{templateId}/apply` | `campaign:operate` | Required UUID in `Idempotency-Key` header |
| `GET /projects/{projectId}/review-rounds` | `review:read` | Read only |
| `POST /projects/{projectId}/review-rounds` | `review:write` | Required UUID `idempotencyKey` in the body |
| `POST /projects/{projectId}/assisted-copy` | `publishing:prepare` | Required UUID `idempotencyKey` in the body |
| `GET /projects/{projectId}/assisted-copy/{draftId}` | `publishing:prepare` | Read only |
| `POST /projects/{projectId}/thumbnail-extractions` | `publishing:prepare` | Required UUID `idempotencyKey` in the body |
| `GET /projects/{projectId}/thumbnail-extractions/{jobId}` | `publishing:prepare` | Read only |
| `POST /projects/{projectId}/bulk-schedules` | `publishing:prepare` | Required UUID `idempotencyKey`; each item needs a unique, immutable `occurrenceIndex` (`0`-`99`) so retries preserve its original slot |
| `POST /projects/{projectId}/generated-media/jobs` | `generated-media:submit` | Required UUID `idempotencyKey` in the body; body `projectId` must match the path |
| `GET /projects/{projectId}/generated-media/jobs/{jobId}` | `generated-media:submit` | Read only |

Mutation responses are `202 Accepted` when a new durable request is admitted
and `200 OK` when the same request is replayed. Reusing an idempotency key with
different input is a conflict; create a new key only for a genuinely new
request. A lost HTTP response is not evidence that the operation failed.

Bulk scheduling through REST or MCP never accepts an approval-override reason.
Only an authenticated owner/admin browser action can record a Review approval
override; automation credentials must wait for approval.

## Examples

Apply one revision-fenced transition to selected clips:

```sh
curl --request POST \
  "https://app.example.com/api/v1/workspaces/$WORKSPACE_ID/projects/$PROJECT_ID/campaign-operations/apply-motion" \
  --header "Authorization: Bearer $NARRIFLOW_API_KEY" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: $IDEMPOTENCY_KEY" \
  --data '{
    "change": {
      "scope": "clip_transition",
      "transition": { "type": "cut", "durationSec": 0 }
    },
    "clips": [
      { "clipId": "00000000-0000-4000-8000-000000000000", "expectedEditorRevision": 4 }
    ]
  }'
```

Create a Review Round from exact immutable exports:

```json
{
  "idempotencyKey": "00000000-0000-4000-8000-000000000000",
  "title": "September campaign",
  "message": "Please review the selected cuts.",
  "passcode": "replace-with-a-private-passcode",
  "expiresAt": null,
  "allowDownloads": false,
  "approvalRequired": true,
  "recipientEmails": ["reviewer@example.com"],
  "sourceRoundId": null,
  "items": [
    {
      "clipId": "00000000-0000-4000-8000-000000000000",
      "exportId": "00000000-0000-4000-8000-000000000000",
      "expectedEditorRevision": 4,
      "variantIds": ["00000000-0000-4000-8000-000000000000"],
      "required": true
    }
  ]
}
```

The response intentionally omits the guest access token and passcode. Delivery
uses the round's encrypted recipients and durable Review Notifications.

Submit a generated still image:

```json
{
  "idempotencyKey": "00000000-0000-4000-8000-000000000000",
  "projectId": "00000000-0000-4000-8000-000000000000",
  "clipId": null,
  "kind": "image",
  "prompt": "A clean editorial product backdrop",
  "includeDerivedContext": false,
  "promptOrigin": { "kind": "manual", "sourceIds": [] },
  "aspectRatio": "1:1",
  "style": "minimal",
  "durationSec": null,
  "title": "Editorial backdrop"
}
```

The automation schema also understands the provider-neutral `video` kind, but
short video is not currently available: no approved production adapter has
passed the required provider and real-media gates. Clients must treat
`generated_media_not_configured` as unavailable, not retry around it.

## Safe responses and errors

Brand Profile responses omit signed asset and font URLs. Review status omits
guest tokens, passcodes, recipient identity, comments, and guest identity.
Generated-media status omits prompts, derived source text, provider payloads and
controls, storage keys, and signed URLs. Mutation logs contain only actor,
Workspace, project, operation, outcome, API-key ID, and durable resource ID.

Errors use a stable `error` code and a safe message. Common status classes are:

- `400` for invalid workflow input;
- `401` for an invalid or revoked key;
- `403` for a missing scope, Workspace boundary violation, capability failure,
  inactive Workspace, or Business-plan loss;
- `404` for an unknown route or owned resource;
- `409` for revision, stale-input, or idempotency conflict;
- `413` for a request over 256 KiB;
- `429` for the per-key request limit;
- `503` for a disabled rollout or missing provider/worker configuration.

Do not branch on message text. Do not send API keys, review secrets, passcodes,
reviewer email, prompts, or customer content to logs or support tickets.

## Rollout requirements

The API adds no bypass control. Its mutations depend on the same server values
as the web application:

- `NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS`
- `NARRIFLOW_WRITES_REVIEW_ROOMS` plus matching 32-character-or-longer
  `REVIEW_ACCESS_SECRET` and `REVIEW_SESSION_SECRET`
- `NARRIFLOW_WRITES_ASSISTED_COPY` plus `OPENAI_API_KEY` and
  `OPENAI_COPY_MODEL`
- `NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION`
- `NARRIFLOW_WRITES_BULK_SCHEDULING`
- `NARRIFLOW_WRITES_GENERATED_MEDIA`, the individual image control, and the
  configured image provider

See the [cutover runbook](../runbooks/vizard-expansion-cutover.md) before
enabling a mutation in production.

## Verification

```sh
bun test 'apps/web/app/api/v1/[[...route]]/business-api-http.test.ts'
bun test packages/services/src/business-automation.test.ts
bun test packages/services/src/business-automation-access.test.ts
bun run typecheck
bun run test:mcp:e2e
```

The final E2E command needs a running web app, a migrated database, and a real
least-privilege Business API key. Never put that key in the repository.
