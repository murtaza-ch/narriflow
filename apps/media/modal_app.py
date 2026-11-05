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
app = modal.App("narriflow-media-dev")


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
executor_secret = modal.Secret.from_name("narriflow-dev-executor-control", required_keys=["API_ORIGIN", "EXECUTOR_CONTROL_KEY_ID", "EXECUTOR_CONTROL_KEYS_JSON"])
bridge_secret = modal.Secret.from_name("narriflow-dev-modal-bridge", required_keys=["MODAL_BRIDGE_KEYS_JSON"])
youtube_secret = modal.Secret.from_name("narriflow-dev-youtube-fetch", required_keys=["YOUTUBE_FETCH_MODE"])
image_secret = modal.Secret.from_name("narriflow-dev-image-generation", required_keys=["OPENAI_API_KEY"])
dubbing_secret = modal.Secret.from_name("narriflow-dev-dubbing", required_keys=["OPENAI_API_KEY"])
dispatch_receipts = modal.Dict.from_name("narriflow-dev-dispatch-receipts-v1", create_if_missing=True)

# One active input per container is Modal's default without @modal.concurrent.
# CPU requests are physical cores. Tuple limits bound both compute and memory.
LEAN_RESOURCES = dict(cpu=(2, 2), memory=(4096, 4096),
                      min_containers=0, buffer_containers=0, scaledown_window=2,
                      retries=0, startup_timeout=60)
RENDER_RESOURCES = dict(cpu=(4, 4), memory=(8192, 8192),
                        min_containers=0, buffer_containers=0, scaledown_window=2,
                        retries=0, startup_timeout=60)
# The default ephemeral quota is already 512 GiB. Requesting disk explicitly
# increases the billed memory request and is unnecessary for bounded scratch.
# ASGI endpoints reject an explicit retries option, including 0.
# The bridge only awaits Modal's API, so one container serves a burst of spawns.
# Staying up for a minute keeps a burst off cold starts and the Worker's 15s timeout.
BRIDGE_RESOURCES = {**{key: value for key, value in LEAN_RESOURCES.items() if key != "retries"},
                    "scaledown_window": 60}
BRIDGE_MAX_INPUTS = 64


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


@app.function(image=lean_image, max_containers=1, timeout=300, **LEAN_RESOURCES)
def verify_generated_image_resources() -> dict:
    """Synthetic loopback resource gate; no provider or domain credentials."""
    from narriflow_media.process import MediaProcessError, run_owned_process
    result = run_owned_process(["bun", "/app/apps/media/scripts/gates/generated-image-memory-gate.ts"], timeout_seconds=280)
    if result.returncode:
        raise MediaProcessError("generated_image_resource_gate_failed", result.returncode)
    return json.loads(result.stdout)


@app.function(image=render_image, max_containers=1, timeout=900,
              restrict_modal_access=True, **RENDER_RESOURCES)
async def verify_render_native_fixture() -> dict:
    """Real Function/process gate with synthetic control and storage ports."""
    import sys
    sys.path.insert(0, "/app/apps/media/python/tests")
    from test_render_runtime import RenderRuntimeTests
    fingerprint = _verify("render")["id"]
    case = RenderRuntimeTests("test_actual_renderer_uploads_measured_bytes_then_waits_for_real_final_ack")
    success = await case.actual_operation(fingerprint=fingerprint, enforce_runtime=True)
    failure = await case.actual_operation(fingerprint=fingerprint, enforce_runtime=True, source_mismatch=True)
    await case.actual_operation(fingerprint=fingerprint, enforce_runtime=True, lost_ack=True)
    return {"profile": "render", "toolchainFingerprint": fingerprint, "success": success,
            "permanentFailure": failure, "lostAcknowledgementRetained": True, "providerRequests": 0, "databaseRequests": 0}


@app.function(image=lean_image, max_containers=1, timeout=900,
              restrict_modal_access=True, **LEAN_RESOURCES)
async def verify_dubbing_bundle_native_fixture() -> dict:
    """Credential-free Function gate. Provider HTTP stays on owned loopback."""
    import sys
    sys.path.insert(0, "/app/apps/media/python/tests")
    from test_dubbing_runtime import DubbingRuntimeTests
    from test_export_bundle_runtime import ExportBundleRuntimeTests
    fingerprint = _verify("lean")["id"]
    dub = DubbingRuntimeTests("test_actual_child_commits_ordered_paid_stages_and_real_mux_then_recovery_posts_nothing")
    dubbing = [await dub.operation(mode, fingerprint=fingerprint, enforce_runtime=True)
               for mode in ("success", "lost_intent", "revoked", "lost_start", "lost_final")]
    bundle = ExportBundleRuntimeTests("test_actual_zip_child_streams_frozen_inputs_after_real_start_and_commits_measured_archive")
    bundles = [await bundle.operation(lost_ack=value, fingerprint=fingerprint, enforce_runtime=True) for value in (False, True)]
    return {"profile": "lean", "toolchainFingerprint": fingerprint, "dubbing": dubbing, "bundles": bundles,
            "externalProviderRequests": 0, "databaseRequests": 0}


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
    from narriflow_media.fetch import SourceFetchFailure
    async def run(session, package, work):
        if package.command.get("kind") == "youtube_source" and os.environ["YOUTUBE_FETCH_MODE"] != "proxy":
            raise SourceFetchFailure("source_fetch_mode_forbidden")
        await run_fetch_source(session, package, work, mode="proxy", development=False,
            token_server_home=Path("/opt/youtube-tokens"), proxy_template=os.environ.get("YTDLP_PROXY_URL"))
    return await invoke_native(invocation, "fetch_source", client=native_client(os.environ),
                               operation=run, max_operation_seconds=2700)


