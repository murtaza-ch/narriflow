# Native media execution

The TypeScript renderer, FFmpeg compiler, caption code, normalized probe, process owner, layout analysis, preview graphs, audio extraction, dub mux and export archive builder live here. Composition and caption policy still come from the shared packages.

`tasks/clip-render-attempt-runtime.ts` requires domain reads, fenced writes, scoped storage and stock-media resolution as ports. Its native defaults contain no database, Redis, queue claim or parent-settlement implementation. `executeRenderGroup` consumes one already acquired group. The signed executor-control adapter supplies these ports.

Both Modal images use `runtime-lock.json` and the same Dockerfile. The render profile includes detector wheels, the pinned model and caption fonts. The lean profile omits those payloads. Python stays at 3.13.5; Modal must not inject a different interpreter. The deployment SDK is pinned to `modal==1.6.3`, which supports the account's `2026.10` image builder.

The Python process supervisor bounds input and output, propagates cancellation, kills detached native descendants, and strips PostgreSQL credentials from child environments. Its lifetime pipe also stops media if the calling Python wrapper is killed. Fetch commands also inherit an OS file-size limit of 10 GiB, so unknown-length HTTP and fragment writers cannot exceed the product cap before the final file check. Linux subreaping handles descendants whose Bun parent has already exited.

## Local verification

```sh
bun run --cwd apps/media typecheck
bun test apps/media/src apps/media/scripts
PYTHONPATH=apps/media/python uv run --project apps/media --frozen python -m unittest discover -s apps/media/python/tests -v
```

Native tests require FFmpeg, fontconfig and the model at `apps/media/models/face_yunet.onnx`. Download only the immutable source recorded in `runtime-lock.json` and verify its SHA-256. Model bytes are ignored locally and are baked into the render image from that same pin. Golden fixture documents, evidence, expectations and source pins are unchanged by the move.

`probe-cli.ts` reads one bounded JSON object from stdin with an absolute local `sourcePath`, then emits the existing normalized probe. Python acquisition uses this CLI instead of parsing ffprobe independently.

`fetch_source` resolves one immutable upstream identity and starts audio and full-video downloads concurrently. Its injected sink receives verified audio first. A later provider block can rotate the pending video through at most three fresh sticky sessions; committed audio is retained. The native adapter uses pinned yt-dlp plugins, Deno and isolated configuration. A configured token-server home creates an owned helper on a private loopback port for each sticky session. Its startup marker and owner-bearing readiness file prevent borrowing another listener, and teardown waits for the native process owner. A verified existing SourceAudio binding can seed a retry through `ExistingSourceAudio`; the coordinator then downloads only video and never invokes the audio sink again. It checks the current Project, revision, upstream identity and newly selected track. The work-package wrapper must provide that sealed binding and omit a new source_audio destination. Scoped upload/control wiring is still being integrated.

`ExecutionControlClient` accepts an explicit HTTPS API origin and signing key, then sends bounded signed commands. Transport retries retain the exact body, timestamp and delivery ID. `ExecutorSession.acquire` requires an acquired disposition for a new random owner and rejects an expired receipt against the fresh TLS server-time header. Pass its `on_process_start` and `cancel_event` to the native process owner. It acknowledges one actual native start, renews only running work every 30 seconds, and cancels native work on authority loss or the absolute deadline. This client does not yet supply the Modal bridge, immutable work-package reads or multipart grants.

`multipart.py` uploads every executor file through UploadPart grants, including small files. It also pins large objects using conditional ranged GETs with the original ETag on every request. The API creates/completes the upload and verifies target HEAD. Native transfer keeps at most four 16 MiB part buffers, binds each part to its measured Content-MD5 and retains separate SHA-256 facts, hashes the ordered whole object, checks file immutability and cancels siblings on failure. A lost completion acknowledgement never triggers abort or deletion. Its injected control ports still need live API wiring. The fixed Content-MD5 transport passes a real 17 MiB R2 gate, including rejection of altered bytes and prevention of overwrite after completion. Real 10 GiB and greater-than-5-GiB pin gates remain open.

## Image verification

`modal_app.py` registers `verify_render_runtime` and `verify_lean_runtime`. They verify the actual image and return its fingerprint. They carry no domain/provider secrets. Both scale to zero and have one verification container as their cap. Production functions must also use atomic executor acquisition, because Modal can reschedule crashed containers even when function retries are zero.

```sh
uv run --project apps/media --extra deploy modal run apps/media/modal_app.py::verify_render_runtime
uv run --project apps/media --extra deploy modal run apps/media/modal_app.py::verify_lean_runtime
```

These commands require authenticated Modal access. Image verification and Linux golden/crash gates must pass before the cutover; local macOS parity does not establish Linux parity.

The reference-only Modal bridge is split into `narriflow_media.bridge` and the SDK adapters in `bridge_runtime`. Raw-body HMAC verification precedes any durable lookup. Immutable transport intent rejects changed content for a delivery ID before spawn. A durable receipt replays the recorded call ID; a bounded 30-second transport slot permits recovery when a bridge crashes or loses the spawn acknowledgement. Duplicate heavy calls still have to acquire one executor owner through the API before starting native work. Status reads platform call metadata, and cancellation only targets a call bound to the recorded invocation. These facts never settle a domain operation.

The implementation follows Modal's [web spawn example](https://github.com/modal-labs/modal-examples/blob/main/09_job_queues/doc_ocr_webapp.py) and its [durable Dict API](https://modal.com/docs/sdk/py/latest/Dict), using the pinned SDK's atomic `put(skip_if_exists=True)`. Transport records are content-free primitive dictionaries. They expire after seven days of inactivity. Native handlers and the deployed ASGI endpoint remain integration gates; the pure bridge tests are not a live Modal deployment.

## Development YouTube fetch

The development Workspace must be explicitly listed in `LOCAL_FETCH_WORKSPACE_IDS_JSON`, with `APP_ENV=development` and `YOUTUBE_FETCH_MODE=local`. Configure the distinct `DEV_DEVICE_KEY_ID`/`DEV_DEVICE_KEYS_JSON` ring on the Worker; never give that ring to the laptop.

On Upload, create a development fetch session. The downloaded JSON grants only that Workspace/actor/epoch for two hours and replaces the previous device. Start the outbound agent with:

```sh
bun run fetch:local --session ~/Downloads/narriflow-local-fetch-device.json
```

The agent restricts the file to mode600, opens an outbound WebSocket, and starts at most two native invocations. The default command uses the locked lean Linux image on the Mac's Docker network, with2CPU/4GiB per invocation and no database or provider credential. Build that image with the same `apps/media/images/Dockerfile`, lean profile and2threads, tagging it `narriflow-media:local-fetch`. A development runtime can supply an explicit argv array using `--native-command-json`; no shell evaluates it. The API's `MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT` must equal that image's verified lean fingerprint.

Keepalives use Durable Object hibernation and make no PostgreSQL requests. Each connection performs one paged reconciliation; there is no SQL polling loop. Losing the connection stops native process groups. Database owner/lease checks fence stale commits independently. Offline development devices refuse new YouTube imports and keep upload available. Production rejects device routing; proxy admission requires a recorded acceptance check through `YOUTUBE_PROXY_ACCEPTED=true`.
