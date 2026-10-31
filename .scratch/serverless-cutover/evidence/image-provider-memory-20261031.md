# Image-provider memory probe — 2026-10-31

The current buffered image provider is not cleared for edge memory safety. Local workerd returned 200 for every tested output size, including 100,000,000 bytes, where used JavaScript heap alone was 264.87 MiB. Cloudflare documents a 128 MB per-isolate edge limit shared by concurrent requests. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

The probe runs the exact provider adapter, with synthetic fixed-origin HTTP responses streamed from a local fixture. It makes no external provider request, uses no account credentials or database, and changes no configured cap. Each size starts a fresh local worker. The inspector verifies an in-script marker in the selected execution context before reading that isolate's heap. Runtime was workerd 2026-10-23 through pinned Wrangler 4.156.0, compatibility date 2026-10-30.

| Decoded output bytes | Local HTTP | Used JS heap MiB | Backing storage MiB | Sampled process RSS MiB |
| ---: | ---: | ---: | ---: | ---: |
| 1,000,000 | 200 | 14.44 | 5.12 | 208.80 |
| 4,000,000 | 200 | 21.73 | 13.37 | 233.22 |
| 8,000,000 | 200 | 32.95 | 26.09 | 266.84 |
| 12,000,000 | 200 | 44.16 | 38.80 | 294.25 |
| 16,000,000 | 200 | 55.40 | 51.52 | 329.78 |
| 20,971,520 | 200 | 69.34 | 67.32 | 370.17 |
| 32,000,000 | 200 | 100.27 | 102.38 | 462.70 |
| 50,000,000 | 200 | 139.59 | 223.29 | 599.55 |
| 75,000,000 | 200 | 204.88 | 334.60 | 782.81 |
| 100,000,000 | 200 | 264.87 | 445.78 | 967.34 |

At the default 20 MiB output, the inspector reports69.34 MiB JavaScript heap,67.32 MiB backing storage, and 2.95 MiB embedder heap. Those fields are reported separately; their arithmetic sum is 139.62 MiB. CDP defines backing storage as array-buffer/external-string storage, and reports heap for the corresponding isolate. [Primary protocol definition](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/js_protocol.pdl).

These post-decode heap samples are not exact transient peaks. Process RSS includes the whole local workerd process and must not be presented as isolate memory or billing usage. Local successful responses above the documented edge limit demonstrate why local success cannot certify this deployment limit. No edge probe was deployed in this slice.

The smallest sound fix is a bounded native generated-image execution that performs the known-provider request, base64 decoding, pixel validation, and assigned output upload together. Workers keep reference-only commands and the existing atomic parent/usage settlement. A new streaming JSON/base64 parser in the Worker would add protocol machinery and still need careful concurrent-isolate memory testing. The configured caps remain unchanged.

Reproduce from the repository root:

```sh
node --experimental-strip-types apps/api/scripts/run-image-provider-memory-probe.ts
```

Set PROBE_SIZES to a comma-separated subset of decoded byte sizes and PROBE_OUTPUT to a local JSON path. Inputs are bounded to 1,000,000–100,000,000 bytes. [Raw measurements](image-provider-memory-20261031.json).
