"""Pinned native images and in-image runtime verification.

Domain functions and the signed spawn bridge use these images. Verification
functions have no secrets and perform no project or provider mutations.
"""

from __future__ import annotations

import json
from pathlib import Path

import modal

MEDIA_ROOT = Path(__file__).resolve().parent
REPO_ROOT = MEDIA_ROOT.parent.parent
app = modal.App("narriflow-media")


def image(profile: str) -> modal.Image:
    if profile not in {"lean", "render"}:
        raise ValueError("unknown_media_profile")
    return modal.Image.from_dockerfile(
        MEDIA_ROOT / "images" / "Dockerfile",
        build_args={"MEDIA_PROFILE": profile, "MEDIA_THREADS": "4" if profile == "render" else "2"},
        context_dir=REPO_ROOT,
        add_python=None,
        ignore=modal.FilePatternMatcher.from_file(MEDIA_ROOT / "images" / f"{profile}.dockerignore"),
    )


lean_image = image("lean")
render_image = image("render")

# One active input per container is Modal's default without @modal.concurrent.
# CPU requests are physical cores. Tuple limits bound both compute and memory.
LEAN_RESOURCES = dict(cpu=(2, 2), memory=(4096, 4096), ephemeral_disk=64 * 1024,
                      min_containers=0, buffer_containers=0, scaledown_window=2,
                      retries=0, startup_timeout=60)
RENDER_RESOURCES = dict(cpu=(4, 4), memory=(8192, 8192), ephemeral_disk=64 * 1024,
                        min_containers=0, buffer_containers=0, scaledown_window=2,
                        retries=0, startup_timeout=60)


def _verify(profile: str) -> dict:
    from narriflow_media.process import MediaProcessError, run_owned_process

    result = run_owned_process(
        ["bun", "/app/apps/media/scripts/check-render-environment.ts", "--enforce",
         "--stage", "start", "--json", "--profile", profile],
        timeout_seconds=240,
    )
    if result.returncode:
        raise MediaProcessError("media_runtime_unavailable", result.returncode)
    return json.loads(result.stdout)


@app.function(image=render_image, max_containers=1, timeout=300, **RENDER_RESOURCES)
def verify_render_runtime() -> dict:
    return _verify("render")


@app.function(image=lean_image, max_containers=1, timeout=300, **LEAN_RESOURCES)
def verify_lean_runtime() -> dict:
    return _verify("lean")
