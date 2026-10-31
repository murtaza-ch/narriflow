"""One laptop invocation over outbound signed control. No inbound listener or DB."""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
import sys

from .control import ExecutionControlClient, ExecutionControlError
from .entrypoint import invoke_native
from .source_runtime import run_fetch_source
from .process import run_owned_process


async def run(value: object) -> dict:
    if type(value) is not dict or set(value) != {'configuration', 'invocation'}:
        raise ExecutionControlError('execution_configuration_invalid')
    configuration = value['configuration']
    if type(configuration) is not dict or set(configuration) != {'version', 'apiOrigin', 'sessionToken', 'keyId', 'key', 'workspaceId', 'expiresAt', 'toolchainFingerprint'} or configuration['version'] != 1:
        raise ExecutionControlError('execution_configuration_invalid')
    try:
        key = base64.urlsafe_b64decode(configuration['key'] + '=' * (-len(configuration['key']) % 4))
        client = ExecutionControlClient(origin=configuration['apiOrigin'], key_id=configuration['keyId'], key=key,
                                        device_session_token=configuration['sessionToken'])
    except (ValueError, KeyError, TypeError):
        raise ExecutionControlError('execution_configuration_invalid') from None

    async def operation(session, package, work):
        await run_fetch_source(session, package, work, mode='local', development=True,
                               token_server_home=Path('/opt/youtube-tokens'))

    return await invoke_native(value['invocation'], 'fetch_source', client=client, operation=operation,
                               max_operation_seconds=2700, reference_kind='local_fetch')


def main():
    try:
        if sys.argv[1:] == ['--verify-runtime']:
            result = run_owned_process(['bun', str(Path(__file__).resolve().parents[2] / 'scripts/check-render-environment.ts'),
                                        '--enforce', '--stage', 'start', '--json', '--profile', 'lean'], timeout_seconds=60)
            if result.returncode:
                raise ValueError()
            sys.stdout.write(json.dumps({'fingerprint': json.loads(result.stdout)['id']}) + '\n')
            return
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        result = asyncio.run(run(json.loads(raw)))
        sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
    except (ValueError, TypeError, KeyError, ExecutionControlError):
        sys.stderr.write('local_fetch_invocation_refused\n')
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
