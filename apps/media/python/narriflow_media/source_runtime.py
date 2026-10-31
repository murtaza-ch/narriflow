"""The same source fetch operation for a local device or the proxy executor."""
from __future__ import annotations

import json
from pathlib import Path

from .control import ExecutorSession
from .fetch import ExistingSourceAudio, SourceFetchFailure, fetch_source
from .fetch_runtime import YtDlpSourceRuntime
from .manifest import YouTubeSource
from .process import run_owned_process_async
from .source_sink import ScopedSourceSink, _environment
from .transfer import WorkPackage


async def verify_source_runtime(session, *, bun_executable="bun"):
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
                           bun_executable="bun", runtime_class=YtDlpSourceRuntime, sink_class=ScopedSourceSink,
                           verify_runtime=verify_source_runtime, fetch=fetch_source):
    session.assert_live()
    if mode not in {"local", "proxy"} or mode == "local" and not development or mode == "proxy" and not proxy_template:
        raise SourceFetchFailure("source_fetch_mode_forbidden")
    package.assert_session(session)
    command = package.command
    if package.function_name != "fetch_source" or command.get("kind") != "youtube_source":
        raise SourceFetchFailure("source_runtime_invalid")
    fingerprint = await verify_runtime(session, bun_executable=bun_executable)
    if fingerprint != command.get("toolchainFingerprint"):
        raise SourceFetchFailure("source_runtime_invalid", True)
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
        cancel_event=session.cancel_event, assert_owned=session.assert_live)
    await fetch(YouTubeSource(command["mediaId"]), source_revision=command["sourceRevision"], mode=mode,
        development=development, work_directory=work, runtime=runtime, sink=sink,
        toolchain_fingerprint=fingerprint, proxy_template=proxy_template,
        deadline_seconds=min(2700, session.remaining_seconds), existing_audio=existing, project_id=command["projectId"])
