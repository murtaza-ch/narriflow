"""The same source fetch operation for a local device or the proxy executor."""
from __future__ import annotations

import json
from pathlib import Path

from .control import ExecutorSession
from .fetch import ExistingSourceAudio, SourceFetchFailure, configured_proxy_routes, fetch_source
from .fetch_runtime import YtDlpSourceRuntime
from .file_source_runtime import NativeFileRuntime, publish_original, run_direct_source
from .youtube_download_service import RESOLVE_SECONDS, curl_request, resolve_service_download
from .manifest import YouTubeSource
from .process import run_owned_process_async, verified_runtime_id
from .source_sink import ScopedSourceSink, _environment
from .transfer import WorkPackage


async def verify_source_runtime(session, *, bun_executable="bun"):
    verified = verified_runtime_id()
    if verified is not None:
        return verified
    # Bounded startup verification precedes actual source work. A rejected image
    # starts no media operation and therefore spends no domain attempt.
    report = await run_owned_process_async([bun_executable,
        str(Path(__file__).resolve().parents[2] / "scripts/check-render-environment.ts"),
        "--enforce", "--stage", "start", "--json", "--profile", "lean"],
        timeout_seconds=min(60, session.remaining_seconds), env=_environment(), cancel_event=session.cancel_event)
    session.assert_live()
    try:
        if report.returncode:
            raise ValueError()
        return json.loads(report.stdout)["id"]
    except (ValueError, KeyError, UnicodeError):
        raise SourceFetchFailure("source_runtime_invalid", True) from None


async def run_fetch_source(session: ExecutorSession, package: WorkPackage, work: Path, *, mode: str,
                           development: bool, token_server_home: Path, proxy_template: str | None = None,
                           static_proxy_urls: str | None = None, download_service_token: str | None = None,
                           bun_executable="bun", runtime_class=YtDlpSourceRuntime, sink_class=ScopedSourceSink,
                           verify_runtime=verify_source_runtime, fetch=fetch_source,direct_operation=run_direct_source,
                           service_operation=None):
    service_operation = service_operation if service_operation is not None else run_service_youtube_source
    session.assert_live()
    package.assert_session(session)
    command = package.command
    if package.function_name != "fetch_source":raise SourceFetchFailure("source_runtime_invalid")
    if command.get("kind")=="source_refusal":
        if (set(command)!={"kind","failureCode","retryable"} or type(command.get("retryable")) is not bool
                or command.get("failureCode") not in {"drive_token_expired","drive_file_unavailable","zoom_recording_unavailable","zoom_connection_unavailable","worker_invalid_payload","source_download_failed","link_unsupported_source"}):
            raise SourceFetchFailure("source_runtime_invalid")
        raise SourceFetchFailure(command["failureCode"],command["retryable"])
    if command.get("kind") not in {"youtube_source","direct_source"} or command.get("audioPolicy") not in {"required","none","pending_pack"}:
        raise SourceFetchFailure("source_runtime_invalid")
    if command["kind"]=="youtube_source" and (mode not in {"local", "proxy"} or mode == "local" and not development):
        raise SourceFetchFailure("source_fetch_mode_forbidden")
    service = command["kind"]=="youtube_source" and mode == "proxy" and bool(download_service_token)
    if command["kind"]=="youtube_source" and mode == "proxy" and not service:
        # A missing or malformed proxy secret fails before any native preflight.
        configured_proxy_routes(static_urls=static_proxy_urls, rotating_template=proxy_template)
    if command["kind"]=="youtube_source" and (type(command.get("maxSourceSeconds")) is not int or command["maxSourceSeconds"]<=0):
        raise SourceFetchFailure("source_runtime_invalid")
    fingerprint = await verify_runtime(session, bun_executable=bun_executable)
    if fingerprint != command.get("toolchainFingerprint"):
        raise SourceFetchFailure("source_runtime_invalid", True)
    if command["kind"]=="direct_source":
        await direct_operation(session,package,work,bun_executable=bun_executable,sink_class=sink_class)
        return
    if service:
        await service_operation(session,package,work,token=download_service_token,bun_executable=bun_executable,sink_class=sink_class)
        return
    sink = sink_class(session, package, work, bun_executable=bun_executable)
    existing = ExistingSourceAudio(command["existingSourceAudio"]) if command["existingSourceAudio"] else None
    class SourceRuntime(runtime_class):
        async def resolve(self, source, proxy, directory):
            selected = await super().resolve(source, proxy, directory)
            # Metadata extraction is a real charged process. A reused Source
            # Audio can now receive its optional same-owner probe assignment.
            if existing is not None:
                await sink.refresh_optional_probe()
            return selected
    runtime = SourceRuntime(token_server_home=token_server_home, on_process_start=session.on_process_start,
        deadline_seconds=min(2700, session.remaining_seconds), bun_executable=bun_executable,
        cancel_event=session.cancel_event, assert_owned=session.assert_live, max_source_seconds=command["maxSourceSeconds"])
    await fetch(YouTubeSource(command["mediaId"]), source_revision=command["sourceRevision"], mode=mode,
        development=development, work_directory=work, runtime=runtime, sink=sink,
        toolchain_fingerprint=fingerprint, proxy_template=proxy_template, static_proxy_urls=static_proxy_urls,
        deadline_seconds=min(2700, session.remaining_seconds), existing_audio=existing, project_id=command["projectId"], acquire_audio=command["audioPolicy"]!="none")


