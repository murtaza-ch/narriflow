# CSP reports

The web app ships a strict `Content-Security-Policy-Report-Only` policy next to
the enforced `frame-ancestors 'none'`. Browsers report what the strict policy
would have blocked to the API; nothing is blocked by it yet.

## Pipeline

- `apps/web/next.config.ts` adds `report-uri` and `report-to csp-endpoint` to the
  Report-Only policy and a `Reporting-Endpoints` header, both pointing at
  `${NEXT_PUBLIC_API_URL origin}/api/csp-report`.
- `POST /api/csp-report` (`apps/api/src/domains/platform/csp-report.ts`, declared
  in `platform/admission.ts` as `public_browser_report`) takes
  `application/csp-report` and `application/reports+json`, reads at most 64 KiB
  through `readBoundedBody`, spends a per-address `publicRead` budget, and always
  answers 204. `OPTIONS` answers the Reporting API preflight.
- Each violation becomes one `console.warn` line. The body, query strings and full
  URLs are never kept; nothing is written to the database.

```json
{"level":"warn","message":"csp_violation_reported","blockedHost":"cdn.example.com","directive":"script-src-elem","documentPath":"/projects/abc"}
```

`blockedHost` is the host of the blocked URL, or a CSP keyword (`inline`, `eval`,
`data`, `blob`) or `unknown`. `directive` is the effective directive.
`documentPath` is the page path without query or fragment.

## Reading them

Search Worker logs for `csp_violation_reported` over a representative window
(sign-in, upload with cloud pickers, project, Studio, billing, docs). Group by
`directive` and `blockedHost`:

1. A host that is part of the product (Clerk, R2, Google/Dropbox pickers, YouTube)
   belongs in the policy in `next.config.ts`.
2. `inline` and `eval` under `script-src` come from Next.js and Clerk; enforcing
   needs nonces first, which this change deliberately does not add.
3. Browser extensions produce one-off hosts and `documentPath` spread; ignore
   hosts seen on a single path.

Enforce only after a full window shows no product-owned `blockedHost`.

The production Clerk frontend host is added to the Report-Only allowlist when
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is a `pk_live_` key (it encodes the host).
