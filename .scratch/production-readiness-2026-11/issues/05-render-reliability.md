# 05 Render reliability

**What to build:** Render failures are reported correctly and do not waste work. No change to any successful render's output.

**Blocked by:** None

**Status:** done

**Owner's hard rule:** do not change clip visuals. Do not edit FFmpeg encode args, filter graphs, `packages/composition-plan` decisions, detectors, layout, frame sampling or caption rendering. The owner will see a parity run. `render-golden` must stay exact.

Owns: `apps/media/src/render-output-validation.ts`, `apps/media/src/tasks/{clip-preview,export-bundle}.ts`, `apps/media/src/prepare-clip.ts`, `apps/media/src/render-group.ts`, `apps/media/modal_app.py`, `apps/media/python/narriflow_media/{control,entrypoint,render_runtime}.py`, `packages/services/src/clip-preparation-policy.ts`.

## Must fix
1. **Preview validation vetoes the whole render (high, reproduced).** `render-output-validation.ts:473-510`, applied by `tasks/clip-preview.ts:609-615,627-628`, `prepare-clip.ts:47`. Audio ending 60ms or more short, video ending before audio, or a 500ms audio timestamp hole fail preparation, which then fails every variant. Give previews a looser expectation: decodable, right codec and canvas, per-stream ends from source facts, skip audio gap and end-equality checks. Do not touch preview encode args. Add tests. Check whether the render validator has the same early-video problem; if it does, record it rather than loosening without evidence.
2. **`fail` is dropped after a local cancel, and `release` is never sent (medium).** `python/narriflow_media/control.py:395-396`, `entrypoint.py:102-116`, `render_runtime.py:63-66`, `process.py:176`. `native_source_changed` or `render_command_invalid` never reaches the API, so a permanent failure retries as `worker_stalled` and loses its code. Add a fenced report path that ignores local cancellation, and send `release` on shutdown.
3. **Fixed 120s preview deadline (medium).** `packages/services/src/clip-preparation-policy.ts:11,24`, `prepare-clip.ts:47`. Derive it with the same formula as `renderEncodeDeadlineMs`. It shifts the preparation engine hash once, which is fine.
4. **One 45-minute budget covers queueing, preparation, retries and encodes (medium).** `render-group-lifecycle.ts:649` (ticket 03 owns this file; coordinate by making a small edit), `clip-preparation.ts:239`, `modal_app.py:165-175`. Raise `prepare_clip` `max_containers` from 8 to match demand. Start the render budget when preparation completes if it is a small change; otherwise record it.
5. **One failed upload aborts sibling variants (low).** `render_runtime.py:63-67`, `render-group.ts:31`. Return a typed upload failure from the `upload` RPC so only that variant fails, as `clip-render-attempt.ts:4490-4492` already promises.
6. **Deploy client pin drift (low).** `apps/media/pyproject.toml:16` `modal==1.6.3`, `uv.lock:267,340` 1.2.6. Run `uv lock`.
7. **Bundles deflate MP4s (low).** `tasks/export-bundle.ts:21`. Use store mode for video entries; extracted bytes are unchanged.

## Reuse
- Remove the native path's full-download fallback: `clip-render-attempt.ts:1624-1735`, `render-config.ts:104`.
- Remove or wire up the unused transfer deadlines: `renderTransferSignal`, the watchdog, `renderStorageSignal`; the `render-group.ts:86-96` ports ignore `signal`.
- Fix stale comments in `tasks/clip-preview.ts:19-33`.

## Explicitly out of scope
Detector deadline, audio gap scan limit, `prepare_clip` thread policy, evidence reuse after caption edits, disk block cache. These touch frozen behaviour.

## Comments

**Done (2026-11-04).** No encode args, filter graphs, composition, detector, layout, sampling or caption code changed. `manifest.json` untouched.

