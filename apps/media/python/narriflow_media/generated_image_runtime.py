"""One bounded native image operation. Assignment upload remains caller-owned."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import stat
from threading import Event
from typing import Callable

from .process import run_owned_process_async


class GeneratedImageFailure(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class GeneratedImageFiles:
    image_path: Path | None
    evidence_path: Path
    evidence: dict


async def run_generated_image(command: dict, work: Path, *, binary_artifact_id: str,
                              on_process_start: Callable[[int], None], cancel_event: Event,
                              api_key: str | None = None, source_path: Path | None = None,
                              bun_executable: str = "bun") -> GeneratedImageFiles:
    if (type(command) is not dict or command.get("kind") != "generated_image" or
            command.get("mode") not in {"generate", "recover"} or type(command.get("maxOutputBytes")) is not int or
            not 1000000 <= command["maxOutputBytes"] <= 100000000 or work.is_symlink() or not work.is_dir()):
        raise GeneratedImageFailure("generated_image_command_invalid")
    directory = work.resolve()
    image, proof, command_path = (directory / name for name in ("generated-validated.png", "generated-evidence.json", "generated-command.json"))
    try:
        # The existing supervisor's control stdin stays <=64KiB. Unicode prompt
        # bytes are a verified local file; no secret or URL grant goes in it.
        body = json.dumps(command, separators=(",", ":"), allow_nan=False).encode()
        if not 0 < len(body) <= 256 * 1024:
            raise ValueError()
        with command_path.open("xb") as output:
            output.write(body)
        command_path.chmod(0o400)
    except (OSError, ValueError, TypeError):
        raise GeneratedImageFailure("generated_image_command_invalid") from None
    environment = {name: os.environ[name] for name in (
        "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SSL_CERT_FILE", "SSL_CERT_DIR",
        "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "ORT_INTRA_OP_NUM_THREADS",
    ) if name in os.environ}
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"):
        environment[name] = ""
    if command["mode"] == "generate" and api_key is not None:
        environment["OPENAI_API_KEY"] = api_key
    invocation = {"commandPath": str(command_path), "work": str(directory), "outputPath": str(image),
                  "evidencePath": str(proof), "binaryArtifactId": binary_artifact_id}
    if source_path is not None:
        invocation["sourcePath"] = str(source_path)
    result = await run_owned_process_async(
        [bun_executable, str(Path(__file__).resolve().parents[2] / "src/generated-image-cli.ts")],
        input_bytes=json.dumps(invocation, separators=(",", ":")).encode(),
        timeout_seconds=250, kill_grace_seconds=5, max_file_bytes=command["maxOutputBytes"], env=environment,
        on_start=on_process_start, cancel_event=cancel_event,
    )
    if result.returncode:
        raise GeneratedImageFailure("generated_image_execution_unconfirmed")
    try:
        if json.loads(result.stdout) != {"completed": True}:
            raise ValueError()
        facts = proof.lstat()
        if not stat.S_ISREG(facts.st_mode) or not 0 < facts.st_size <= 65536:
            raise ValueError()
        with proof.open("rb") as source:
            evidence = json.loads(source.read(65537))
        if (not isinstance(evidence, dict) or evidence.get("kind") != "generated_image" or
                any(evidence.get(name) != command[name] for name in ("jobId", "requestId", "inputHash")) or
                evidence.get("outcome") not in {"completed", "failed", "rejected", "unknown"}):
            raise ValueError()
        if evidence["outcome"] == "completed":
            facts = image.lstat()
            if (not stat.S_ISREG(facts.st_mode) or not 0 < facts.st_size <= command["maxOutputBytes"] or
                    evidence.get("binaryArtifactId") != binary_artifact_id):
                raise ValueError()
            image.chmod(0o400)
        proof.chmod(0o400)
    except (OSError, ValueError, TypeError, KeyError):
        raise GeneratedImageFailure("generated_image_evidence_invalid") from None
    return GeneratedImageFiles(image if evidence["outcome"] == "completed" else None, proof, evidence)
