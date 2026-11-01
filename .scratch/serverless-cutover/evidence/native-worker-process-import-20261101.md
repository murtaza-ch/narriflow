# Native worker-process test import diagnosis

The immutable render image `im-d5xx7dKzmLv7RGyPxUb41k`, built from
`b4b8426cd599c02f7d969b5a7df017ad494d1ea4`, cannot start
`apps/media/src/worker-process.test.ts`. Its full `@narriflow/services` import
loads Prisma, whose generated client is absent from the native
image. The existing `workflow-attempt-contract` export supplies both required
symbols without importing database code. Production `worker-process.ts` already
uses that export.

## Exact image reproduction

Two owned diagnostic Sandboxes used the existing image, 2 CPU, 4096 MiB, a
300-second lifetime, blocked network, no secrets, volumes or OIDC token, and
`/app` as the working directory. Only the diagnostic helper and source manifest
were staged under `/tmp`; baked source was untouched. The original test command
was run unchanged:

```text
bun --no-env-file test apps/media/src/worker-process.test.ts --timeout 30000 --reporter=junit --reporter-outfile=/work/prepare-resource/bun-2.xml
```

Both attempts exited 1 before test discovery completed. The second took 0.528 s
and reported 0 pass, 1 fail, 1 error:

```text
Cannot find module '.prisma/client/default' from '/app/node_modules/.bun/@prisma+client@7.7.0+b72de2e0f4816e28/node_modules/@prisma/client/default.js'
```

Bun emitted no JUnit file for this startup error. Separate stdout and stderr
were retained despite the failure. In the second Sandbox, read-only imports
from `/app/apps/media` isolated the cause:

| Import | Exit | Duration | Result |
| --- | --- | --- | --- |
| `@narriflow/services` | 1 | 0.326 s | Same missing Prisma client |
| `@narriflow/services/workflow-attempt-contract` | 0 | 0.017 s | Lease duration and attempt-loss class exported |

The first diagnostic's import probes used `/app` and failed package resolution;
they are retained as invalid probes and are not evidence for the import comparison.
The exact test command reproduced the Prisma failure in both Sandboxes.

Both source audits checked all 1,585 manifest files before and after execution,
with no missing or changed files. Both Sandboxes were terminated with
`terminate(wait=True)` and subsequently returned 137 from `poll()`:

- `sb-01M6AYRWN375PXQCPQR2R3Y67Z`
- `sb-01M6AYT11N6QEPYRQWQ1CBBXBN`

Private diagnostics, scripts, reports, raw logs and retirement proof are retained
in directories with mode 0700 and files with mode 0600:

- `/tmp/narriflow-worker-process-import-diagnostic-b4b8426c-20261101`
- `/tmp/narriflow-worker-process-import-diagnostic-repeat-b4b8426c-20261101`

## Change and verification

Only the test import changes to the existing contract export. The six selected
native Bun tests were inspected: prepare-clip, prepare-language-probe,
worker-process, direct-source, render-resource-budget and check-render-environment.
The worker-process test was their only services barrel import. Existing test
coverage exercises the failure, so no redundant import-only regression test was added.

In an isolated worktree based on the frozen source, the project-pinned macOS
Bun 1.3.6 passed all 71 worker-process tests in 2.91 s, with 356 assertions.
An earlier Bun 1.4.2 focused pass is retained as supplemental evidence only.
Media typechecking and repository lint passed; lint reported 11 existing
warnings and one informational diagnostic.

The full media test run requires the ignored face model. The initial clean
worktree lacked it. The existing cached model was verified against the lock's
SHA256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`
and copied to the ignored `apps/media/models/face_yunet.onnx` for the final run.
The initial Bun 1.4.2 full run recorded 800 pass, one skip and two failures from
the absent model. It is retained as a failed setup attempt, not a final gate.

The final full media command, `bun --no-env-file run test` in `apps/media`, used
the pinned Bun 1.3.6 directory first in `PATH`, including child processes. It
exited 0 with 802 pass, one skip, zero failures and 4,124 assertions across 803
tests in 60 files, taking 119.06 s. The skip is the existing optional occupied-port
token-server test, which requires `MEDIA_TEST_TOKEN_SERVER_HOME`.

Final host logs are `media-fast-bun-1.3.6.log`, `worker-process-bun-1.3.6.log`,
`media-typecheck.log` and `lint.log` in the second diagnostic directory.

The corrected source still needs a rebuilt immutable render image and the
complete pinned Linux qualification before cutover acceptance.
