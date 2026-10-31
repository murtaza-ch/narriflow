from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import tempfile
import unittest

from narriflow_media.process import MAX_OUTPUT_BYTES, run_owned_process


class OwnedProcessTests(unittest.TestCase):
    def test_transfers_bounded_input_and_binary_output(self):
        result = run_owned_process(
            [sys.executable, "-c", "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read()[::-1])"],
            input_bytes=b"\x00example\xff", timeout_seconds=2, kill_grace_seconds=0.1,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"\xffelpmaxe\x00")
        self.assertEqual(result.stderr, b"")

    def test_deadline_kills_a_detached_native_descendant(self):
        code = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],start_new_session=True);print(p.pid,flush=True);time.sleep(60)"
        result = run_owned_process([sys.executable, "-c", code], timeout_seconds=0.5, kill_grace_seconds=0.1)
        self.assertEqual(result.returncode, 124)
        self.assertTrue(result.stdout.strip().isdigit())
        self.assert_pid_stopped(int(result.stdout.strip()))


    def test_killed_wrapper_cannot_leave_detached_media_running(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "native.pid"
            native = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"
            launcher = f"import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c',{native!r}],start_new_session=True);Path({str(pid_file)!r}).write_text(str(p.pid));time.sleep(60)"
            wrapper_code = f"from narriflow_media.process import run_owned_process;run_owned_process({[sys.executable, '-c', launcher]!r},timeout_seconds=60,kill_grace_seconds=0.1)"
            wrapper = subprocess.Popen([sys.executable, "-c", wrapper_code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                until = time.monotonic() + 3
                while not pid_file.exists() and time.monotonic() < until:
                    time.sleep(0.025)
                self.assertTrue(pid_file.exists(), "native child never started")
                native_pid = int(pid_file.read_text())
                # Allow one supervisor sample to record a detached descendant
                # on macOS; Linux also adopts it through PR_SET_CHILD_SUBREAPER.
                time.sleep(0.2)
                wrapper.kill()
                wrapper.wait(timeout=2)
                self.assert_pid_stopped(native_pid)
            finally:
                if wrapper.poll() is None:
                    wrapper.kill()
                    wrapper.wait()


    def test_unbounded_child_output_is_stopped_at_the_protocol_limit(self):
        result = run_owned_process(
            [sys.executable, "-c", "import sys,time;sys.stdout.buffer.write(b'x'*(2*1024*1024));sys.stdout.flush();time.sleep(60)"],
            timeout_seconds=3, kill_grace_seconds=0.1,
        )
        self.assertEqual(result.returncode, 70)
        self.assertEqual(len(result.stdout), MAX_OUTPUT_BYTES)


    def test_native_children_never_inherit_database_credentials(self):
        environment = dict(os.environ, DATABASE_URL="private-database", DIRECT_URL="private-migration", PGPASSWORD="private-password", MEDIA_TEST_VALUE="kept")
        result = run_owned_process(
            [sys.executable, "-c", "import os,json;print(json.dumps({k:os.environ.get(k) for k in ['DATABASE_URL','DIRECT_URL','PGPASSWORD','MEDIA_TEST_VALUE']}))"],
            timeout_seconds=2, kill_grace_seconds=0.1, env=environment,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), b'{"DATABASE_URL": null, "DIRECT_URL": null, "PGPASSWORD": null, "MEDIA_TEST_VALUE": "kept"}')

    def assert_pid_stopped(self, pid: int):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True).stdout.strip()
            if not state or state.startswith(b"Z"):
                return
            time.sleep(0.025)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.fail("native descendant survived its owner")


if __name__ == "__main__":
    unittest.main()