async def run_service_youtube_source(session: ExecutorSession, package: WorkPackage, work: Path, *, token: str,
                                     bun_executable="bun", sink_class=ScopedSourceSink, resolve=None, runtime=None):
    """A YouTube original through the download service, then the direct-original path:
    one download, probe, hash, audio extracted from that same file, publish."""
    command, cap = package.command, package.command["maxSourceSeconds"]
    session.assert_live()
    request = curl_request(work=work, on_start=session.on_process_start, cancel_event=session.cancel_event)
    resolved = await (resolve or resolve_service_download)(token, command["mediaId"],
        timeout=min(RESOLVE_SECONDS, max(1, session.remaining_seconds - 60)), request=request)
    session.assert_live()
    # Refuse an over-cap video before paying for its transfer when the service
    # reports a duration; the measured probe below enforces it either way.
    if resolved.duration_seconds is not None and resolved.duration_seconds > cap:
        raise SourceFetchFailure("ingest_max_duration_exceeded")
    runtime = runtime if runtime is not None else NativeFileRuntime(session, bun_executable=bun_executable)
    sink = sink_class(session, package, work, bun_executable=bun_executable)
    try:
        # The link allows three opens: one transfer attempt, and a failed transfer
        # is retryable so the operation's retry resolves a fresh link.
        path, content_type = await runtime.download({"provider": "direct", "url": resolved.url, "authorization": None}, work, attempts=1)
    except SourceFetchFailure as error:
        if error.code in {"source_download_failed", "remote_download_failed", "remote_fetch_timeout"}:
            raise SourceFetchFailure("source_download_failed", True) from None
        raise
    # The service delivers fragmented MP4; renders need the index first.
    path = await runtime.remux_faststart(path, work)
    await publish_original(session, package, work, path, "video/mp4", runtime=runtime, sink=sink, max_source_seconds=cap)


async def run_pin_source(session: ExecutorSession,package:WorkPackage,work:Path,*,bun_executable='bun',
                         verify_runtime=verify_source_runtime,pin_operation=None):
    from .pin_source_runtime import run_upload_pin
    session.assert_live();package.assert_session(session);command=package.command
    if package.function_name!='pin_source' or command.get('kind')!='upload_source':
        raise SourceFetchFailure('source_runtime_invalid')
    fingerprint=await verify_runtime(session,bun_executable=bun_executable)
    if fingerprint!=command.get('toolchainFingerprint'):raise SourceFetchFailure('source_runtime_invalid',True)
    await (pin_operation if pin_operation is not None else run_upload_pin)(session,package,work,bun_executable=bun_executable)
