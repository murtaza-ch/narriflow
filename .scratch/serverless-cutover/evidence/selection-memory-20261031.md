# Selection memory measurement, 2026-10-31

The representative three-hour workload can keep its shared capsule pending the deployed gate. Local measurements alone do not certify Cloudflare's per-isolate limit. Cloudflare documents 128 MB shared by concurrent requests in one isolate. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

The synthetic input contains 960 utterances and 28,800 timed words, producing six half-hour windows and a 2,761,506-byte private capsule. The probe runs the real selection controller, Responses serialization and bounded S3 storage adapter against a loopback fixture. Database authority ports are synthetic. The complete selection runtime import graph remains loaded, and the inspector verifies this exact isolate's marker. Runtime was workerd 2026-10-23, compatibility date 2026-10-30. No provider account, database or edge deployment is used by this local probe.

| Concurrent windows | Sampled used heap + backing + embedder MiB | Sampled allocated heap + backing + embedder MiB | Held after forced GC MiB |
| ---: | ---: | ---: | ---: |
| 1 | 44.74 | 66.44 | 25.74 |
| 2 | 56.83 | 82.17 | 32.58 |
| 4 | 73.54 | 117.73 | 45.85 |
| 6 | 87.28 | 135.80 | 59.08 |

These are arithmetic combinations of separate CDP fields, not an official Cloudflare memory counter. `usedSize` measures used JavaScript heap; `totalSize` includes allocated heap; backing storage covers array buffers and external strings. Allocated heap can contain unused space. [Primary CDP protocol](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/js_protocol.pdl).

Samples run approximately every 25 ms and cannot capture every transient peak. The provider remains pending while every tested window is active. Forced garbage collection delays release, yielding measured holds of 9.59–9.93 seconds. Local successful responses above a documented deployment limit must not be treated as deployment clearance. The four-window allocated arithmetic approaches the edge limit, and the six-window value exceeds it, so the fixed deployed gate and an explicit launch cap remain required.

The investigation also exposed an allocation issue independent of the sampled steady state: denied capacity waiters used to fetch and parse their full capsule before admission. Acquisition now reserves an uncharged permit before private input I/O. Denied waiters read only database metadata, and full source-content proof runs only for an available permit holder. Real PostgreSQL tests verify zero input reads for a denied waiter, zero paid charge before fresh start, source supersession revocation and lease rechecks after account-lock waits. Twenty selection tests pass with 159 assertions.

The deployed gate executes six windows within one invocation, uses an injected real private storage adapter and a synthetic ten-second provider wait, and removes all seven fixture objects. A separate fixed Hyperdrive gate verifies the actual three-hour/six-window/thirty-Clip global finalization and replay. Its local disposable-schema guard/cleanup case passes, including zero leftover dispatches. Deployed outcomes are recorded separately by the integration owner. Neither gate sends a paid provider request.

Reproduce the local matrix from the repository root:

```sh
node --experimental-strip-types apps/api/scripts/run-selection-memory-probe.ts
```

`PROBE_CONCURRENCY` selects a subset of `1,2,4,6`; `PROBE_OUTPUT` selects the JSON output path. [Raw samples](selection-memory-20261031.json).
