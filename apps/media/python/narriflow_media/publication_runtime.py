"""Bounded publication subprocess, with Python retaining signed control custody."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import stat
from threading import Lock, Thread
from uuid import UUID

from .artifacts import AssignedArtifacts
from .control import ExecutionControlError, ExecutorSession
from .process import MediaProcessError, run_owned_process_async
from .transfer import WorkPackage


class PublicationFailure(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _environment():
    result = {name: os.environ[name] for name in (
        'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    ) if name in os.environ}
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
        result[name] = ''
    return result


def validate_publication_package(session: ExecutorSession, package: WorkPackage) -> dict:
    package.assert_session(session)
    command, context, fence = package.command, package.publication, session.fence
    try:
        reference, scope = fence['reference'], command['scope']
        if (package.function_name != 'publication' or command.get('kind') != 'publication' or command.get('version') != 1 or
                reference['subject']['kind'] != 'social_publication' or
                scope['bindingHash'] != package.input_hash or package.input_hash != reference['inputHash'] or
                scope['socialPostId'] != reference['subject']['id'] or scope['deploymentEpoch'] != reference['deploymentEpoch'] or
                scope['claimId'] != fence['attemptToken'] or not context or context['inputKey']['scope'] != scope or
                context['checkpointKey']['scope'] != scope):
            raise ValueError()
        prior = context.get('priorCheckpointKey')
        if prior and any(prior['scope'][name] != scope[name] for name in ('socialPostId','attemptId','deploymentEpoch')):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise PublicationFailure('publication_work_package_mismatch') from None
    return command


async def run_publication(session: ExecutorSession, package: WorkPackage, work: Path, *,
                          media_path: Path, thumbnail_path: Path | None = None,
                          instructions_path: Path | None = None, bun_executable: str = 'bun',
                          upload_transport=None, cli_path: Path | None = None) -> dict:
    validate_publication_package(session, package)
    if work.is_symlink() or not work.is_dir():
        raise PublicationFailure('publication_command_invalid')
    context = package.publication
    if not context:
        raise PublicationFailure('publication_command_invalid')
    root = work.resolve()
    for path in (media_path, thumbnail_path, instructions_path):
        if path is not None and (path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root)):
            raise PublicationFailure('publication_source_invalid')
    outputs = [output for output in package.outputs if output['role'] == 'publication_checkpoint']
    if len(outputs) > 1 or len(outputs) != len(package.outputs):
        raise PublicationFailure('publication_assignment_invalid')
    artifacts = AssignedArtifacts(session, package)
    loop, token, cache, lock = asyncio.get_running_loop(), secrets.token_hex(32), {}, Lock()
    pending_uploads = []
    settled = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *_):
            pass
        def do_POST(self):
            try:
                if (self.path not in {'/command', '/instructions'} or
                        not hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {token}') or
                        self.headers.get('Transfer-Encoding') is not None or self.headers.get('Content-Type') != 'application/json'):
                    raise ValueError()
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 65536:
                    raise ValueError()
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError()
                value = json.loads(body)
                identity = value.get('requestId')
                if not isinstance(identity, str) or str(UUID(identity)) != identity:
                    raise ValueError()
                fingerprint = hashlib.sha256(self.path.encode() + b'\0' + body).hexdigest()
                with lock:
                    prior = cache.get(identity)
                    if prior:
                        if prior[0] != fingerprint:
                            raise ValueError()
                        result = prior[1]
                    else:
                        if len(cache) >= 512:
                            raise ValueError()
                        session.assert_live()
                        if self.path == '/command':
                            if set(value) != {'requestId', 'command'} or not isinstance(value['command'], dict):
                                raise ValueError()
                            result = dict(session.command('publication-command', command=value['command']).disposition)
                            if result.get('disposition') == 'publication_recorded' and result.get('result', {}).get('kind') == 'settled':
                                settled.append(result['result'])
                        else:
                            if set(value) != {'requestId', 'path', 'sha256', 'byteLength'} or len(outputs) != 1:
                                raise ValueError()
                            path = Path(value['path'])
                            if path.is_symlink() or not path.resolve().is_relative_to(root):
                                raise ValueError()
                            facts = path.lstat()
                            if (not stat.S_ISREG(facts.st_mode) or type(value['byteLength']) is not int or
                                    not 0 < facts.st_size == value['byteLength'] <= 16 * 1024**2 or
                                    len(value['sha256']) != 64):
                                raise ValueError()
                            digest = hashlib.sha256()
                            with path.open('rb') as source:
                                while part := source.read(65536):
                                    session.assert_live()
                                    digest.update(part)
                            if digest.hexdigest() != value['sha256']:
                                raise ValueError()
                            future = asyncio.run_coroutine_threadsafe(artifacts.upload(outputs[0]['artifactId'], path,
                                content_type='application/octet-stream', byte_length=facts.st_size, sha256=value['sha256'],
                                transport=upload_transport), loop)
                            pending_uploads.append(future)
                            try:
                                future.result(timeout=min(120, session.remaining_seconds))
                            except BaseException:
                                future.cancel()
                                raise
                            result = {'artifactId': outputs[0]['artifactId']}
                        cache[identity] = (fingerprint, result)
                encoded = json.dumps(result, separators=(',', ':'), allow_nan=False).encode()
                if len(encoded) > 65536:
                    raise ValueError()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(encoded)
            except BaseException:
                encoded = b'{"error":"publication_control_unconfirmed"}'
                try:
                    self.send_response(403)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                except OSError:
                    pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    invocation = {'work': str(root), 'envelope': package.command, 'context': context, 'mediaPath': str(media_path),
                  'control': {'origin': f'http://127.0.0.1:{server.server_port}', 'token': token}}
    if thumbnail_path is not None:
        invocation['thumbnailPath'] = str(thumbnail_path)
    if instructions_path is not None:
        invocation['priorInstructionsPath'] = str(instructions_path)
    path = root / 'publication-invocation.json'
    try:
        body = json.dumps(invocation, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
        if len(body) > 17 * 1024**2:
            raise PublicationFailure('publication_command_invalid')
        with path.open('xb') as target:
            target.write(body)
        path.chmod(0o400)
        result = await run_owned_process_async([bun_executable, str(cli_path if cli_path is not None else Path(__file__).resolve().parents[2] / 'src/publication-cli.ts')],
            input_bytes=json.dumps({'work':str(root), 'invocationPath':str(path)}, separators=(',', ':')).encode(),
            timeout_seconds=min(300, session.remaining_seconds), kill_grace_seconds=5, env=_environment(),
            on_start=session.on_process_start, cancel_event=session.cancel_event)
        if session.cancel_event.is_set():
            raise MediaProcessError('media_execution_cancelled')
        if result.returncode or json.loads(result.stdout) != {'completed': True} or len(settled) != 1:
            raise PublicationFailure('publication_execution_unconfirmed')
        return settled[0]
    finally:
        for future in pending_uploads:
            if not future.done():
                future.cancel()
        if pending_uploads:
            await asyncio.gather(*(asyncio.wrap_future(future) for future in pending_uploads), return_exceptions=True)
        await asyncio.to_thread(server.shutdown)
        server.server_close()
        thread.join(timeout=2)
        # The only ephemeral file containing provider access is never retained
        # beyond this invocation, even when the final receipt acknowledgement is lost.
        path.unlink(missing_ok=True)