1. **Preview veto: fixed.** New `previewStreamEnds` on `RenderOutputExpectation`, set only by `clipPreviewOutputExpectation` (which now takes the window). Previews keep container, codec, canvas, SAR, rate, color, audio format, full decode, video gap and header checks. Audio gaps, audio start and end-equality are skipped. Each stream must land within 0.5s of its source stream's end inside the window. When a header has no stream end (MKV), the longest stream must reach the window end. Audio that ended before the window may have no track, because FFmpeg writes none.
   - Claim correction: "60ms short" depends on frame rate. At 30 fps the tolerance is 54.7ms and packet rounding leaves 48ms, so it passed. At 60 fps (38ms) it failed. Tests use 60 fps.
   - Two extra vetoes found and fixed the same way: audio starting late, and audio ending before the window (was permanent).
   - Still failing by design: a window with no video at all (`output_video_stream_missing_or_extra`).
   - **Render validator, recorded and not loosened.** Real renders of the same sources: early video is rejected with `output_video_duration_mismatch`, a 500ms hole with `output_audio_timestamps_invalid`. Audio 60ms short passes because the render pads it. So those two source shapes now prepare and then fail each variant after encoding. Accepting or repairing them means changing the filter graph or the render contract, which is frozen. Owner decision.
2. **Dropped `fail`, no `release`: fixed.** `ExecutorSession.command` no longer applies the local cancel check to `fail` and `release`; the API fence decides. `invoke_native` sends `release` with reason `shutdown` on `CancelledError`, `KeyboardInterrupt` and `SystemExit`.
3. **Preview deadline: fixed.** `prepare-clip.ts` calls `renderEncodeDeadlineMs`. `timeoutMs` left the policy, version 5, engine hash shifts once. Peaks keep their 120s deadline.
4. **Budget: partly done.** `prepare_clip` `max_containers` 8 to 80. Starting the render budget at preparation completion is **not** a small change: `RenderGroup.operationDeadlineAt` is frozen at admission, a DB trigger makes it immutable within an epoch, every attempt and watchdog is checked against it, and `clip-export-handoff.db.test.ts` pins it to export creation + 45 minutes. It needs a migration, which only ticket 02 may add. `render-group-lifecycle.ts` not touched.
5. **Upload failure: fixed.** The `upload` RPC returns `{uploadFailed:true}` on `MultipartTransferError` while the session is live; `render-group.ts` throws retryable `render_upload_failed`, so only that variant fails. Lost authority stays fatal.
6. **Modal pin: fixed.** `uv lock`: modal 1.6.3, synchronicity 0.12.7, drops typer, annotated-doc, colorama, shellingham. Images do not read `uv.lock`.
7. **Bundles: fixed.** Files are stored; `manifest.json` stays deflated.

**Reuse.** Removed the full-download fallback, `sourceMode`, `WORKER_RENDER_SOURCE_MODE`, the `sourceSizeBytes` port, `renderTransferSignal`, `renderStorageSignal`, `transferDeadlineMs`, the watchdog and four `WORKER_TRANSFER_*` settings. The fallback read the same loopback server and upstream as the ranged path, so it could not help. Transport failures on the probe now return retryable `source_download_failed`, so they are not reported as `source_media_invalid`. Deadlines were removed, not wired up: Python owns transfers, with 60s per-part timeouts and session cancellation, and a TS abort cannot stop them. Fixed the stale preview comments, including the false claim that the HTTP args are harmless on a local path (FFmpeg refuses them).

Left for ticket 09: `ReservationRequest.kind` `"source"` now appears only in budget tests.

**Verification.**
- `apps/media` TypeScript: 825 pass, 1 skip, 0 fail, 63 files.
- `apps/media` Python: 205 tests, 2 skipped, 1 failure. `test_process` `test_unbounded_child_output_is_stopped_at_the_protocol_limit` hit its 3s timeout at load average 108, and passes 3/3 alone. An earlier partial run also failed `test_control` `test_a_running_renewal_loss_stops_the_actual_native_child` under load; it passes alone and passed in the full run. Neither file was changed.
- `apps/media` typecheck: clean for these files. One error in `packages/services/src/notification.service.ts`, another ticket's file.
- Biome clean on 14 touched files. Route inventory: 296 routes, 0 problems.
- New test coverage: `apps/media/src/preview-output-validation.test.ts` (13 tests), plus additions to `prepare-clip.test.ts`, `test_entrypoint.py`, `test_render_runtime.py` and `export-bundle-stream.test.ts`.
- Red first: only item 1, by a repro script on ffmpeg 7.1.5 before the fix. Other new tests were not run against the old code.
- Parity: not run here; the owner's 36-case comparison is still to come.

**Owner step.** Deploy API and media together: the engine hash, `prepare_clip` cap and modal client all change. Each clip prepares once more after deploy.