@app.function(image=lean_image, secrets=[executor_secret], timeout=2700,
              restrict_modal_access=True, **LEAN_RESOURCES)
async def pin_source(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.source_runtime import run_pin_source
    return await invoke_native(invocation, "pin_source", client=native_client(os.environ),
                               operation=run_pin_source, max_operation_seconds=2700)


# Every render group waits on one preparation, so preparation scales with rendering.
@app.function(image=render_image, secrets=[executor_secret], timeout=2700,
              max_containers=80, restrict_modal_access=True, **RENDER_RESOURCES)
async def prepare_clip(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.clip_preparation_runtime import run_prepare_clip
    return await invoke_native(invocation, "prepare_clip", client=native_client(os.environ),
                               operation=run_prepare_clip, max_operation_seconds=2700)


@app.function(image=render_image, secrets=[executor_secret], timeout=2700,
              max_containers=80, restrict_modal_access=True, **RENDER_RESOURCES)
async def render_group(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.render_runtime import run_render_group
    return await invoke_native(invocation, "render_group", client=native_client(os.environ),
                               operation=run_render_group, max_operation_seconds=2700)


@app.function(image=lean_image, secrets=[executor_secret], timeout=900,
              max_containers=32, restrict_modal_access=True, **LEAN_RESOURCES)
async def publication(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.publication_runtime import run_publication
    return await invoke_native(invocation, "publication", client=native_client(os.environ),
                               operation=run_publication, max_operation_seconds=900)


@app.function(image=lean_image, secrets=[executor_secret], timeout=2700,
              max_containers=8, restrict_modal_access=True, **LEAN_RESOURCES)
async def export_bundle(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.export_bundle_runtime import run_export_bundle
    return await invoke_native(invocation, "export_bundle", client=native_client(os.environ),
                               operation=run_export_bundle, max_operation_seconds=2700)


@app.function(image=lean_image, secrets=[executor_secret, dubbing_secret], timeout=2700,
              max_containers=8, restrict_modal_access=True, **LEAN_RESOURCES)
async def dub_mix(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.dubbing_runtime import run_dubbing
    async def run(session, package, work):
        return await run_dubbing(session, package, work, api_key=os.environ["OPENAI_API_KEY"])
    return await invoke_native(invocation, "dub_mix", client=native_client(os.environ),
                               operation=run, max_operation_seconds=2700)


@app.function(image=lean_image, secrets=[executor_secret, image_secret], timeout=600,
              restrict_modal_access=True, **LEAN_RESOURCES)
async def generated_image(invocation: dict) -> dict:
    from narriflow_media.entrypoint import invoke_native, native_client
    from narriflow_media.native_runtime import run_generated_image
    async def run(session, package, work):
        await run_generated_image(session, package, work,
            api_key=os.environ["OPENAI_API_KEY"] if package.command.get("mode") == "generate" else None)
    return await invoke_native(invocation, "generated_image", client=native_client(os.environ),
                               operation=run, max_operation_seconds=600)


@app.function(image=lean_image, secrets=[bridge_secret], timeout=30, **BRIDGE_RESOURCES)
@modal.concurrent(max_inputs=BRIDGE_MAX_INPUTS)
@modal.asgi_app(label="narriflow-media-dev-bridge")
def dispatch_bridge():
    from narriflow_media.bridge import BridgeAsgiApp, ModalBridge
    from narriflow_media.bridge_runtime import ModalBackend, ModalDictStore, parse_bridge_keys
    bridge = ModalBridge(store=ModalDictStore(dispatch_receipts),
        backend=ModalBackend(modal, {"asset_validation": asset_validation, "outbound_delivery": outbound_delivery, "fetch_source": fetch_source, "pin_source": pin_source, "prepare_clip": prepare_clip, "render_group": render_group, "publication": publication, "export_bundle": export_bundle, "dub_mix": dub_mix, "generated_image": generated_image}),
        key_ring=parse_bridge_keys(os.environ["MODAL_BRIDGE_KEYS_JSON"]))
    return BridgeAsgiApp(bridge, time.time)
