"""Linux tmpfs ENOSPC gate. Pass an empty bounded tmpfs directory explicitly."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from narriflow_media.process import run_owned_process


def main() -> None:
    target = Path(sys.argv[1]).resolve()
    if sys.platform != 'linux' or not target.is_dir() or any(target.iterdir()):
        raise RuntimeError('empty_bounded_linux_tmpfs_required')
    capacity = os.statvfs(target).f_blocks * os.statvfs(target).f_frsize
    if not 0 < capacity <= 16 * 1024**2:
        raise RuntimeError('bounded_tmpfs_required')
    mounts = [line.split() for line in Path('/proc/mounts').read_text().splitlines()]
    if not any(row[1] == str(target) and row[2] == 'tmpfs' for row in mounts):
        raise RuntimeError('bounded_tmpfs_required')
    starts = []
    def on_start(pid):
        os.kill(pid, 0)
        starts.append(pid)
    program = '''import errno,json,sys
try:
 with open(sys.argv[1],'xb',buffering=0) as output:
  while True:output.write(b'x'*65536)
except OSError as error:
 if error.errno!=errno.ENOSPC:raise
 print(json.dumps({'code':'ENOSPC'}),flush=True)
 sys.exit(228)
'''
    result = run_owned_process([sys.executable, '-c', program, str(target / 'output.bin')],
                               timeout_seconds=10, kill_grace_seconds=0.1,
                               on_start=on_start, max_file_bytes=32 * 1024**2)
    assert len(starts) == 1
    assert result.returncode == 228
    assert json.loads(result.stdout) == {'code': 'ENOSPC'}
    assert not result.stderr
    assert (target / 'output.bin').stat().st_size <= capacity
    print(json.dumps({'scope': 'actual Linux kernel ENOSPC through the current native supervisor, no domain/storage fixture',
                      'nativeStarts': len(starts), 'returncode': result.returncode, 'code': 'ENOSPC',
                      'tmpfsCapacityBytes': capacity, 'fileBytes': (target / 'output.bin').stat().st_size}))


if __name__ == '__main__':
    main()
