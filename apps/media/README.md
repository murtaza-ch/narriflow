# Native media execution

The TypeScript renderer, FFmpeg compiler, caption code, normalized probe, process owner, layout analysis, preview graphs, audio extraction, dub mux and export archive builder live here. Composition and caption policy still come from the shared packages.

`tasks/clip-render-attempt-runtime.ts` requires domain reads, fenced writes, scoped storage and stock-media resolution as ports. Its native defaults contain no database, Redis, queue claim or parent-settlement implementation. `executeRenderGroup` consumes one already acquired group. The signed executor-control adapter supplies these ports.

Both Modal images use `runtime-lock.json` and the same Dockerfile. The render profile includes detector wheels, the pinned model and caption fonts. The lean profile omits those payloads. Python stays at 3.13.5; Modal must not inject a different interpreter. The tested deployment SDK is `modal==1.2.6`.

The Python process supervisor bounds input and output, propagates cancellation, kills detached native descendants, and strips PostgreSQL credentials from child environments. Its lifetime pipe also stops media if the calling Python wrapper is killed. Linux subreaping handles descendants whose Bun parent has already exited.

## Local verification

```sh
bun run --cwd apps/media typecheck
bun test apps/media/src apps/media/scripts
PYTHONPATH=apps/media/python uv run --project apps/media --frozen python -m unittest discover -s apps/media/python/tests -v
```

Native tests require FFmpeg, fontconfig and the model at `apps/media/models/face_yunet.onnx`. Download only the immutable source recorded in `runtime-lock.json` and verify its SHA-256. Model bytes are ignored locally and are baked into the render image from that same pin. Golden fixture documents, evidence, expectations and source pins are unchanged by the move.

`probe-cli.ts` reads one bounded JSON object from stdin with an absolute local `sourcePath`, then emits the existing normalized probe. Python acquisition uses this CLI instead of parsing ffprobe independently.

`fetch_source` resolves one immutable upstream identity and starts audio and full-video downloads concurrently. Its injected sink receives verified audio first. A later provider block can rotate the pending video through at most three fresh sticky sessions; committed audio is retained. The native adapter uses pinned yt-dlp plugins, Deno and isolated configuration. A configured token-server home creates an owned helper on a private loopback port for each sticky session. Its startup marker and owner-bearing readiness file prevent borrowing another listener, and teardown waits for the native process owner. Scoped upload/control wiring is still being integrated.

`ExecutionControlClient` accepts an explicit HTTPS API origin and signing key, then sends bounded signed commands. Transport retries retain the exact body, timestamp and delivery ID. `ExecutorSession.acquire` requires an acquired disposition for a new random owner and rejects an expired receipt against the fresh TLS server-time header. Pass its `on_process_start` and `cancel_event` to the native process owner. It acknowledges one actual native start, renews only running work every 30 seconds, and cancels native work on authority loss or the absolute deadline. This client does not yet supply the Modal bridge, immutable work-package reads or multipart grants.

`multipart.py` uploads every executor file through UploadPart grants, including small files. It also pins large objects using conditional ranged GETs with the original ETag on every request. The API creates/completes the upload and verifies target HEAD. Native transfer keeps at most four 16 MiB part buffers, binds each part to its measured Content-MD5 and retains separate SHA-256 facts, hashes the ordered whole object, checks file immutability and cancels siblings on failure. A lost completion acknowledgement never triggers abort or deletion. Its injected control ports still need live API wiring. The fixed Content-MD5 transport passes a real 17 MiB R2 gate, including rejection of altered bytes and prevention of overwrite after completion. Real 10 GiB and greater-than-5-GiB pin gates remain open.

## Image verification

`modal_app.py` registers `verify_render_runtime` and `verify_lean_runtime`. They verify the actual image and return its fingerprint. They carry no domain/provider secrets. Both scale to zero and have one verification container as their cap. Production functions must also use atomic executor acquisition, because Modal can reschedule crashed containers even when function retries are zero.

```sh
uv run --project apps/media --extra deploy modal run apps/media/modal_app.py::verify_render_runtime
uv run --project apps/media --extra deploy modal run apps/media/modal_app.py::verify_lean_runtime
```

These commands require authenticated Modal access. Image verification and Linux golden/crash gates must pass before the cutover; local macOS parity does not establish Linux parity.
