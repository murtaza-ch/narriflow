"""Pinned native images and in-image runtime verification.

Domain functions and the signed spawn bridge use these images. Verification
functions have no secrets and perform no project or provider mutations.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import time

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
executor_secret = modal.Secret.from_name("narriflow-executor-control", required_keys=["API_ORIGIN", "EXECUTOR_CONTROL_KEY_ID", "EXECUTOR_CONTROL_KEYS_JSON"])
bridge_secret = modal.Secret.from_name("narriflow-modal-bridge", required_keys=["MODAL_BRIDGE_KEYS_JSON"])
youtube_secret = modal.Secret.from_name("narriflow-youtube-proxy", required_keys=["YTDLP_PROXY_URL"])
dispatch_receipts = modal.Dict.from_name("narriflow-dispatch-receipts-v1", create_if_missing=True)

# One active input per container is Modal's default without @modal.concurrent.
# CPU requests are physical cores. Tuple limits bound both compute and memory.
LEAN_RESOURCES = dict(cpu=(2, 2), memory=(4096, 4096), ephemeral_disk=64 * 1024,
                      min_containers=0, buffer_containers=0, scaledown_window=2,
                      retries=0, startup_timeout=60)
RENDER_RESOURCES = dict(cpu=(4, 4), memory=(8192, 8192), ephemeral_disk=64 * 1024,
                        min_containers=0, buffer_containers=0, scaledown_window=2,
                        retries=0, startup_timeout=60)
# SDK 1.2.6 rejects an explicit retries option on ASGI endpoints, including 0.
BRIDGE_RESOURCES = {key: value for key, value in LEAN_RESOURCES.items() if key != "retries"}


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


@app.function(image=lean_image, secrets=[executor_secret], timeout=600,
              restrict_modal_access=True, **LEAN_RESOURCES)
async def asset_validation(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.native_runtime import run_asset_validation
    return await invoke_native(invocation, "asset_validation", client=native_client(os.environ),
                               operation=run_asset_validation, max_operation_seconds=600)


@app.function(image=lean_image, secrets=[executor_secret], timeout=120,
              restrict_modal_access=True, **LEAN_RESOURCES)
async def outbound_delivery(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.native_runtime import run_outbound_delivery
    return await invoke_native(invocation, "outbound_delivery", client=native_client(os.environ),
                               operation=run_outbound_delivery, max_operation_seconds=120)


@app.function(image=lean_image, secrets=[executor_secret, youtube_secret], timeout=2700,
              restrict_modal_access=True, **LEAN_RESOURCES)
async def fetch_source(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.source_runtime import run_fetch_source
    async def run(session, package, work):
        await run_fetch_source(session, package, work, mode="proxy", development=False,
            token_server_home=Path("/opt/youtube-tokens"), proxy_template=os.environ["YTDLP_PROXY_URL"])
    return await invoke_native(invocation, "fetch_source", client=native_client(os.environ),
                               operation=run, max_operation_seconds=2700)


@app.function(image=lean_image, secrets=[bridge_secret], timeout=30, **BRIDGE_RESOURCES)
@modal.asgi_app(label="narriflow-media-bridge")
def dispatch_bridge():
    from narriflow_media.bridge import BridgeAsgiApp, ModalBridge
    from narriflow_media.bridge_runtime import ModalBackend, ModalDictStore, parse_bridge_keys
    bridge = ModalBridge(store=ModalDictStore(dispatch_receipts),
        backend=ModalBackend(modal, {"asset_validation": asset_validation, "outbound_delivery": outbound_delivery, "fetch_source": fetch_source}),
        key_ring=parse_bridge_keys(os.environ["MODAL_BRIDGE_KEYS_JSON"]))
    return BridgeAsgiApp(bridge, time.time)
