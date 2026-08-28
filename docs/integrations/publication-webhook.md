# Publication webhook receiver contract

When `SOCIAL_PUBLISH_WEBHOOK_URL` is configured, Narriflow sends the frozen publication intent to that HTTPS endpoint. A local `http://localhost` endpoint is allowed only for development. Redirects are rejected.

## Publish request

Narriflow sends `POST` with `Content-Type: application/json`, `Idempotency-Key: <attempt idempotency key>`, `X-Narriflow-Attempt-Id: <attempt UUID>`, and `X-Narriflow-Signature: sha256=<hex HMAC-SHA256>`. The HMAC is computed over the exact request bytes with `SOCIAL_PUBLISH_WEBHOOK_SECRET`. Verify the signature before parsing or acting.

The body contains the attempt and Social Post IDs, idempotency key, project ID, platform, frozen caption/settings/schedule, and a short-lived scoped media URL with content type, byte length, file name, aspect ratio, and expiry. It never contains a private storage key or native social credentials.

The receiver must durably claim `Idempotency-Key` before initiating provider work. Repeated requests with the same key must return the same operation and receipt. The receiver must reject the same key with different intended content.

## Required response envelope

Every 2xx response must be one of:

- `{"status":"accepted","receipt":{"id":"...","externalPostId":"...","externalUrl":"..."}}`
- `{"status":"pending","receipt":{"id":"..."},"nextCheckAfterSeconds":30,"reconciliation":{"url":"https://...","token":"..."}}`
- `{"status":"failed","code":"...","disposition":"safe_retry|permanent|attention"}`

Bare 2xx, malformed JSON, missing receipt identity, conflicting receipt evidence, redirects, oversized responses, and connection loss after request commitment are unknown outcomes—not success and not a safe retry.

For pending work, Narriflow later sends authenticated `GET` to the returned reconciliation URL. The response uses the same envelope and receipt identity. The URL and token are encrypted in Narriflow’s checkpoint store and excluded from logs. `nextCheckAfterSeconds` and `Retry-After` are bounded by Narriflow configuration; a receiver cannot extend the processing deadline or provider-call budget.

Before request commitment, transport failure may be classified as a safe retry. After headers/body may have reached the receiver, failure must return the same idempotent operation on replay or remain unknown. Receivers should test duplicate concurrent delivery, lost responses, delayed processing, out-of-order reconciliation, conflicting receipt attempts, invalid signatures, redirects, response limits, and timeouts.
