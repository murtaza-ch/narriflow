# Agent Tooling Setup (human checklist)

Local setup for the Claude Code + Codex workflow. Not agent instructions.

## Claude Code

- Target version `2.1.197+` for the full Fable 5 + Sonnet 5 workflow (Fable 5 needs `2.1.170+`, Opus 5 `2.1.154+`, Sonnet 5 `2.1.197+`).
- Project subagents live in `.claude/agents/`; project skills in `.claude/skills/`.

## Codex plugin

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

- Optional: `/codex:setup --enable-review-gate` adds a stop hook so Codex challenges Claude's output before finalizing.
- Requires the `codex` CLI installed and authenticated locally.

## Hygiene

- Do not commit personal plugin state, secrets, local paths, or machine-specific settings.

## Worker env flags

- `WORKER_SPLIT=0` disables the "split" (2-up) framing mode's per-output render path; clips using it fall back to whole-clip single-speaker framing (auto-reframe or a static center crop).
- `WORKER_SCREEN_LAYOUT=0` disables the "screen" (screen-share + facecam) framing mode's per-output render path the same way, falling back to whole-clip single-speaker framing.
- `WORKER_PIP_DETECT=0` disables element segmentation v1's facecam PiP detection within "screen" mode only (`pip_detect.py`); screen-mode clips fall back to the pre-existing whole-frame face-tracked/static-center bottom tile, same as before that packet landed.
- `WORKER_PIP_MOTION_THRESHOLD` (default `0.12`, clamped to `[0, 1]`) tunes `classifyScreencast`'s screencast-vs-regular-footage gate — a clip's `movingPxFrac` (share of analyzed pixels continuously moving frame-to-frame) below this is treated as screencast-like and eligible for PiP detection. Recalibrated (H1, adversarial review) through the SAME 360p CRF-30 ultrafast proxy production actually analyzes (`extractFaceDetectionSegment`), not the raw source files the original 0.25 default was measured against — proxy `movingPxFrac` measured 0.0000-0.0509 across the 7 synthetic screencast fixtures and 0.2726-0.5514 for the real talking-head control (`jensen-0-90.mp4`), a clean >5x separation; new default is the geometric mean of the two boundary values. Run `apps/worker/scripts/pip_calibrate.sh` to reproduce/re-validate against other footage — see `docs/plans/vizard-parity.md`'s landed note for the full table.
- All three default to enabled/the measured default (unset, or any value other than `"0"` for the two kill switches).
- `WORKER_LAYOUT_ENGINE=0` disables the speaker-aware auto-layout engine (`apps/worker/src/tasks/layout-engine.ts` — per-shot solo crops with vertical framing/zoom + stacked two-ups on multi-face shots, default-on for "auto" framing); clips revert to the legacy single-face EMA auto-reframe.
- `REFRAME_SCENE_THRESHOLD` (default `0.3`) tunes ffmpeg scene-change sensitivity for the layout engine's shot segmentation (lower = more cuts). Face-position-discontinuity cuts are derived independently of this and always active.

## Face-detection runtime (required for any face-tracked framing)

Auto-reframe, split, screen, and the layout engine all invoke `apps/worker/scripts/reframe_detect.py`, which needs OpenCV + the YuNet model. WITHOUT this setup every render silently-degrades to static center crops (now logged as `clip_face_detection_unavailable`). Local setup:

```bash
cd apps/worker
python3 -m venv .venv && .venv/bin/pip install opencv-python-headless numpy
mkdir -p models && curl -sL -o models/face_yunet.onnx \
  "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
```

Then in `apps/worker/.env` (absolute paths):

- `REFRAME_PYTHON=<repo>/apps/worker/.venv/bin/python` — interpreter the worker invokes for `reframe_detect.py`/`pip_detect.py` (defaults to bare `python3`, which usually lacks cv2).
- `REFRAME_MODEL_PATH=<repo>/apps/worker/models/face_yunet.onnx` (defaults to `/usr/local/share/narriflow/face_yunet.onnx`).

Both `.venv/` and `models/` are gitignored. Deployment images must bake the same (install cv2 + model, set both vars).

## Worker email notifications

- Set `WORKER_APP_BASE_URL` in `apps/worker/.env` to the public web-app origin used in project links (for example, `https://app.narriflow.com`). Production workers skip notification sends when this value is missing, invalid, or points to localhost.
- Set `RESEND_API_KEY` in `apps/worker/.env` to enable delivery through Resend. When unset, notifications are recorded as skipped.
- Set `NARRIFLOW_EMAIL_FROM` in `apps/worker/.env` to the verified sender identity (for example, `Narriflow <notifications@narriflow.com>`).
